import { useEffect, useState } from 'react'
import { apiFetch } from './session-provider'

// Tope de gasto por dueño (orquestador, src/orchestrator/routes.ts GET /spend): USD del día UTC contra el tope de
// WT_OWNER_CAP_USD. El builder pinta lo que dice el server y nada más: sin respuesta válida no hay medidor, nunca una cifra
// supuesta. El fixture solo entra con VITE_SPEND_FIXTURE=1 (dev sin orquestador, capturas).

export interface Spend { spentUsd: number; capUsd: number; window: 'day' | 'total'; resetsAt?: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Cuerpo de GET /spend → Spend, o null si falta un número o no es finito: un medidor con NaN o negativo engaña. */
export function parseSpend(body: unknown): Spend | null {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (!finite(b.spentUsd) || !finite(b.capUsd)) return null
  const window = b.window === 'total' ? 'total' : 'day'
  return { spentUsd: b.spentUsd, capUsd: b.capUsd, window, ...(window === 'day' && finite(b.resetsAt) ? { resetsAt: b.resetsAt } : {}) }
}

export const SPEND_FIXTURE: Spend = { spentUsd: 1.24, capUsd: 5, window: 'day', resetsAt: Date.UTC(2026, 10, 6) }

const usd = (n: number): string => n.toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export interface SpendView { text: string; title: string; ratio: number; reached: boolean }

/** Lo que muestra el medidor. `reached`: el próximo pedido al modelo da 429 hasta resetsAt. */
export function spendView(s: Spend): SpendView {
  const reached = s.spentUsd >= s.capUsd
  const ratio = s.capUsd > 0 ? Math.min(1, s.spentUsd / s.capUsd) : 1
  const scope = s.window === 'day' ? 'hoy' : 'en total'
  const reset = s.resetsAt === undefined ? '' : ` Se reinicia el ${new Date(s.resetsAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}.`
  return reached
    ? { text: s.window === 'day' ? 'Tope diario alcanzado' : 'Tope de gasto alcanzado', title: `Gastaste ${usd(s.spentUsd)} de ${usd(s.capUsd)} USD ${scope}: el modelo no acepta más pedidos.${reset}`, ratio, reached }
    : { text: `${usd(s.spentUsd)} / ${usd(s.capUsd)} USD`, title: `Gastaste ${usd(s.spentUsd)} de ${usd(s.capUsd)} USD ${scope} en modelos, contra el tope del servidor.${reset}`, ratio, reached }
}

// Un 404 es "este server no tiene /spend" (el Runtime del core): no aparece a mitad de la sesión, así que no se vuelve a
// pedir en cada turno (QA: 404 repetidos en core). Un 5xx o un fallo de red sí se reintenta en el próximo turno.
const withoutSpend = new Set<string>()

/** GET /spend con la sesión del provider; null si el orquestador no lo sirve (404, runtime local) o responde algo raro. */
export async function fetchSpend(api: string, fetcher: (url: string) => Promise<Response> = apiFetch): Promise<Spend | null> {
  if (withoutSpend.has(api)) return null
  try {
    const res = await fetcher(`${api}/spend`)
    if (res.status === 404) withoutSpend.add(api)
    return res.ok ? parseSpend(await res.json()) : null
  } catch {
    return null
  }
}

/** Se relee al cambiar `key` (el último turno del hilo): el gasto solo se mueve cuando corre el modelo. */
export function useSpend(api: string | undefined, key: string | undefined): Spend | null {
  const fixture = import.meta.env?.VITE_SPEND_FIXTURE === '1'
  const [spend, setSpend] = useState<Spend | null>(fixture ? SPEND_FIXTURE : null)
  useEffect(() => {
    if (fixture || !api) return
    let live = true
    void fetchSpend(api).then((s) => { if (live) setSpend(s) })
    return () => { live = false }
  }, [api, key, fixture])
  return spend
}
