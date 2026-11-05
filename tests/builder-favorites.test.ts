import { expect, test } from 'bun:test'
import { frameVisible, toggleFavorite } from '../apps/builder/src/lib/use-favorites'

// H14: la estrella agrega o quita sin repetir; el filtro esconde solo variantes sin estrella, nunca la página vigente.
test('la estrella alterna y el filtro deja la página y las variantes favoritas', () => {
  expect(toggleFavorite(['a'], 'b')).toEqual(['a', 'b'])
  expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b'])
  const desktop = { id: 'desktop' }, fav = { id: 'v1', variant: { pending: false } }, other = { id: 'v2', variant: { pending: false } }
  expect([desktop, fav, other].filter((f) => frameVisible(f, ['v1'], true)).map((f) => f.id)).toEqual(['desktop', 'v1'])
  expect([desktop, fav, other].filter((f) => frameVisible(f, ['v1'], false))).toHaveLength(3)
})

// QA Q3 sobre H14: dos estrellas seguidas con el PUT en vuelo mandaban el mismo rev y la segunda se perdía en el 409.
// Con la cola, un PUT por vez: las dos quedan guardadas. Un 409 de otro escritor reaplica la cola sobre su doc.
test('dos estrellas seguidas con latencia quedan las dos; un 409 reaplica la cola', async () => {
  const { createFavoriteSync } = await import('../apps/builder/src/lib/use-favorites')
  type Doc = { rev: number; nodes: never[]; favorites?: string[] }
  let server: Doc = { rev: 3, nodes: [] }
  let local: Doc = { ...server }
  const puts: number[] = []
  const tick = () => new Promise((r) => setTimeout(r, 5))
  const sync = createFavoriteSync({
    read: () => local as never,
    write: (d) => { local = d as Doc },
    put: async (rev, favorites) => {
      puts.push(rev)
      await tick()
      if (rev !== server.rev) return { conflict: server as never }
      server = { ...server, rev: server.rev + 1, favorites }
      return { saved: server as never }
    },
    fail: () => { throw new Error('no debía fallar') },
  })
  sync.toggle('v1', true)
  sync.toggle('v2', true)
  expect(local.favorites).toEqual(['v1', 'v2'])
  await tick(); await tick(); await tick()
  expect(server.favorites).toEqual(['v1', 'v2'])
  expect(puts).toEqual([3, 4])
  // Otra pestaña guardó antes (rev 6 con v9): la estrella de aquí se aplica encima, sin perder la de allá.
  server = { rev: 6, nodes: [], favorites: ['v1', 'v2', 'v9'] }
  sync.toggle('v1', true)
  await tick(); await tick(); await tick()
  expect(server.favorites).toEqual(['v2', 'v9'])
  expect(local).toEqual(server)
})
