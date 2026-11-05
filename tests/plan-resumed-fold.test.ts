import { describe, expect, test } from 'bun:test';
import { foldMessage, parseEvent, type EngineEvent } from '../src/runtime/event-model';

const log = (bodies: Record<string, unknown>[]): EngineEvent[] => bodies.map((b, seq) => parseEvent({ v: 1, messageId: 'm1', seq, at: 1, ...b }));

describe('plan.resumed abre el tramo de build', () => {
  const plan = [
    { type: 'message.start' },
    { type: 'step.start', stepId: 's1', kind: 'read', label: 'Leyendo' },
    { type: 'step.end', stepId: 's1', label: 'Leído', status: 'ok' },
    { type: 'plan.start', path: '.wt/plans/m1.md' },
    { type: 'plan.ready', callId: 'c1', path: '.wt/plans/m1.md', summary: 'Landing' },
    { type: 'message.end', finishReason: 'stop', outcome: 'asked', interrupted: true, continuable: true, usage: { credits: 2 } },
  ];

  test('el replay desde 0 queda en streaming, sin el desenlace del tramo de plan, y conserva plan y pasos', () => {
    const state = foldMessage(log([...plan, { type: 'plan.resumed', callId: 'c1', edited: false }]));
    expect(state.status).toBe('streaming');
    expect(state.outcome).toBeUndefined();
    expect(state.usage).toBeUndefined();
    expect(state.interrupted).toBeUndefined();
    expect(state.continuable).toBeUndefined();
    expect(state.plan).toMatchObject({ status: 'approved', callId: 'c1' });
    expect(state.steps).toHaveLength(1);
  });

  test('el message.end del build cierra el mensaje con su propio desenlace', () => {
    const state = foldMessage(log([...plan, { type: 'plan.resumed', callId: 'c1', edited: false }, { type: 'message.end', finishReason: 'stop', outcome: 'ok' }]));
    expect(state).toMatchObject({ status: 'stop', outcome: 'ok' });
  });

  // Orden real del log del build: settled, approval.decision, message.start y recién después plan.resumed.
  test('el message.start del build ya vuelve a streaming, sin esperar a plan.resumed', () => {
    const state = foldMessage(log([...plan, { type: 'settled' }, { type: 'approval.decision', callId: 'c1', decision: 'allow' }, { type: 'message.start' }]));
    expect(state.status).toBe('streaming');
    expect(state.outcome).toBeUndefined();
    expect(state.usage).toBeUndefined();
    expect(state.plan).toMatchObject({ status: 'pending' });
  });

  test('el primer message.start no cambia nada', () => {
    expect(foldMessage(log([{ type: 'message.start' }])).status).toBe('streaming');
  });

  test('sin plan.resumed el tramo de plan sigue cerrado', () => {
    expect(foldMessage(log(plan)).status).toBe('stop');
  });
});

// #570: el reopen de message.start borra el desenlace, no la historia del turno (pasos y tarjeta del plan).
test('el message.start del build conserva pasos y aprobaciones del tramo de plan', () => {
  const state = foldMessage(log([
    { type: 'message.start' },
    { type: 'step.start', stepId: 's1', kind: 'read', label: 'Leyendo' },
    { type: 'step.end', stepId: 's1', label: 'Leído', status: 'ok' },
    { type: 'approval.request', callId: 'c1', toolName: 'mcp__wt__exit_plan_mode', app: 'wt', kind: 'plan', input: {} },
    { type: 'plan.ready', callId: 'c1', path: '.wt/plans/m1.md', summary: 'Landing' },
    { type: 'message.end', finishReason: 'stop', outcome: 'asked' },
    { type: 'settled' },
    { type: 'approval.decision', callId: 'c1', decision: 'allow' },
    { type: 'message.start' },
  ]));
  expect(state.status).toBe('streaming');
  expect(state.steps.map((s) => s.id)).toEqual(['s1']);
  expect(state.approvals).toEqual([expect.objectContaining({ callId: 'c1', kind: 'plan', decision: 'allow' })]);
});
