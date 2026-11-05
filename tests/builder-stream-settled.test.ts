import { afterEach, expect, test } from 'bun:test'
import { streamRun } from '../apps/builder/src/lib/run-client'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

// streamRun pide window; bun corre todos los archivos en un proceso y un window que quede en globalThis hace que las libs
// de los bloques crean estar en un navegador en los tests que corren después: motion-dom ("target.addEventListener is not
// a function") y @paper-design/shaders ("Image is not defined" en shader-bento y shaders-hero, CI de main desde #426).
// Se restaura después de cada test, no a mano en cada uno: dos tests lo dejaban puesto.
const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (realWindow) Object.defineProperty(globalThis, 'window', realWindow)
  else delete (globalThis as { window?: unknown }).window
})

// Ola 1: el turno cierra en el commit, pero el stream sigue hasta settled para recibir preview-check y sugerencias.
test('el stream no corta en el snapshot: sigue hasta settled', async () => {
  const base = { v: 1, messageId: 'm1', at: 0 }
  const lines = [
    { type: 'message.end', finishReason: 'stop' },
    { type: 'snapshot', dir: 'd', files: [] },
    { type: 'step.end', stepId: 'agent:suggestions', label: 'Siguientes pasos', status: 'ok', detail: { kind: 'action', name: 'suggestions', summary: 'x', followUps: [{ title: 'A', message: 'A.' }] } },
    { type: 'settled' },
  ].map((e, seq) => JSON.stringify({ ...base, seq, ...e })).join('\n') + '\n'
  ;(globalThis as { window?: unknown }).window ??= globalThis
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(lines)) as unknown as typeof fetch
  try {
    const seen: string[] = []
    await streamRun(chatBase('/api', 'c'), 'm1', (e) => seen.push(e.type), new AbortController().signal)
    expect(seen).toEqual(['message.end', 'snapshot', 'step.end', 'settled'])
  } finally {
    globalThis.fetch = realFetch
  }
})

// R4.1: backoff de Stitch (I18nStore.js:13547, :13880) sin tope, con el contador en 0 cuando el cursor avanza (:13949).
test('el stream reintenta con backoff sin rendirse y reinicia la espera cuando avanza', async () => {
  const { retryDelay } = await import('../apps/builder/src/lib/run-client')
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  const ev = (seq: number, e: Record<string, unknown>) => JSON.stringify({ v: 1, messageId: 'm1', at: 0, seq, ...e }) + '\n'
  // 8 cortes, un evento con un cierre limpio que también espera, 2 cortes más y settled.
  const script: (string | null)[] = [...Array(8).fill(null), ev(0, { type: 'text.delta', text: 'x' }), null, null, ev(1, { type: 'settled' })]
  ;(globalThis as { window?: unknown }).window ??= globalThis
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    const next = script.shift()
    if (next == null) throw new TypeError('Failed to fetch')
    return new Response(next)
  }) as unknown as typeof fetch
  try {
    const waits: number[] = []
    const flags: boolean[] = []
    const out = await streamRun(chatBase('/api', 'c'), 'm1', () => {}, new AbortController().signal, { wait: async (ms) => { waits.push(ms) }, onReconnecting: (on) => flags.push(on) })
    expect(out).toEqual({ settled: true })
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 1000, 2000, 4000])
    expect(flags).toEqual([true, false, true, false])
  } finally {
    globalThis.fetch = realFetch
  }
})

// R4.2: recover() cierra con message.end y nunca manda settled (re-ejecucion/builder.md §1).
test('un log que cierra tras message.end sin settled resuelve como no settled', async () => {
  const line = JSON.stringify({ v: 1, messageId: 'm1', at: 0, seq: 0, type: 'message.end', finishReason: 'error' }) + '\n'
  ;(globalThis as { window?: unknown }).window ??= globalThis
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(line)) as unknown as typeof fetch
  try {
    expect(await streamRun(chatBase('/api', 'c'), 'm1', () => {}, new AbortController().signal)).toEqual({ settled: false })
  } finally {
    globalThis.fetch = realFetch
  }
})

