import { expect, test } from 'bun:test'
import { fetchThread, startRun, threadInstructions } from '../apps/builder/src/lib/run-client'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

// C6: tras recargar el builder arrancaba con rules vacío y el primer follow-up mandaba instructions: [], que borra las
// heredadas. GET /chats trae las vigentes y el follow-up las vuelve a mandar.
test('recargar hidrata las instructions del hilo y el follow-up las manda', async () => {
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/chats/c')) return new Response(JSON.stringify({ chatId: 'c', messages: [], preview: null, instructions: ['Tono formal', 'Sin emojis'] }))
    sent.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ messageId: 'm2' }), { status: 202 })
  }) as typeof fetch
  try {
    const rules = threadInstructions(await fetchThread(chatBase('http://t', 'c'))) ?? []
    await startRun(chatBase('http://t', 'c'), { messageId: 'm2', parentId: 'm1', prompt: 'cambia el titular', instructions: rules })
    expect(sent[0]).toMatchObject({ parentId: 'm1', instructions: ['Tono formal', 'Sin emojis'], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  } finally {
    globalThis.fetch = realFetch
  }
  // Un transport sin el campo o con basura no hidrata: el panel sigue con lo suyo.
  expect([threadInstructions({}), threadInstructions({ instructions: [1] }), threadInstructions({ instructions: [] })]).toEqual([null, null, []])
})

// Un follow-up que sale antes de que el hilo hidrate no manda el campo: así hereda en el transport en vez de mandar [].
test('sin hidratar y sin edición de la persona, el campo instructions no viaja', async () => {
  const { instructionsToSend } = await import('../apps/builder/src/lib/use-builder')
  expect([
    instructionsToSend([], false, false),
    instructionsToSend(['Tono formal'], false, true),
    instructionsToSend([], true, false),
  ]).toEqual([undefined, ['Tono formal'], []])
})

// H7 PR8: el alcance de marca lee y guarda en /brands/:id/instructions (#444); el motivo de un 400 llega a la persona.
test('instrucciones de marca: GET y PUT con el id codificado, y el error del transport tal cual', async () => {
  const { fetchBrandInstructions, saveBrandInstructions } = await import('../apps/builder/src/lib/run-client')
  const calls: { url: string; method: string; body?: unknown }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (init?.method === 'PUT' && (JSON.parse(String(init.body)) as { instructions: string[] }).instructions.length > 10) return new Response(JSON.stringify({ error: 'máximo 10 instrucciones' }), { status: 400 })
    return new Response(JSON.stringify({ instructions: init?.method === 'PUT' ? JSON.parse(String(init.body)).instructions : ['Tutea'] }))
  }) as typeof fetch
  try {
    expect(await fetchBrandInstructions(chatBase('http://t', 'c'), 'acme café')).toEqual(['Tutea'])
    expect(await saveBrandInstructions(chatBase('http://t', 'c'), 'acme café', ['Tutea', 'Sin emojis'])).toEqual(['Tutea', 'Sin emojis'])
    await expect(saveBrandInstructions(chatBase('http://t', 'c'), 'acme', Array.from({ length: 11 }, (_, i) => `r${i}`))).rejects.toThrow('máximo 10 instrucciones')
  } finally {
    globalThis.fetch = realFetch
  }
  expect(calls.slice(0, 2)).toEqual([
    { url: 'http://t/chats/c/brands/acme%20caf%C3%A9/instructions', method: 'GET' },
    { url: 'http://t/chats/c/brands/acme%20caf%C3%A9/instructions', method: 'PUT', body: { instructions: ['Tutea', 'Sin emojis'] } },
  ])
})
