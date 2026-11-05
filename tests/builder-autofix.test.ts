import { expect, test } from 'bun:test'
import type { EngineEvent, MessageState } from '../src/runtime/event-model'
import { autofixOf, followUpsOf } from '../apps/builder/src/lib/run-state'
import { autoLiveEligible, type Turn } from '../apps/builder/src/lib/use-builder'

const autofixEnd = (detail: Record<string, unknown>): EngineEvent => ({ v: 1, messageId: 'p1', seq: 9, at: 0, type: 'step.end', stepId: 'transport:autofix', label: 'Arreglando secciones', status: 'ok', detail: { kind: 'action', name: 'auto-repair', summary: 'c1', ...detail } } as EngineEvent)

// El hijo del auto-repair solo se conoce por este paso: sin childId o con un kind raro no hay a qué engancharse.
test('transport:autofix da el hijo al que engancharse; cualquier otro paso no', () => {
  expect(autofixOf(autofixEnd({ childId: 'c1', autoRepair: 'render' }))).toEqual({ childId: 'c1', kind: 'render', label: 'Arreglando secciones' })
  expect(autofixOf(autofixEnd({ childId: 'c1', autoRepair: 'otro' }))).toBeNull()
  expect(autofixOf(autofixEnd({ autoRepair: 'runtime' }))).toBeNull()
  expect(autofixOf({ ...autofixEnd({ childId: 'c1', autoRepair: 'runtime' }), stepId: 'transport:repair' } as EngineEvent)).toBeNull()
})

// El auto-repair de render consume el pendiente del server: el chip "Fix ready" daría 400 si se dejara.
test('el chip de render se oculta cuando arrancó su auto-repair', () => {
  const chip = { id: 'transport:repair', kind: 'action' as const, label: 'Fix ready', status: 'ok' as const, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'repair', summary: 'hero', followUps: [{ title: 'Arreglar 1 sección', message: 'x' }] } }
  const auto = (kind: string) => ({ id: 'transport:autofix', kind: 'action' as const, label: 'Arreglando', status: 'ok' as const, output: '', startedAt: 0, detail: { kind: 'action' as const, name: 'auto-repair', summary: 'c1', childId: 'c1', autoRepair: kind } })
  const msg = (steps: unknown[]): MessageState => ({ messageId: 'p1', status: 'patch', steps, text: '' } as MessageState)
  expect(followUpsOf(msg([chip]))).toHaveLength(1)
  expect(followUpsOf(msg([chip, auto('render')]))).toEqual([])
  expect(followUpsOf(msg([chip, auto('runtime')]))).toHaveLength(1)
})

// El tope es uno por versión y nunca sobre un arreglo; antes de settled decide el server.
test('el builder lanza el auto-repair del preview vivo solo sobre una versión cerrada que no es un arreglo', () => {
  const turn = (over: Partial<Turn> = {}): Turn => ({ messageId: 'v1', prompt: 'p', state: { messageId: 'v1', status: 'stop', steps: [], text: '' } as MessageState, elapsedMs: 0, request: { prompt: 'p' }, settled: true, ...over })
  const none = new Set<string>()
  expect(autoLiveEligible(turn(), false, 'v1', none)).toBe(true)
  expect(autoLiveEligible(turn({ settled: false }), false, 'v1', none)).toBe(false)
  expect(autoLiveEligible(turn(), true, 'v1', none)).toBe(false)
  expect(autoLiveEligible(turn(), false, 'v0', none)).toBe(false)
  expect(autoLiveEligible(turn({ auto: 'runtime' }), false, 'v1', none)).toBe(false)
  expect(autoLiveEligible(turn({ request: { repair: 'runtime' } }), false, 'v1', none)).toBe(false)
  expect(autoLiveEligible(turn(), false, 'v1', new Set(['v1']))).toBe(false)
})