// R4.3 con el contrato de R2.6: Continuar si es continuable (también un failed con escrituras), Reenviar si se
// interrumpió sin poder retomarse, y nada si no es el último (ya se continuó) o hay una corrida en curso.
test('el turno interrumpido ofrece Continuar o Reenviar según continuable, una sola vez', async () => {
  const { resumeActionOf } = await import('../apps/builder/src/lib/use-builder')
  const turn = (messageId: string, end: Record<string, unknown>) =>
    ({ messageId, prompt: 'p', elapsedMs: 0, request: { prompt: 'p' }, state: { messageId, status: 'stopped' as const, steps: [], text: '', ...end } })
  const cont = turn('a', { outcome: 'stopped', interrupted: true, continuable: true })
  const failed = turn('b', { status: 'error', outcome: 'failed', continuable: true })
  const t1 = turn('c', { outcome: 'stopped', interrupted: true, continuable: false })
  const plain = turn('d', { outcome: 'stopped' })
  expect([cont, failed, t1, plain].map((t) => resumeActionOf(t, [t], false))).toEqual(['continue', 'continue', 'resend', null])
  expect(resumeActionOf(cont, [cont], true)).toBeNull()
  expect(resumeActionOf(cont, [cont, plain], false)).toBeNull()
})

// Run again sobre una continuación termina siempre en 409: el control no se ofrece, tampoco tras recargar (continueOf).
test('una continuación no ofrece Run again', async () => {
  const { canRestart } = await import('../apps/builder/src/lib/use-builder')
  const turn = (request: Record<string, unknown>) => ({ messageId: 'm', prompt: 'p', elapsedMs: 0, request, state: { messageId: 'm', status: 'stop' as const, steps: [], text: '' } })
  expect([canRestart(turn({ prompt: 'p' })), canRestart(turn({ continue: true }))]).toEqual([true, false])
})

// QA R4.3 + cierre fila 1 (kill -9, recarga, Continuar): el esfuerzo elegido viaja; sin elección no va thinking, porque
// el default del composer recién recargado pisaba el del turno interrumpido y el transport ya hereda ese.
test('continuar lleva el esfuerzo elegido y, sin elección, deja que el transport herede el del turno', async () => {
  const { continueRequest } = await import('../apps/builder/src/lib/use-builder')
  expect([continueRequest('sonnet-5.5', 'high'), continueRequest('sonnet-5.5', undefined)]).toEqual([
    { continue: true, model: 'sonnet-5.5', thinking: { effort: 'high' } },
    { continue: true, model: 'sonnet-5.5' },
  ])
})

