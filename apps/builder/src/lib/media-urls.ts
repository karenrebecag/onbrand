// `<img src>` no manda Bearer: las capturas de los pasos y las imágenes del lienzo se piden firmadas con POST media-urls
// (docs/spec/orquestador-enrutamiento.md §4), como v0 sirve sus imágenes con URLs firmadas en otro dominio
// (~/v0-fe-capture/HALLAZGOS-frontend-v0.md:123). El token vive 5 min: se pide en lotes de hasta 50 rutas y se renueva antes de
// `expiresAt`, para que un repintado no ponga una URL vencida. En local el Runtime devuelve la ruta sin firmar (chat-alias.ts).

import { useEffect, useMemo, useReducer, useState } from 'react'
import { chatRoutes, type ChatBase } from './chat-routes'
import { apiFetch } from './session-provider'

/** §4: tope de rutas por pedido. */
export const MEDIA_BATCH = 50
/** Se renueva este tiempo antes de que venza, para que la URL nueva llegue antes de que la vieja deje de abrir. */
export const RENEW_BEFORE_MS = 30_000
/** Si la firma falla se usa la ruta sin token (en local abre; detrás del orquestador el `<img>` falla solo) y se reintenta a este plazo. */
const RETRY_MS = 60_000

export interface Signed { urls: Record<string, string>; expiresAt: number }

export interface MediaUrlsDeps {
  base: ChatBase
  sign: (paths: string[]) => Promise<Signed>
  onChange: () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export interface MediaUrls {
  /** La URL firmada vigente, o undefined mientras se pide. Pedirla la encola si falta o está por vencer. */
  url: (path: string) => string | undefined
  /** Lo mismo, esperando la firma (p. ej. para medir una imagen recién subida). */
  get: (path: string) => Promise<string>
  dispose: () => void
}

/** Solo una URL relativa a la base que empiece por la ruta pedida: el valor viene del servidor y va a un `src`. */
const validFor = (path: string, value: unknown): value is string =>
  typeof value === 'string' && (value === path || value.startsWith(`${path}?`))

export function createMediaUrls(deps: MediaUrlsDeps): MediaUrls {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let cache = new Map<string, { url: string; expiresAt: number }>()
  let queued = new Set<string>()
  let inFlight = new Set<string>()
  let waiters = new Map<string, ((url: string) => void)[]>()
  let flushing = false
  let disposed = false
  const timers = new Set<unknown>()

  const store = (path: string, url: string, expiresAt: number) => {
    cache = new Map(cache).set(path, { url, expiresAt })
    for (const w of waiters.get(path) ?? []) w(url)
    const next = new Map(waiters)
    next.delete(path)
    waiters = next
  }

  const schedule = (paths: string[], at: number) => {
    const t = setTimer(() => {
      timers.delete(t)
      if (!disposed) enqueue(paths)
    }, Math.max(0, at - now()))
    timers.add(t)
  }

  const send = async (paths: string[]) => {
    try {
      const signed = await deps.sign(paths)
      if (disposed) return
      for (const p of paths) store(p, `${deps.base}/${validFor(p, signed.urls[p]) ? signed.urls[p] : p}`, signed.expiresAt)
      schedule(paths, signed.expiresAt - RENEW_BEFORE_MS)
    } catch {
      if (disposed) return
      for (const p of paths) store(p, `${deps.base}/${p}`, now() + RETRY_MS)
      schedule(paths, now() + RETRY_MS)
    } finally {
      inFlight = new Set([...inFlight].filter((p) => !paths.includes(p)))
    }
    if (!disposed) deps.onChange()
  }

  const flush = () => {
    flushing = false
    if (disposed) return
    const paths = [...queued]
    queued = new Set()
    inFlight = new Set([...inFlight, ...paths])
    for (let i = 0; i < paths.length; i += MEDIA_BATCH) void send(paths.slice(i, i + MEDIA_BATCH))
  }

  // Los `url()` de un mismo render salen en un solo pedido: se juntan hasta el próximo microtask.
  function enqueue(paths: string[]) {
    const fresh = paths.filter((p) => !inFlight.has(p))
    if (!fresh.length) return
    queued = new Set([...queued, ...fresh])
    if (!flushing) {
      flushing = true
      queueMicrotask(flush)
    }
  }

  const url = (path: string): string | undefined => {
    const hit = cache.get(path)
    if (!hit || hit.expiresAt - now() <= RENEW_BEFORE_MS) enqueue([path])
    return hit && hit.expiresAt > now() ? hit.url : undefined
  }

  return {
    url,
    get: (path) => {
      const ready = url(path)
      if (ready) return Promise.resolve(ready)
      return new Promise<string>((resolve) => { waiters = new Map(waiters).set(path, [...(waiters.get(path) ?? []), resolve]) })
    },
    dispose: () => {
      disposed = true
      for (const t of timers) clearTimer(t)
      timers.clear()
    },
  }
}

export async function signMedia(base: ChatBase, paths: string[]): Promise<Signed> {
  const res = await apiFetch(chatRoutes.mediaUrls(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) })
  if (!res.ok) throw new Error(`media-urls respondió ${res.status}`)
  const body = (await res.json()) as Partial<Signed>
  if (typeof body.urls !== 'object' || body.urls === null || typeof body.expiresAt !== 'number') throw new Error('media-urls sin urls o sin expiresAt')
  return { urls: body.urls, expiresAt: body.expiresAt }
}

/** Una instancia por chat. Cada firma que llega cambia la identidad del objeto devuelto, para que los useCallback que lo
 * usan se rehagan y el `src` nuevo llegue a componentes memoizados. Sin base (sin transport o sin chat), undefined. */
export function useMediaUrls(base: ChatBase | undefined): MediaUrls | undefined {
  const [signed, bump] = useReducer((n: number) => n + 1, 0)
  // Creada en el efecto y no en un useMemo: StrictMode desmonta y vuelve a montar, y el cleanup dejaba disposed la misma
  // instancia memoizada; ninguna firma salía y `get` no resolvía (QA 2026-11-05: el lienzo no colocaba la imagen subida).
  const [media, setMedia] = useState<MediaUrls>()
  useEffect(() => {
    if (!base) { setMedia(undefined); return }
    const fresh = createMediaUrls({ base, sign: (paths) => signMedia(base, paths), onChange: bump })
    setMedia(fresh)
    return () => fresh.dispose()
  }, [base])
  return useMemo(() => (media ? { ...media, signed } : undefined), [media, signed])
}

/** La ruta de §4 de una captura de paso. */
export const shotPath = (messageId: string, file: string): string => `runs/${encodeURIComponent(messageId)}/shots/${encodeURIComponent(file)}`
