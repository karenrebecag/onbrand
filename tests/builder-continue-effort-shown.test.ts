import { expect, test } from 'bun:test'
import { continueRequest } from '../apps/builder/src/lib/use-builder'
import { shownEffort, shownModel, threadThinking } from '../apps/builder/src/lib/thread'

// Cierre fila 1 (#748): tras recargar, el chip muestra el esfuerzo del turno cortado que el transport hereda, pero ese
// valor no es una elección: Continuar sigue sin thinking y una elección real le gana.
test('el esfuerzo rehidratado se muestra y no viaja como elección en Continuar', () => {
  const resumed = threadThinking({ effort: 'low' })
  expect(shownEffort(undefined, resumed, 'high')).toBe('low')
  expect(continueRequest('sonnet-5.5', undefined)).toEqual({ continue: true, model: 'sonnet-5.5' })
  expect(shownEffort('max', resumed, 'high')).toBe('max')
  expect([threadThinking({ effort: 'turbo' }), threadThinking(null), shownEffort(undefined, undefined, 'high')]).toEqual([undefined, undefined, 'high'])
})

// #754: el transport hereda también el modelo; el del composer recién recargado es el primero de la lista y lo pisaba.
test('Continuar sin elegir modelo no lo manda; el chip muestra el heredado y una elección explícita gana', () => {
  const models = [{ id: 'opus-5.5' }, { id: 'sonnet-5.5' }]
  expect(continueRequest(undefined, undefined)).toEqual({ continue: true })
  expect(continueRequest('opus-5.5', undefined)).toEqual({ continue: true, model: 'opus-5.5' })
  expect([shownModel(undefined, 'sonnet-5.5', models), shownModel('opus-5.5', 'sonnet-5.5', models), shownModel(undefined, 'retirado', models)]).toEqual(['sonnet-5.5', 'opus-5.5', 'opus-5.5'])
})
