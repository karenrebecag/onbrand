import { describe, expect, test } from 'bun:test';
import { applyEvent, emptyMessage, parseEvent, type EngineEvent } from '../src/runtime/event-model';

const ev = (type: string, extra: Record<string, unknown>): EngineEvent => parseEvent({ v: 1, messageId: 'm1', seq: 0, at: 0, type, ...extra });

describe('eventos de modo plan (H6)', () => {
  test('parseEvent acepta kind plan, reason de decisión y los eventos plan.*', () => {
    expect(() => ev('approval.request', { callId: 'c1', toolName: 'mcp__wt__exit_plan_mode', app: 'wt', input: {}, kind: 'plan' })).not.toThrow();
    expect(() => ev('approval.decision', { callId: 'c1', decision: 'skip', reason: 'user-message' })).not.toThrow();
    expect(() => ev('plan.ready', { callId: 'c1', path: '.wt/plans/m1.md', summary: 'hero + cta' })).not.toThrow();
    expect(() => ev('plan.cancelled', { callId: 'c1', reason: 'rejected' })).not.toThrow();
    expect(() => ev('approval.decision', { callId: 'c1', decision: 'skip', reason: 'nope' })).toThrow();
    expect(() => ev('plan.cancelled', { callId: 'c1', reason: 'nope' })).toThrow();
  });

  test('fold: ready → pending, resumed → approved+edited, cancelled → su estado y motivo', () => {
    const ready = applyEvent(emptyMessage(), ev('plan.ready', { callId: 'c1', path: '.wt/plans/m1.md', summary: 's' }));
    expect(ready.plan).toEqual({ status: 'pending', callId: 'c1', path: '.wt/plans/m1.md', summary: 's' });

    const approved = applyEvent(ready, ev('plan.resumed', { callId: 'c1', edited: true }));
    expect(approved.plan).toMatchObject({ status: 'approved', edited: true });

    const cancelled = applyEvent(ready, ev('plan.cancelled', { callId: 'c1', reason: 'user-message' }));
    expect(cancelled.plan).toMatchObject({ status: 'cancelled', reason: 'user-message' });

    const rejected = applyEvent(ready, ev('plan.cancelled', { callId: 'c1', reason: 'rejected' }));
    expect(rejected.plan).toMatchObject({ status: 'rejected', reason: 'rejected' });
  });

  test('plan.start marca planMode sin crear aún el objeto plan', () => {
    const started = applyEvent(emptyMessage(), ev('plan.start', { path: '.wt/plans/m1.md' }));
    expect(started.planMode).toBe(true);
    expect(started.plan).toBeUndefined();
  });
});
