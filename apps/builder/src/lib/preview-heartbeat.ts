import { useCallback, useEffect, useRef, useState } from 'react'
import { previewHeartbeat, retryDelay, type PreviewState } from './run-client'
import type { ChatBase } from './chat-routes'
import { isAuthRejection } from './session'
import { createPreviewAccess } from './preview-access'

// Latido de v0 (vm/status con pageFocused y pageVisible, O/requests.ndjson): el transport mantiene vivo el preview de lo
// que la persona está mirando y desaloja el resto. Contrato con Secondary (R5): cada 5 s, solo con la pestaña visible y
// enfocada; la respuesta trae el estado de cada preview para enterarse de una caída sin un segundo pedido.
export const HEARTBEAT_MS = 5000

// Remontes seguidos por marco silencioso y por versión. Después no se corta: QA caso 5 (chat 9cbabeec) dejó el source y
// 38f87e66 en blanco 80 s con vite ya arriba, porque el vite bajo demanda tardó más que los 3 intentos y el tope era
// definitivo. Pasado el tope se sigue con el backoff de la reconexión (retryDelay, run-client; I18nStore :13547/:13880),
// que espacia hasta 30 s: un preview roto no entra en bucle y uno que tarda en subir se recupera solo.
export const MAX_SILENT_REMOUNTS = 3

/** Qué marcos remontar al llegar estados nuevos: el commit servido cambió (salvo de live a live), el preview volvió de absent, o el marco no
 * reportó en REPORT_WAIT_MS y el preview ya sirve (spec R4.6). Con la url estable el src no cambia, así que sin remontar
 * el iframe se queda con la página de carga ("Preparando preview" cargado antes del primer latido) o con la versión vieja.
 * `tries`: remontes por silencio ya hechos en la versión actual de cada preview; `last`: cuándo fue el último (ms). */
export function framesToRemount(prev: Record<string, PreviewState>, next: Record<string, PreviewState>, silent: ReadonlySet<string> = new Set(), tries: Readonly<Record<string, number>> = {}, last: Readonly<Record<string, number>> = {}, now = 0): string[] {
  const due = (id: string) => {
    const n = tries[id] ?? 0
    return n < MAX_SILENT_REMOUNTS || now - (last[id] ?? 0) >= retryDelay(n)
  }
  return Object.entries(next).flatMap(([id, now]) => {
    const was = prev[id]
    if (now.status === 'absent') return []
    // live → live: vite ya aplicó el cambio por HMR con estado; remontar recargaba la página y perdía scroll y selección (QA u3).
    if (was && (was.status === 'absent' || (was.version !== now.version && !(was.status === 'live' && now.status === 'live')))) return [id]
    return silent.has(id) && due(id) ? [id] : []
  })
}

const pageWatched = () => document.visibilityState === 'visible' && document.hasFocus()

/** `supported`: null hasta la primera respuesta, false si el transport no tiene el endpoint (404). `urls`: la url estable
 * de cada chat que la trajo; sin ella el builder sigue con la del log. `remounts` es un contador por chat para la key del iframe; `poke` adelanta un latido y, con un id, lo marca silencioso. */
export function usePreviewHeartbeat(base: ChatBase | undefined, ids: string[]) {
  const [supported, setSupported] = useState<boolean | null>(null)
  // Sin sesión o sin permiso, cada latido volvía 401/403 cada 5 s: se para para ese chat (otro chat vuelve a latir).
  const [rejectedApi, setRejectedApi] = useState<string | null>(null)
  const rejected = rejectedApi === base
  const [remounts, setRemounts] = useState<Record<string, number>>({})
  const [urls, setUrls] = useState<Record<string, string>>({})
  // El token del latido no es estado de React: no debe re-renderizar ni remontar nada; entra en el próximo montaje.
  const [access] = useState(createPreviewAccess)
  const states = useRef<Record<string, PreviewState>>({})
  // Marcos que no reportaron desde su último onLoad, y cuántas veces se los remontó por eso en la versión actual.
  const silent = useRef(new Set<string>())
  const tries = useRef<Record<string, number>>({})
  const lastAt = useRef<Record<string, number>>({})
  const idsRef = useRef(ids)
  idsRef.current = ids
  const key = ids.join('|')
  const beat = useRef<() => void>(() => {})

  useEffect(() => {
    if (!base || supported === false || rejected || !key) return
    const controller = new AbortController()
    let inFlight = false
    const run = () => {
      if (inFlight || !pageWatched()) return
      inFlight = true
      previewHeartbeat(base, idsRef.current, controller.signal)
        .then((next) => {
          setSupported(true)
          const now = Date.now()
          const remount = framesToRemount(states.current, next, silent.current, tries.current, lastAt.current, now)
          for (const id of remount) if (silent.current.has(id)) lastAt.current = { ...lastAt.current, [id]: now }
          tries.current = Object.fromEntries(Object.entries(next).flatMap(([id, s]) => {
            const was = states.current[id]
            const base = was && was.version !== s.version ? 0 : (tries.current[id] ?? 0)
            return [[id, remount.includes(id) && silent.current.has(id) ? base + 1 : base]]
          }))
          // Remontado, el marco vuelve a avisar si sigue sin reportar (onLoad → watchSilent).
          silent.current = new Set([...silent.current].filter((id) => !remount.includes(id)))
          states.current = { ...states.current, ...next }
          for (const [id, s] of Object.entries(next)) access.offer(id, s.previewToken)
          const fresh = Object.entries(next).flatMap(([id, s]) => (s.url ? [[id, s.url] as const] : []))
          if (fresh.length) setUrls((all) => (fresh.every(([id, u]) => all[id] === u) ? all : { ...all, ...Object.fromEntries(fresh) }))
          if (remount.length) setRemounts((all) => remount.reduce((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), all))
        })
        .catch((e: unknown) => {
          const status = (e as { status?: number }).status
          if (status === 404) setSupported(false)
          if (isAuthRejection(status)) setRejectedApi(base)
          // Otro fallo: el próximo latido reintenta; el preview no cambia por un latido perdido.
        })
        .finally(() => { inFlight = false })
    }
    beat.current = run
    run()
    const timer = window.setInterval(run, HEARTBEAT_MS)
    const onVisible = () => { if (pageWatched()) run() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [base, key, supported, rejected, access])

  // Un marco que no reportó pide un latido: si el preview ya sirve, ese latido lo remonta.
  const poke = useCallback((silentId?: string) => {
    if (silentId) silent.current = new Set([...silent.current, silentId])
    beat.current()
  }, [])
  return { supported, urls, remounts, poke, srcFor: access.srcFor, tokenFor: access.tokenFor }
}
