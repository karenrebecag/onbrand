import { expect, test } from 'bun:test'
import type { MessageState, StepState } from '../src/runtime/event-model'
import { toolUpdates } from '../apps/builder/src/lib/run-state'

const step = (id: string, kind: StepState['kind'], label: string, status: StepState['status'], parentStepId: string | null = 'agent:write'): StepState =>
  ({ id, kind, label, status, output: '', startedAt: 0, ...(parentStepId ? { parentStepId } : {}) })

// Ag de Stitch (DesignPage, MgComponent): una fila por herramienta en el orden en que apareció, con hechas/total, y el
// estado del grupo: falla si una falló, en curso si una sigue, completo si terminaron todas.
test('agrupa las llamadas del agente por herramienta, con conteo y estado del grupo', () => {
  const message: MessageState = {
    messageId: 'm1', status: 'streaming', text: '',
    steps: [
      step('w0', 'action', 'Escribiendo la página', 'running', null),
      step('t1', 'thinking', 'Voy a leer el DS', 'ok'),
      step('r1', 'read', 'Leído SKILL.md', 'ok'),
      step('w1', 'write', 'Escrito src/sections/01-hero.tsx', 'ok'),
      step('r2', 'read', 'Leyendo index.md', 'running'),
      step('w2', 'write', 'Escrito src/sections/02-features.tsx: falló', 'error'),
      step('b1', 'tool', 'Tipos revisados', 'ok'),
      step('b2', 'tool', 'Mirando la página a 1440 px', 'running'),
    ],
  }
  expect(toolUpdates(message)).toEqual([
    { tool: 'read', displayName: 'Leyendo archivos', total: 2, completed: 1, status: 'started' },
    { tool: 'write', displayName: 'Escribiendo archivos', total: 2, completed: 1, status: 'failed' },
    { tool: 'typecheck', displayName: 'Revisando tipos', total: 1, completed: 1, status: 'completed' },
    { tool: 'browser', displayName: 'Mirando la página', total: 1, completed: 0, status: 'started' },
  ])
})

// S4 §6: con `tool` en el paso, la fila de la herramienta sale del evento y no del verbo del label.
test('un paso con tool se agrupa por ese nombre aunque su label no se reconozca', () => {
  const message: MessageState = {
    messageId: 'm1', status: 'streaming', text: '',
    steps: [{ ...step('g1', 'tool', 'Generando imagen', 'ok'), tool: 'generate_image' }, { ...step('g2', 'tool', 'Imagen generada', 'ok'), tool: 'generate_image' }],
  }
  expect(toolUpdates(message)).toEqual([{ tool: 'generate_image', displayName: 'Generando imagen', total: 2, completed: 2, status: 'completed' }])
})

// Como Fix with v0, "Arreglar" solo cuenta errores de runtime: contraste y desborde van a la ronda de accesibilidad.
test('el aviso del preview cuenta solo los errores, no los sensores de diseño', async () => {
  const { previewIssueSummary, previewIssueMessages } = await import('../apps/builder/src/lib/run-state')
  const message: MessageState = {
    messageId: 'm1', status: 'stop', text: '',
    steps: [{ id: 'transport:preview-check', kind: 'tool', label: 'Found 6 preview issues', status: 'error', output: '', startedAt: 0,
      detail: { kind: 'tool', name: 'preview-runtime', output: { defects: [{ kind: 'contrast' }, { kind: 'contrast' }, { kind: 'contrast' }, { kind: 'overflow' }, { kind: 'pageerror' }], server: ['[vite] boom'] } } }],
  }
  expect(previewIssueSummary(message, 1)).toBe('3 errores')
  const designOnly: MessageState = { ...message, steps: [{ ...message.steps[0], detail: { kind: 'tool', name: 'preview-runtime', output: { defects: [{ kind: 'contrast' }, { kind: 'cta-wrap' }, { kind: 'visual' }, { kind: 'preserve-text' }], server: [] } } }] }
  expect([previewIssueMessages(designOnly), previewIssueSummary(designOnly)]).toEqual([[], ''])
})
