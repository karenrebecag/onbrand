import { expect, test } from 'bun:test'
import { liveTurn, turnFromThread } from '../apps/builder/src/lib/use-builder'
import type { ThreadMessage } from '../apps/builder/src/lib/run-client'

const message = (messageId: string, done: boolean): ThreadMessage => ({ messageId, parentId: null, prompt: 'Una landing', commit: done ? 'abc' : null, at: 1, done })

// QA (#909): al recargar justo después de un turno, su log se replega desde un estado vacío que pasa por 'streaming'. El
// builder lo tomaba por vivo, mandaba el siguiente mensaje como steer y el Runtime respondía 409. Lo vivo lo dice el hilo.
test('un turno que el Runtime da por cerrado no es el turno vivo aunque su estado local siga en streaming', () => {
  const closed = turnFromThread(message('m1', true))
  expect(closed.state.status).toBe('streaming')
  expect(liveTurn([closed])).toBeUndefined()

  const open = turnFromThread(message('m2', false))
  expect(liveTurn([closed, open])?.messageId).toBe('m2')

  // Un plan aprobado vuelve a correr sobre el mismo mensaje: al reabrirlo deja de contar como cerrado.
  expect(liveTurn([{ ...closed, closed: false }])?.messageId).toBe('m1')
})
