import { expect, test } from 'bun:test'
import { dsChangeOf, startRun } from '../apps/builder/src/lib/run-client'
import { flowOf } from '../apps/builder/src/lib/turn-phases'
import { chatBase } from '../apps/builder/src/lib/chat-routes'

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

// Runtime startUpdateDs (12e70c9): 409 "el DS ya está en <pin>" no es un workspace ocupado; la persona tiene que leer
// que no hay nada que actualizar, no que espere a otra corrida.
test('actualizar DS en el último pin dice que ya está al día y un 409 de workspace ocupado sigue diciendo eso', async () => {
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = reply(409, { error: 'el DS ya está en a09e1f3d' })
    await expect(startRun(chatBase('http://t', 'c'), { messageId: 'm2', parentId: 'm1', updateDs: true })).rejects.toThrow('El diseño ya usa la última versión del DS.')
    globalThis.fetch = reply(409, { error: 'el workspace ya tiene una corrida en curso' })
    await expect(startRun(chatBase('http://t', 'c'), { messageId: 'm2', parentId: 'm1', updateDs: true })).rejects.toThrow('Ya hay una corrida en curso en este workspace.')
  } finally {
    globalThis.fetch = realFetch
  }
  expect(flowOf({ updateDs: true }, false)).toBe('update-ds')
})

// /runs/:id/versions trae updatedDs {from?, to}; un chat de antes del pin no tiene from.
test('la versión de actualizar DS muestra de qué pin a cuál pasó', () => {
  expect([
    dsChangeOf({ updatedDs: { from: 'a09e1f3d11', to: 'b17c22aa99' } }),
    dsChangeOf({ updatedDs: { to: 'b17c22aa99' } }),
    dsChangeOf({ updatedDs: null }),
    dsChangeOf({}),
  ]).toEqual(['a09e1f3d → b17c22aa', '→ b17c22aa', null, null])
})

// Síntesis re-contexto §2.1: el viewport es el de la pantalla que la persona mira, no el alto de página reportado.
// El lienzo importa CSS modules: se carga dentro del test, como en builder-loading-states.
test('el viewport del follow-up es el ancho del marco elegido y su alto de pantalla', async () => {
  const { frameViewport } = await import('../apps/builder/src/components/builder/artboard-canvas')
  const frames = [{ id: 'desktop', w: 1280, h: 5400 }, { id: 'mobile', w: 390, h: 7200 }, { id: 'v1', w: 1280, h: 5400 }]
  expect([frameViewport('mobile', frames), frameViewport('v1', frames), frameViewport(null, frames)]).toEqual([
    { width: 390, height: 844 }, { width: 1280, height: 900 }, { width: 1280, height: 900 },
  ])
})
