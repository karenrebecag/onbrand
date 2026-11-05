import { expect, test } from 'bun:test';
import { approvalLink } from '../src/runtime/approval-link';
import { Approvals, type ApprovalSink } from '../src/runtime/approvals';
import { connectorsRemote } from '../src/runtime/connectors-remote';

const ENV = { WT_GATEWAY_BASE_URL: 'https://orq.test/gw/claude-code', ANTHROPIC_AUTH_TOKEN: 'run-token' };
const TOOL = 'mcp__slack__send';
const sink = () => {
  const requests: unknown[] = [];
  const s: ApprovalSink = { request: (r) => { requests.push(r); }, decision: () => undefined };
  return { s, requests };
};
const ask = (id: string, tool = TOOL) => ({ tool_name: tool, input: { text: 'hola' }, tool_use_id: id });
const wait = () => new Promise((r) => setTimeout(r, 0));

test('sin orquestador no hay enlace de aprobación', () => {
  expect(approvalLink({}, 'tok')).toBeUndefined();
});

test('register y grant hablan con el orquestador con el token de la corrida y fallan cerrado', async () => {
  const seen: { url: string; auth: string | null; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ grant: 'g.1' })); }) as unknown as typeof fetch;
  const link = approvalLink(ENV, 'tok', f)!;
  expect(await link.register('c1', TOOL, { text: 'hola' })).toBe(true);
  expect(await link.grant('c1')).toBe('g.1');
  expect(seen).toEqual([
    { url: 'https://orq.test/gw/approvals/pending', auth: 'Bearer tok', body: { callId: 'c1', tool: TOOL, input: { text: 'hola' } } },
    { url: 'https://orq.test/gw/approvals/grant', auth: 'Bearer tok', body: { callId: 'c1' } },
  ]);
  const down = approvalLink(ENV, 'tok', (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch)!;
  expect(await down.register('c1', TOOL, {})).toBe(false);
  expect(await down.grant('c1')).toBeUndefined();
  expect(await approvalLink(ENV, undefined, f)!.register('c1', TOOL, {})).toBe(false); // sin token de corrida
});

test('Approvals con enlace: la tarjeta espera al registro, un registro rechazado no muestra tarjeta y el permiso se recoge una vez tras allow', async () => {
  const a = new Approvals(10_000);
  const order: string[] = [];
  const link = { register: async () => { order.push('register'); return true; }, grant: async () => { order.push('grant'); return 'g.1'; } };
  const s = sink();
  const pending = a.ask('chat', 'ask', new Set(), ask('k1'), { request: (r) => { order.push('card'); s.s.request(r); }, decision: () => undefined }, undefined, false, undefined, async () => new Set(), link);
  await wait();
  a.decide('chat', 'k1', 'allow');
  expect((await pending).behavior).toBe('allow');
  expect(order).toEqual(['register', 'card', 'grant']);
  expect(a.takeGrantFor('k1')).toBe('g.1');
  expect(a.takeGrantFor('k1')).toBeUndefined();

  const refused = sink();
  const denied = await a.ask('chat', 'ask', new Set(), ask('k2'), refused.s, undefined, false, undefined, undefined, { register: async () => false, grant: async () => 'x' });
  expect(denied.behavior).toBe('deny');
  expect(refused.requests).toHaveLength(0);

  const skipped = a.ask('chat', 'ask', new Set(), ask('k3'), sink().s, undefined, false, undefined, undefined, link);
  await wait();
  a.decide('chat', 'k3', 'skip');
  expect((await skipped).behavior).toBe('deny');
  expect(a.takeGrantFor('k3')).toBeUndefined();
});

test('connectors-remote.forward manda el permiso de la llamada (callId y grant) al orquestador', async () => {
  const seen: unknown[] = [];
  const f = (async (_u: string, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ status: 200, text: '{}' })); }) as unknown as typeof fetch;
  await connectorsRemote(ENV, f)!.forward('slack', { method: 'tools/call' }, 's0', 'tok', { callId: 'k1', grant: 'g.1' });
  expect(seen[0]).toEqual({ message: { method: 'tools/call' }, session: 's0', callId: 'k1', grant: 'g.1' });
});
