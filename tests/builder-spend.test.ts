import { expect, test } from 'bun:test'
import { fetchSpend, parseSpend, spendView } from '../apps/builder/src/lib/spend'

// GET /spend del orquestador (routes.ts): el medidor pinta lo que dice el server; sin respuesta válida, nada.
test('parseSpend acepta el contrato y descarta números rotos; sin /spend no hay medidor', async () => {
  expect(parseSpend({ spentUsd: 1.5, capUsd: 5, window: 'day', resetsAt: 1000, updatedAt: 1 })).toEqual({ spentUsd: 1.5, capUsd: 5, window: 'day', resetsAt: 1000 })
  expect([parseSpend({ spentUsd: Number.NaN, capUsd: 5 }), parseSpend({ spentUsd: -1, capUsd: 5 }), parseSpend(null)]).toEqual([null, null, null])
  expect(await fetchSpend('/api', async () => new Response('no', { status: 404 }))).toBeNull()
})

// Al tope, el siguiente pedido al modelo es un 429 del proxy: el medidor lo dice con texto, no solo con color.
test('el medidor muestra gasto de tope y, alcanzado, avisa que el tope diario se cumplió', () => {
  expect(spendView({ spentUsd: 1.24, capUsd: 5, window: 'day' })).toMatchObject({ text: '1,24 / 5,00 USD', reached: false })
  expect(spendView({ spentUsd: 5.3, capUsd: 5, window: 'day' })).toMatchObject({ text: 'Tope diario alcanzado', reached: true, ratio: 1 })
})

// QA: en el core no hay /spend y el builder lo pedía en cada turno. Tras un 404 no se vuelve a pedir; tras un 500, sí.
test('tras un 404 de /spend no se vuelve a pedir; un 500 se reintenta', async () => {
  const urls: string[] = []
  const reply = (status: number) => async (url: string) => { urls.push(url); return new Response('{}', { status }) }
  await fetchSpend('http://core/api', reply(404))
  await fetchSpend('http://core/api', reply(404))
  await fetchSpend('http://orq/api', reply(500))
  await fetchSpend('http://orq/api', reply(500))
  expect(urls).toEqual(['http://core/api/spend', 'http://orq/api/spend', 'http://orq/api/spend'])
})
