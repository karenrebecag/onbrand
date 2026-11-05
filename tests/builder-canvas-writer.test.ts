import { expect, test } from 'bun:test'
import { createCanvasWriter, type PutResult } from '../apps/builder/src/lib/canvas-writer'
import type { CanvasPut } from '../apps/builder/src/lib/run-client'

type Doc = { rev: number; nodes: never[]; favorites?: string[] }

/** Server como canvas-store.ts: exige el rev leído y conserva el campo que no viaja. */
function fakeServer(start: Doc) {
  let doc = start
  const sent: number[] = []
  const put = async (body: CanvasPut): Promise<PutResult> => {
    sent.push(body.rev)
    await new Promise((r) => setTimeout(r, 5))
    if (body.rev !== doc.rev) return { conflict: doc as never }
    doc = { ...doc, rev: doc.rev + 1, ...(body.favorites ? { favorites: body.favorites } : {}) }
    return { saved: doc as never }
  }
  return { put, sent, get: () => doc, set: (d: Doc) => { doc = d } }
}

// A9: imágenes y estrella leen rev 3 y guardan a la vez. Antes, el segundo PUT salía con rev 3 y volvía 409 aunque
// el rev 4 lo había puesto esta misma pestaña.
test('dos escritores de la misma pestaña con el mismo rev guardan los dos, de a un PUT', async () => {
  const server = fakeServer({ rev: 3, nodes: [] })
  const writer = createCanvasWriter({ put: server.put })
  const [a, b] = await Promise.all([writer.write(3, { nodes: [] }), writer.write(3, { favorites: ['v1'] })])
  expect('saved' in a && 'saved' in b).toBe(true)
  expect(server.sent).toEqual([3, 4])
  expect(server.get()).toEqual({ rev: 5, nodes: [], favorites: ['v1'] })
})

// Lo que escribió otra pestaña no se salta: quien no lo vio recibe el 409 con el doc actual.
test('un rev que subió otra pestaña sigue llegando como conflicto', async () => {
  const server = fakeServer({ rev: 3, nodes: [] })
  const writer = createCanvasWriter({ put: server.put })
  await writer.write(3, { favorites: ['v1'] })
  server.set({ rev: 9, nodes: [], favorites: ['v9'] })
  const r = await writer.write(3, { nodes: [] })
  expect('conflict' in r).toBe(true)
  expect(server.sent).toEqual([3, 4])
})
