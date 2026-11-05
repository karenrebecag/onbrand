import { expect, test } from 'bun:test';
import { alwaysRemote } from '../src/runtime/always-remote';
import { Approvals, type ApprovalSink } from '../src/runtime/approvals';

const IMG = 'mcp__wt__generate_image';
const ENV = { WT_GATEWAY_BASE_URL: 'https://orq.test/gw/claude-code', ANTHROPIC_AUTH_TOKEN: 'run-token' };
const ok = (tools: unknown) => (async () => new Response(JSON.stringify({ tools }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const sink = () => {
  const decisions: [string, string | undefined][] = [];
  const requests: unknown[] = [];
  const s: ApprovalSink = { request: (r) => { requests.push(r); }, decision: (_c, d, scope) => { decisions.push([d, scope]); } };
  return { s, decisions, requests };
};
const ask = (id: string) => ({ tool_name: IMG, input: { prompt: 'p' }, tool_use_id: id });

test('sin orquestador (core local) no hay consulta remota: manda el AlwaysStore de la VM', () => {
  expect(alwaysRemote({}, 'tok')).toBeUndefined();
});

test('con orquestador consulta GET /gw/always con el token de la corrida y devuelve el conjunto', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, auth: new Headers(init.headers).get('authorization') }); return new Response(JSON.stringify({ tools: [IMG, 3] })); }) as unknown as typeof fetch;
  const set = await alwaysRemote(ENV, 'run-token', f)!();
  expect([...set!]).toEqual([IMG]);
  expect(seen).toEqual([{ url: 'https://orq.test/gw/always', auth: 'Bearer run-token' }]);
});

test('cualquier fallo de la consulta es "no hay siempre" y nunca una excepción', async () => {
  const bad = [
    alwaysRemote(ENV, undefined, ok([IMG])),
    alwaysRemote({ WT_GATEWAY_BASE_URL: 'https://orq.test/otra-base' }, 'tok', ok([IMG])),
    alwaysRemote(ENV, 'tok', (async () => new Response('no', { status: 500 })) as unknown as typeof fetch),
    alwaysRemote(ENV, 'tok', (async () => { throw new Error('red'); }) as unknown as typeof fetch),
    alwaysRemote(ENV, 'tok', ok('no es lista')),
    alwaysRemote({ WT_GATEWAY_BASE_URL: 'http://orq.test/gw/claude-code' }, 'tok', ok([IMG])),
  ];
  for (const remote of bad) expect(await remote!()).toBeUndefined();
});

test('Approvals con orquestador: el índice global manda, un fallo pregunta y el almacén local no autoaprueba', async () => {
  const a = new Approvals(10_000);
  // Antes de la consulta hay un "siempre" local (otra VM de un modo anterior): con orquestador no cuenta.
  const first = a.ask('chat', 'ask', new Set(), ask('t0'), sink().s);
  expect(a.decide('chat', 't0', 'always')).toEqual({ always: IMG });
  await first;
  const withIt = sink();
  expect((await a.ask('chat', 'ask', new Set(), ask('t1'), withIt.s, undefined, false, undefined, async () => new Set([IMG]))).behavior).toBe('allow');
  expect(withIt.decisions).toEqual([['allow', 'always']]);
  const without = sink();
  const pending = a.ask('chat', 'ask', new Set(), ask('t2'), without.s, undefined, false, undefined, async () => new Set());
  await new Promise((r) => setTimeout(r, 10));
  expect(without.requests).toHaveLength(1);
  a.decide('chat', 't2', 'skip');
  expect((await pending).behavior).toBe('deny');
  const failing = sink();
  const p3 = a.ask('chat', 'ask', new Set(), ask('t3'), failing.s, undefined, false, undefined, async () => undefined);
  await new Promise((r) => setTimeout(r, 10));
  expect(failing.requests).toHaveLength(1);
  a.decide('chat', 't3', 'skip');
  await p3;
});

test('decide dice qué "siempre" guardó solo para una tool de gasto y con decisión always', async () => {
  const a = new Approvals(10_000);
  const p = a.ask('chat', 'ask', new Set(), ask('a1'), sink().s);
  expect(a.decide('chat', 'a1', 'allow')).toEqual({});
  await p;
  const q = a.ask('chat', 'ask', new Set(), { ...ask('a2'), tool_name: 'mcp__slack__send_message' }, sink().s);
  expect(a.decide('chat', 'a2', 'always')).toEqual({});
  await q;
});

test('con orquestador un "siempre" decidido no se escribe en el almacén local: la fuente es el índice global', async () => {
  const a = new Approvals(10_000);
  const first = a.ask('chat', 'ask', new Set(), ask('r0'), sink().s, undefined, false, undefined, async () => new Set());
  await new Promise((r) => setTimeout(r, 0));
  expect(a.decide('chat', 'r0', 'always')).toEqual({ always: IMG });
  await first;
  expect(a.alwaysTools()).toEqual([]);
});
