import { expect, test } from 'bun:test'
import { framesToRemount } from '../apps/builder/src/lib/preview-heartbeat'
import { previewHeartbeat } from '../apps/builder/src/lib/run-client'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

// R4.6 (re-ejecucion/builder.md §2): con la url estable el src no cambia, así que el marco se remonta solo cuando el
// commit servido cambió o el preview volvió de absent; un absent no remonta (el transport sirve la página de carga).
test('remonta el marco si cambió la versión o el preview volvió, y no por un absent', () => {
  const prev = { a: { status: 'live' as const, version: 's1' }, b: { status: 'absent' as const, version: null }, c: { status: 'live' as const, version: 's1' } }
  const next = { a: { status: 'dist' as const, version: 's2' }, b: { status: 'live' as const, version: 's1' }, c: { status: 'absent' as const, version: null }, d: { status: 'live' as const, version: 's1' } }
  expect(framesToRemount(prev, next)).toEqual(['a', 'b'])
  expect(framesToRemount(next, { a: { status: 'live', version: 's2' } })).toEqual([])
})

// Contrato R5 con Secondary: POST /preview/heartbeat {visible}; 404 = transport sin el endpoint; la url que no es http
// se descarta para que una respuesta rara no meta un javascript: en el src del iframe.
test('el latido manda los chats visibles, valida los estados y deja ver el 404', async () => {
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  const replies = [
    new Response(JSON.stringify({ states: { a: { status: 'live', version: 's1', url: 'http://127.0.0.1:5310/preview/a/' }, b: { status: 'live', version: 's1', url: 'javascript:alert(1)' }, c: { status: 'raro', version: null } } })),
    new Response(null, { status: 404 }),
  ]
  globalThis.fetch = (async (url: string, init?: RequestInit) => { sent.push([url, JSON.parse(String(init?.body))]); return replies.shift()! }) as unknown as typeof fetch
  try {
    expect(await previewHeartbeat(chatBase('/api', 'c'), ['a', 'b', 'c'])).toEqual({ a: { status: 'live', version: 's1', url: 'http://127.0.0.1:5310/preview/a/' } })
    expect(sent[0]).toEqual(['/api/chats/c/preview/heartbeat', { visible: ['a', 'b', 'c'] }])
    await expect(previewHeartbeat(chatBase('/api', 'c'), ['a'])).rejects.toMatchObject({ status: 404 })
  } finally {
    globalThis.fetch = realFetch
  }
})

// QA R4.6: el marco cargó "Preparando preview" antes del primer latido y quedó en blanco. Sin estado previo no hay
// cambio que detectar; el silencio del marco es la señal, con tope para no remontar en bucle un preview roto.
test('un marco silencioso se remonta cuando su preview sirve, hasta el tope', async () => {
  const { MAX_SILENT_REMOUNTS } = await import('../apps/builder/src/lib/preview-heartbeat')
  const next = { a: { status: 'live' as const, version: 's1' }, b: { status: 'dist' as const, version: 's1' }, c: { status: 'absent' as const, version: null } }
  const silent = new Set(['a', 'b', 'c'])
  expect(framesToRemount({}, next, silent)).toEqual(['a', 'b'])
  expect(framesToRemount({}, next, silent, { a: MAX_SILENT_REMOUNTS })).toEqual(['b'])
})

// QA caso 5 (chat 9cbabeec): el vite bajo demanda tardó más que los 3 remontes y el marco quedó en blanco para siempre.
// Pasado el tope se sigue reintentando con el backoff de la reconexión, no se corta.
test('pasado el tope, un marco silencioso se vuelve a remontar cuando venció el backoff', async () => {
  const { MAX_SILENT_REMOUNTS } = await import('../apps/builder/src/lib/preview-heartbeat')
  const { retryDelay } = await import('../apps/builder/src/lib/run-client')
  const next = { a: { status: 'live' as const, version: 's1' } }
  const silent = new Set(['a'])
  const tries = { a: MAX_SILENT_REMOUNTS }
  const wait = retryDelay(MAX_SILENT_REMOUNTS)
  expect([framesToRemount(next, next, silent, tries, { a: 1000 }, 1000 + wait - 1), framesToRemount(next, next, silent, tries, { a: 1000 }, 1000 + wait)]).toEqual([[], ['a']])
})
