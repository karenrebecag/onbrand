import { useEffect, useState } from 'react'

/** Lo que manda el puente del scaffold (templates/base-scaffold/src/wt-error-bridge.ts, #278). */
export interface RuntimeError {
  kind: 'console.error' | 'error' | 'unhandledrejection'
  message: string
  stack?: string
  source?: string
  line?: number
  column?: number
  path: string
}

const KINDS: readonly RuntimeError['kind'][] = ['console.error', 'error', 'unhandledrejection']
const MAX = 4000
const isText = (v: unknown, max = MAX): v is string => typeof v === 'string' && v.length <= max + 1
const isCount = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0)

/** El mensaje viene de una página que escribe el agente: se valida campo por campo y lo demás se descarta. */
export function parseRuntimeError(data: unknown): RuntimeError | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:runtime-error' || !KINDS.includes(d.kind as RuntimeError['kind'])) return null
  if (!isText(d.message) || !d.message || !isText(d.path, 512)) return null
  if ((d.stack !== undefined && !isText(d.stack)) || (d.source !== undefined && !isText(d.source, 512)) || !isCount(d.line) || !isCount(d.column)) return null
  return {
    kind: d.kind as RuntimeError['kind'], message: d.message, path: d.path,
    ...(d.stack ? { stack: d.stack as string } : {}), ...(d.source ? { source: d.source as string } : {}),
    ...(d.line !== undefined ? { line: d.line as number } : {}), ...(d.column !== undefined ? { column: d.column as number } : {}),
  }
}

const keyOf = (e: Pick<RuntimeError, 'message' | 'path'>) => `${e.message}\u0000${e.path}`

/** Suma un error a la lista si no está ya (mismo mensaje en la misma ruta): un error en un render se repite. */
export const addRuntimeError = (list: RuntimeError[], e: RuntimeError): RuntimeError[] =>
  list.some((x) => keyOf(x) === keyOf(e)) ? list : [...list, e]

/** Los del vivo que el preview-check del servidor no vio ya: el mismo error llega por los dos lados. */
export const newRuntimeErrors = (live: RuntimeError[], serverMessages: string[]): RuntimeError[] =>
  live.filter((e) => !serverMessages.some((m) => m.split('\n')[0] === e.message.split('\n')[0]))

/** El preview avisa que cargó un documento nuevo o va a aplicar un update de HMR (wt-error-bridge.ts, WT_PREVIEW_UPDATED). */
export const isPreviewUpdated = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'wt:preview-updated'

/** Log de consola del preview que no es error (wt-error-bridge.ts, WT_LOG_MESSAGE). */
export interface ClientLog { level: 'log' | 'info' | 'warn' | 'debug'; message: string; ts: number; path: string }

/** Request del preview, solo metadatos (wt-error-bridge.ts, WT_NETWORK_MESSAGE). */
export interface NetworkRequest { method: string; url: string; status: number; ok: boolean; durationMs: number; error?: string; ts: number; path: string }

/** Lo que el preview hizo en vivo y viaja con cada turno del modelo, como client_logs, network_requests y
 * runtime_errors de Lovable (re-sistema/lovable/datos/contexto-pipeline.md). */
export interface RuntimeContext { clientLogs: ClientLog[]; networkRequests: NetworkRequest[]; runtimeErrors: RuntimeError[]; contrastDefects?: ContrastDefect[] }

/** Un defecto de contraste que la persona manda con el botón del aviso (#898, runtime-context.ts): el Runtime lo valida y lo
 * pasa al agente como dato, no como instrucción. */
export interface ContrastDefect { slug: string | null; ratio: number; colors: { fg: string; bg: string } }

/** El tope del Runtime (MAX_CONTRAST_DEFECTS): más entradas harían que rechace el turno entero. */
export const CONTRAST_DEFECTS_MAX = 50

/** El contexto del turno con los defectos de contraste sumados; sin defectos, el mismo de antes. Sin contexto vivo arma uno con solo
 * los defectos. No pasa por runtimeContextOf: el recorte por bytes nunca tira contraste (el Runtime tampoco). */
export function withContrastDefects(ctx: RuntimeContext | undefined, defects: readonly ContrastDefect[] | undefined): RuntimeContext | undefined {
  if (!defects?.length) return ctx
  return { ...(ctx ?? { clientLogs: [], networkRequests: [], runtimeErrors: [] }), contrastDefects: defects.slice(0, CONTRAST_DEFECTS_MAX) }
}

