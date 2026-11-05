import { expect, test } from 'bun:test';
import { PLAN_SYSTEM, planVariants } from '../src/runtime/variants-plan';
import { foldMessage, parseEvent } from '../src/runtime/event-model';

test('plan de variantes: un título y un prompt por variante; con salida inválida o error, un prompt propio por variante', async () => {
  const calls: [string, string][] = [];
  const ok = await planVariants(async (s, u) => { calls.push([s, u]); return { variants: [{ title: ' V1: Densa ', prompt: 'P1' }, { title: 'V2', prompt: 'P2' }, { title: 'sobra', prompt: 'x' }] }; }, { basePrompt: 'Generate variants of this screen (create 2 variants).', count: 2 });
  expect(ok).toEqual({ plans: [{ title: 'V1: Densa', prompt: 'P1' }, { title: 'V2', prompt: 'P2' }], fallback: false });
  expect(calls[0][0]).toBe(PLAN_SYSTEM);
  expect(JSON.parse(calls[0][1])).toEqual({ basePrompt: 'Generate variants of this screen (create 2 variants).', count: 2 });
  const short = await planVariants(async () => ({ variants: [{ title: 'V1', prompt: 'P1' }] }), { basePrompt: 'B', count: 2 });
  expect(short.fallback).toBe(true);
  expect(short.plans.map((p) => p.title)).toEqual(['Variante 1', 'Variante 2']);
  expect(short.plans[1].prompt).toBe('B\n\nEsta es la variante 2 de 2: explora una dirección distinta de las otras 1.');
  const failed = await planVariants(async () => { throw new Error('429'); }, { basePrompt: 'B', count: 1 });
  expect(failed).toMatchObject({ fallback: true, error: '429' });
});

test('eventos variant y preview: se validan y quedan en el estado del mensaje', () => {
  const head = { v: 1, messageId: 'm', at: 0 };
  const variant = { groupId: 'g', sourceId: 's', index: 1, count: 2, title: 'V2', prompt: 'P2' };
  const state = foldMessage([parseEvent({ ...head, seq: 0, type: 'variant', ...variant }), parseEvent({ ...head, seq: 1, type: 'preview', url: 'http://127.0.0.1:5310/' })]);
  expect(state.variant).toEqual(variant);
  expect(state.preview).toBe('http://127.0.0.1:5310/');
  expect(() => parseEvent({ ...head, seq: 0, type: 'variant', ...variant, index: 2 })).toThrow();
  expect(() => parseEvent({ ...head, seq: 0, type: 'preview', url: '' })).toThrow();
});

test('approval.decision: scope always solo acompaña a allow', () => {
  const head = { v: 1, messageId: 'm', at: 0, seq: 0, type: 'approval.decision', callId: 'c' };
  expect(parseEvent({ ...head, decision: 'allow', scope: 'always' })).toMatchObject({ scope: 'always' });
  expect(() => parseEvent({ ...head, decision: 'skip', scope: 'always' })).toThrow();
  expect(() => parseEvent({ ...head, decision: 'allow', scope: 'chat' })).toThrow();
});