// QA plan mode (2026-11-04): la decisión del plan, su cancelación y la fase build se agregan al log después del
// message.end y el settled del plan. Releer cortaba en ese primer settled: el build no se veía tras Aprobar y un plan
// rechazado volvía a mostrarse pendiente al recargar. Sin plan pendiente, settled sigue terminando la lectura.
test('con un plan pendiente el stream sigue después de su settled hasta la decisión y lo que venga', async () => {
  const ndjson = (events: Record<string, unknown>[]) => events.map((e, seq) => JSON.stringify({ v: 1, messageId: 'm1', at: 0, seq, ...e })).join('\n') + '\n'
  const plan = { type: 'approval.request', callId: 'p', toolName: 'mcp__wt__exit_plan_mode', app: 'wt', kind: 'plan', input: {} }
  const build = ndjson([
    plan, { type: 'message.end', finishReason: 'stop', outcome: 'asked' }, { type: 'settled' },
    { type: 'approval.decision', callId: 'p', decision: 'allow' }, { type: 'message.start' }, { type: 'plan.resumed', callId: 'p', edited: true },
    { type: 'message.end', finishReason: 'stop' }, { type: 'settled' }, { type: 'text.delta', text: 'después' },
  ])
  const rejected = ndjson([
    plan, { type: 'message.end', finishReason: 'stop', outcome: 'asked' }, { type: 'settled' },
    { type: 'approval.decision', callId: 'p', decision: 'skip' }, { type: 'plan.cancelled', callId: 'p', reason: 'rejected' },
  ])
  const cancelled = ndjson([
    plan, { type: 'message.end', finishReason: 'stop', outcome: 'asked' }, { type: 'settled' },
    { type: 'approval.decision', callId: 'p', decision: 'skip', reason: 'user-message' }, { type: 'plan.cancelled', callId: 'p', reason: 'user-message' },
  ])
  // Aprobado y el log termina antes del message.start del build (la decisión ya está, la fase build aún no arrancó).
  const racing = ndjson([
    plan, { type: 'message.end', finishReason: 'stop', outcome: 'asked' }, { type: 'settled' },
    { type: 'approval.decision', callId: 'p', decision: 'allow' },
  ])
  const plain = ndjson([{ type: 'message.end', finishReason: 'stop' }, { type: 'settled' }, { type: 'text.delta', text: 'después' }])
  ;(globalThis as { window?: unknown }).window ??= globalThis
  const realFetch = globalThis.fetch
  try {
    const read = async (body: string) => {
      globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch
      const seen: string[] = []
      const out = await streamRun(chatBase('/api', 'c'), 'm1', (e) => seen.push(e.type), new AbortController().signal)
      return { out, seen }
    }
    const a = await read(build)
    expect(a.out).toEqual({ settled: true })
    expect(a.seen).toEqual(['approval.request', 'message.end', 'settled', 'approval.decision', 'message.start', 'plan.resumed', 'message.end', 'settled'])
    const b = await read(rejected)
    expect(b.seen.slice(-2)).toEqual(['approval.decision', 'plan.cancelled'])
    expect(b.out).toEqual({ settled: false })
    // Cancelado por un mensaje nuevo: mismo cierre que el rechazo.
    const c = await read(cancelled)
    expect(c.seen.slice(-2)).toEqual(['approval.decision', 'plan.cancelled'])
    expect(c.out).toEqual({ settled: false })
    // Aprobado sin build todavía: no hay settled del build, así que no resuelve como cerrado.
    expect((await read(racing)).out).toEqual({ settled: false })
    expect((await read(plain)).seen).toEqual(['message.end', 'settled'])
  } finally {
    globalThis.fetch = realFetch
  }
})

// Regla de #570: stream() no cierra mientras el plan está pendiente. El cliente sigue leyendo la misma respuesta (sin EOF)
// hasta que llega la decisión, en vez de resolver en el settled del plan.
test('un plan pendiente sin EOF deja a streamRun esperando hasta que llega la decisión', async () => {
  const line = (seq: number, e: Record<string, unknown>) => JSON.stringify({ v: 1, messageId: 'm1', at: 0, seq, ...e }) + '\n'
  const encoder = new TextEncoder()
  let push!: (chunk: string) => void
  let close!: () => void
  const body = new ReadableStream<Uint8Array>({ start(c) { push = (chunk) => c.enqueue(encoder.encode(chunk)); close = () => c.close() } })
  ;(globalThis as { window?: unknown }).window ??= globalThis
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch
  try {
    const seen: string[] = []
    let resolved = false
    const run = streamRun(chatBase('/api', 'c'), 'm1', (e) => seen.push(e.type), new AbortController().signal).then((out) => { resolved = true; return out })
    push(line(0, { type: 'approval.request', callId: 'p', toolName: 'mcp__wt__exit_plan_mode', app: 'wt', kind: 'plan', input: {} }))
    push(line(1, { type: 'message.end', finishReason: 'stop', outcome: 'asked' }))
    push(line(2, { type: 'settled' }))
    // Ceder el turno hasta que el cliente procese lo que llegó; la condición es el evento visto, no el tiempo.
    for (let i = 0; i < 100 && !seen.includes('settled'); i++) await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['approval.request', 'message.end', 'settled'])
    expect(resolved).toBe(false)
    push(line(3, { type: 'approval.decision', callId: 'p', decision: 'skip' }))
    push(line(4, { type: 'plan.cancelled', callId: 'p', reason: 'rejected' }))
    close()
    await run
    expect(seen.slice(-2)).toEqual(['approval.decision', 'plan.cancelled'])
  } finally {
    globalThis.fetch = realFetch
  }
})

test('ningún test de este archivo deja window en globalThis', () => {
  expect(Object.getOwnPropertyDescriptor(globalThis, 'window')).toEqual(realWindow)
})