const LEVELS: readonly ClientLog['level'][] = ['log', 'info', 'warn', 'debug']
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function parseClientLog(data: unknown): ClientLog | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:runtime-log' || !LEVELS.includes(d.level as ClientLog['level'])) return null
  if (!isText(d.message) || !isText(d.path, 512) || !isTime(d.ts)) return null
  return { level: d.level as ClientLog['level'], message: d.message, ts: d.ts, path: d.path }
}

export function parseNetworkRequest(data: unknown): NetworkRequest | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'wt:network' || !isText(d.method, 16) || !d.method || !isText(d.url, 512) || !isText(d.path, 512)) return null
  if (!Number.isInteger(d.status) || (d.status as number) < 0 || (d.status as number) > 999 || typeof d.ok !== 'boolean' || !isTime(d.durationMs) || !isTime(d.ts)) return null
  if (d.error !== undefined && !isText(d.error)) return null
  return { method: d.method, url: d.url, status: d.status as number, ok: d.ok, durationMs: d.durationMs, ts: d.ts, path: d.path, ...(d.error ? { error: d.error as string } : {}) }
}

/** Como Lovable: los últimos 50 de cada canal. Lo más reciente es lo que describe la página que la persona mira. */
export const CONTEXT_MAX = 50
export const appendCapped = <T,>(list: T[], item: T, max = CONTEXT_MAX): T[] => [...list.slice(Math.max(list.length + 1 - max, 0)), item]

/** Mismo tope que parseRuntimeErrors del transport. */
export const ERRORS_MAX = 30
/** 50 logs de 2000 caracteres inflarían cada turno; el transport recorta igual, pero el body ya sale acotado. */
export const CONTEXT_BYTES_MAX = 16_000

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

/** Lo que viaja en el turno, o undefined sin nada que contar. Sobre el tope de bytes caen primero los logs más viejos,
 * luego las requests más viejas: los errores son lo que el agente tiene que arreglar. */
export function runtimeContextOf(c: RuntimeContext): RuntimeContext | undefined {
  let out: RuntimeContext = { ...c, runtimeErrors: c.runtimeErrors.slice(-ERRORS_MAX) }
  while (bytes(out) > CONTEXT_BYTES_MAX && (out.clientLogs.length || out.networkRequests.length)) {
    out = out.clientLogs.length ? { ...out, clientLogs: out.clientLogs.slice(1) } : { ...out, networkRequests: out.networkRequests.slice(1) }
  }
  return out.clientLogs.length || out.networkRequests.length || out.runtimeErrors.length ? out : undefined
}

const EMPTY: RuntimeContext = { clientLogs: [], networkRequests: [], runtimeErrors: [] }

/** Una transición del contexto por mensaje del preview. Un update o documento nuevo solo borra los errores: como
 * Lovable, los logs y requests siguen siendo los últimos 50, pero un error de antes del update ya no describe la página. */
export function reduceRuntimeContext(c: RuntimeContext, data: unknown): RuntimeContext {
  if (isPreviewUpdated(data)) return c.runtimeErrors.length ? { ...c, runtimeErrors: [] } : c
  const e = parseRuntimeError(data)
  if (e) {
    const runtimeErrors = addRuntimeError(c.runtimeErrors, e)
    return runtimeErrors === c.runtimeErrors ? c : { ...c, runtimeErrors }
  }
  const log = parseClientLog(data)
  if (log) return { ...c, clientLogs: appendCapped(c.clientLogs, log) }
  const req = parseNetworkRequest(data)
  if (req) return { ...c, networkRequests: appendCapped(c.networkRequests, req) }
  return c
}

/** Logs, requests y errores del preview vivo de esta versión. Solo cuenta lo que llega del origen del preview; una
 * versión nueva empieza de cero porque lo de la anterior ya no describe la página. */
export function usePreviewRuntime(previewUrl: string | null, version: string | undefined): RuntimeContext {
  const [context, setContext] = useState<RuntimeContext>(EMPTY)
  useEffect(() => {
    setContext(EMPTY)
    if (!previewUrl) return
    let origin: string
    try { origin = new URL(previewUrl).origin } catch { return }
    const onMessage = (event: MessageEvent) => {
      if (event.origin === origin) setContext((c) => reduceRuntimeContext(c, event.data))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [previewUrl, version])
  return context
}

/** Errores del preview vivo de esta versión (botón Arreglar). */
export const useRuntimeErrors = (previewUrl: string | null, version: string | undefined): RuntimeError[] =>
  usePreviewRuntime(previewUrl, version).runtimeErrors
