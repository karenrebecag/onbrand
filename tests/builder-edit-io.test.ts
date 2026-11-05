import { expect, test } from 'bun:test'
import type { MessageState } from '../src/runtime/event-model'
import { nestSteps } from '../apps/builder/src/lib/run-state'

// S4 §3 (MAKE-CHAT:40042-40063): el old/new de un Edit se pinta como entrada/salida del paso; el recorte del motor se marca.
test('un paso write con edits sale como io antes/después, con "…" si el motor lo recortó', () => {
  const message: MessageState = {
    messageId: 'm1', status: 'stop', text: '',
    steps: [
      { id: 'e1', kind: 'write', label: 'Editado hero', status: 'ok', output: '', startedAt: 0, finishedAt: 5, detail: { kind: 'write', path: 'src/sections/01-hero.tsx', op: 'update', edits: [{ before: 'viejo', after: 'nuevo\nlínea 2' }, { after: 'solo nuevo' }], truncated: true } },
      { id: 'e2', kind: 'write', label: 'Escrito hero', status: 'ok', output: '', startedAt: 0, finishedAt: 5, detail: { kind: 'write', path: 'src/sections/01-hero.tsx', op: 'create' } },
    ],
  }
  const [e1, e2] = nestSteps(message.steps)
  expect(e1?.io).toEqual({ input: 'viejo\n---\n', output: ['nuevo', 'línea 2', '---', 'solo nuevo', '…'] })
  expect(e2?.io).toBeUndefined()
})
