import { expect, test } from 'bun:test'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

const memory = () => import('../apps/builder/src/lib/brand-memory')
const runState = () => import('../apps/builder/src/lib/run-state')

// contexto-agente.md §1: `- <hecho> · <messageId> · <AAAA-MM-DD>`. Editar el hecho conserva la procedencia; vaciarlo lo borra.
test('la memoria editada conserva la procedencia de cada hecho y descarta los vacíos', async () => {
  const { parseMemory, serializeMemory } = await memory()
  const lines = parseMemory('# Memoria\n- Abre de 9 a 18 · m1 · 2026-11-04\n- Sin testimonios\n\n- Tono cercano · m2 · 2026-11-03\n')
  expect(lines).toEqual([
    { fact: 'Abre de 9 a 18', source: { messageId: 'm1', date: '2026-11-04' } },
    { fact: 'Sin testimonios' },
    { fact: 'Tono cercano', source: { messageId: 'm2', date: '2026-11-03' } },
  ])
  const edited = [{ ...lines[0]!, fact: 'Abre de 8 a 18' }, { ...lines[1]!, fact: '  ' }, lines[2]!]
  expect(serializeMemory(edited)).toBe('- Abre de 8 a 18 · m1 · 2026-11-04\n- Tono cercano · m2 · 2026-11-03\n')
  expect(serializeMemory([])).toBe('')
})

// Mismos topes que valida el PUT: avisar antes de mandar en vez de recibir un 400.
test('la memoria avisa al pasar de 40 líneas o 4 KiB', async () => {
  const { memoryOverLimit } = await memory()
  expect(memoryOverLimit(Array.from({ length: 40 }, (_, i) => `- hecho ${i}`).join('\n'))).toBeNull()
  expect(memoryOverLimit(Array.from({ length: 41 }, (_, i) => `- hecho ${i}`).join('\n'))).toContain('41 líneas')
  expect(memoryOverLimit(`- ${'x'.repeat(4100)}`)).toContain('bytes')
})

// §2: el medidor es del hilo, desde el último turno con agente; una edición directa al final no lo borra.
test('el ratio de contexto sale del último turno que lo trajo', async () => {
  const { contextUsageOf, contextPercent, CONTEXT_WARN } = await runState()
  const turn = (ratio?: number) => ({ messageId: 'm', status: 'stop' as const, text: '', steps: [], ...(ratio === undefined ? {} : { contextUsage: { ratio, lastTokens: 0, floorTokens: 0, window: 0 } }) })
  expect(contextUsageOf([turn(0.2), turn(0.34), turn()])?.ratio).toBe(0.34)
  expect(contextUsageOf([turn()])).toBeNull()
  expect(contextPercent({ ratio: 0.345 })).toBe(35)
  expect(contextPercent({ ratio: 1.4 })).toBe(100)
  expect(CONTEXT_WARN).toBe(0.6)
})

// §3: sin items no hay chip; "Reemplazar" precarga el pedido con el texto y la sección.
test('los datos de ejemplo descartan entradas vacías y arman el pedido de reemplazo', async () => {
  const { inventedOf, replaceFactPrompt } = await runState()
  const message = { messageId: 'm', status: 'stop' as const, text: '', steps: [], invented: [{ slug: '01-hero', text: 'el número de WhatsApp' }, { slug: '02-x', text: ' ' }] }
  expect(inventedOf(message as never)).toEqual([{ slug: '01-hero', text: 'el número de WhatsApp' }])
  expect(inventedOf(undefined)).toEqual([])
  expect(replaceFactPrompt({ slug: '01-hero', text: 'el número de WhatsApp' })).toBe('Pon el dato real de el número de WhatsApp en 01-hero: ')
})

// Una marca sin memory.md responde 404: la pestaña Memory muestra el estado vacío, no un error.
test('la memoria de una marca sin archivo se lee vacía y un 500 sí falla', async () => {
  const { fetchBrandMemory } = await import('../apps/builder/src/lib/run-client')
  const real = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    expect(await fetchBrandMemory(chatBase('/api', 'c'), 'acme')).toBe('')
    globalThis.fetch = (async () => new Response(JSON.stringify({ text: '- Tono cercano\n' }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchBrandMemory(chatBase('/api', 'c'), 'acme')).toBe('- Tono cercano\n')
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    await expect(fetchBrandMemory(chatBase('/api', 'c'), 'acme')).rejects.toThrow('500')
  } finally {
    globalThis.fetch = real
  }
})

// §2 plegado (a)-(c): el turno viejo abierto desde el registro conserva sus chips pero no lleva el medidor del hilo;
// el último lleva el ratio más reciente aunque él mismo no lo traiga.
test('el turno viejo va plegado con sus chips y sin medidor; el último lleva el ratio del hilo', async () => {
  const { turnFooterOf } = await runState()
  const msg = (extra: Record<string, unknown>) => ({ messageId: 'm', status: 'stop' as const, text: '', steps: [], ...extra }) as never
  const old = msg({ invented: [{ slug: '01-hero', text: 'el WhatsApp' }], memoryWrites: [{ fact: 'Tono cercano' }], contextUsage: { ratio: 0.3 } })
  const mid = msg({ contextUsage: { ratio: 0.45 } })
  const last = msg({})
  const thread = [old, mid, last]
  expect(turnFooterOf(old, false, thread)).toEqual({ invented: [{ slug: '01-hero', text: 'el WhatsApp' }], memoryWrites: [{ fact: 'Tono cercano' }], context: null })
  expect(turnFooterOf(last, true, thread)).toEqual({ invented: [], memoryWrites: [], context: { ratio: 0.45 } })
})

// §3: facts.invented reemplaza, no acumula. Un plan final sin nada inventado (items: []) borra el chip que dejó una
// versión anterior del mismo turno; el chip solo se pinta con items (InventedChip devuelve null con la lista vacía).
test('facts.invented con items vacíos deja el turno sin chip aunque antes hubiera datos de ejemplo', async () => {
  const { turnFooterOf } = await runState()
  const { applyEvent, emptyMessage, parseEvent } = await import('../src/runtime/event-model')
  const ev = (body: Record<string, unknown>, seq: number) => parseEvent({ v: 1, messageId: 'm1', seq, at: 1, ...body })
  const before = applyEvent(emptyMessage(), ev({ type: 'facts.invented', items: [{ slug: '01-hero', text: 'el WhatsApp' }] }, 1))
  const after = applyEvent(before, ev({ type: 'facts.invented', items: [] }, 2))
  expect(turnFooterOf(before, true, [before]).invented).toHaveLength(1)
  expect(turnFooterOf(after, true, [after]).invented).toEqual([])
})
