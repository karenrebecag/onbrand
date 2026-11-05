// docs/estandares.md A2: el "siempre" de la tarjeta de gasto es de (dueño, tool) (#647, approvals-always.ts). El que
// concede X no aprueba las llamadas de Y, y sí las de otro chat del mismo X: un "siempre" sin dueño volvería a
// aprobar a cualquiera, y uno por chat dejaría de valer "para cualquier chat" (Lovable :4855-4859).
import { expect, test } from 'bun:test';
import { Approvals, type ApprovalSink } from '../src/runtime/approvals';
import type { ApprovalDecision, ApprovalRequest } from '../src/runtime/events';

const IMG = 'mcp__wt__generate_image';
const OWNERS: Readonly<Record<string, string>> = { 'chat-x': 'X', 'chat-x2': 'X', 'chat-y': 'Y' };
const ownerOf = (chat: string): string => OWNERS[chat] ?? 'nadie';
const ask = (id: string) => ({ tool_name: IMG, input: { prompt: 'p', target_path: '/images/a.jpg' }, tool_use_id: id });
const sink = () => {
  const requests: ApprovalRequest[] = [];
  const decisions: ApprovalDecision[] = [];
  const s: ApprovalSink = { request: (r) => { requests.push(r); }, decision: (_c, d) => { decisions.push(d); } };
  return { s, requests, decisions };
};

test('el "siempre" de X no aprueba la llamada de Y, y sí la de otro chat de X', async () => {
  const approvals = new Approvals(10_000, undefined, ownerOf);
  const x = approvals.ask('chat-x', 'ask', new Set(), ask('x1'), sink().s);
  approvals.decide('chat-x', 'x1', 'always');
  await x;

  const y = sink();
  const pending = approvals.ask('chat-y', 'ask', new Set(), ask('y1'), y.s);
  // Nadie decidió por Y: su tarjeta queda pendiente en vez de salir aprobada con el "siempre" de X.
  expect(y.requests.map((r) => r.callId)).toEqual(['y1']);
  expect(y.decisions).toEqual([]);
  approvals.decide('chat-y', 'y1', 'skip');
  expect(await pending).toMatchObject({ behavior: 'deny' });

  const x2 = sink();
  expect(await approvals.ask('chat-x2', 'ask', new Set(), ask('x2'), x2.s)).toMatchObject({ behavior: 'allow' });
  expect(x2.decisions).toEqual(['allow']);
});
