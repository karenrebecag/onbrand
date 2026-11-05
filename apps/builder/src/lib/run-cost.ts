import { useEffect, useRef, useState } from 'react'

// Tiempo y consumo por turno como el header Details de Lovable (re-iteracion/lovable-details: editor-body-shared
// _Component16/_Component6/Ad, app-shared D9e, dashboard-shared _E, app-lazy-shared xce). Donde Lovable pone créditos
// aquí van tokens: no cobramos créditos y el CLI reporta los tokens del turno (decisión de Karen, 2026-10-29).

/** D9e de Lovable con unidades cortas: "42s", "1m 42s", "1h 3m 5s"; con alwaysShowSeconds no se calla los "0s". */
export function formatDuration(seconds: number, alwaysShowSeconds = false): string {
  const s = Math.round(seconds)
  if (s < 1) return '1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), sec = s % 60
  if (m < 60) return sec > 0 || alwaysShowSeconds ? `${m}m ${sec}s` : `${m}m`
  const h = Math.floor(m / 60), min = m % 60
  if (alwaysShowSeconds) return `${h}h ${min}m ${sec}s`
  return min > 0 ? `${h}h ${min}m` : `${h}h`
}

/** _E de Lovable (dashboard-shared), el contador compacto de su uso: menos de mil tal cual, después "12.3k" y "1.2m". */
export function formatCompact(n: number, locale = 'es'): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1e3) return new Intl.NumberFormat(locale).format(Math.round(n))
  const [v, unit] = n >= 1e6 ? [n / 1e6, 'm'] : [n / 1e3, 'k']
  const r = Math.round(v * 10) / 10
  return `${Number.isInteger(r) ? r : r.toFixed(1)}${unit}`
}

export interface TokenUsage { inputTokens?: number; outputTokens?: number }

/** Total de tokens del turno, o undefined si el turno no los reportó o fueron cero (como Ad con el costo de Lovable). */
export function totalTokens(usage: TokenUsage | undefined): number | undefined {
  const total = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  return total > 0 ? total : undefined
}

/** El tooltip de los tokens, en el lugar del activityView_creditsUsed de Lovable: el desglose de entrada y salida. */
export function tokensTooltip(usage: TokenUsage, locale = 'es'): string {
  const f = (n: number) => new Intl.NumberFormat(locale).format(n)
  return `${f(usage.inputTokens ?? 0)} tokens de entrada · ${f(usage.outputTokens ?? 0)} de salida`
}

/** Textos del tooltip de la duración, del catálogo español de Lovable (activityView_runningFor / workedFor). */
export const durationTooltip = (running: boolean, text: string): string => (running ? `Ejecutándose durante ${text}` : `Trabajó durante ${text}`)

/** xce de Lovable: mientras corre, la duración avanza sola cada segundo desde el último valor conocido, y salta adelante
 * si el valor del servidor ya va más lejos; al terminar muestra el valor final. */
export function useLiveElapsed(elapsedMs: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  const anchor = useRef<{ base: number; wall: number } | null>(null)
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])
  if (!running) { anchor.current = null; return elapsedMs }
  if (!anchor.current || elapsedMs > anchor.current.base + (now - anchor.current.wall)) anchor.current = { base: elapsedMs, wall: now }
  return Math.max(anchor.current.base + (now - anchor.current.wall), anchor.current.base)
}
