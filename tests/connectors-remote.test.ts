import { expect, test } from 'bun:test';
import { connectorsRemote } from '../src/runtime/connectors-remote';

const ENV = { WT_GATEWAY_BASE_URL: 'https://orq.test/gw/claude-code', ANTHROPIC_AUTH_TOKEN: 'run-token' };
const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

test('sin orquestador no hay conectores remotos: manda la credencial local o nada', () => {
  expect(connectorsRemote({})).toBeUndefined();
});

test('mcp pide al orquestador con el token de la corrida y solo devuelve apps pedidas; un fallo deja todas sin respuesta', async () => {
  const seen: { url: string; auth: string | null; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ apps: ['slack', 'colada'], readOnlyTools: ['mcp__slack__list', 3] })); }) as unknown as typeof fetch;
  const out = await connectorsRemote(ENV, f)!.mcp(['slack', 'gmail'], 'tok');
  expect(out).toEqual({ apps: ['slack'], readOnlyTools: ['mcp__slack__list'], failed: ['gmail'] });
  expect(seen[0]).toEqual({ url: 'https://orq.test/gw/connectors/mcp', auth: 'Bearer tok', body: { slugs: ['slack', 'gmail'] } });
  expect(await connectorsRemote(ENV, reply({}, 500))!.mcp(['slack'], 'tok')).toEqual({ apps: [], readOnlyTools: [], failed: ['slack'] });
  expect(await connectorsRemote(ENV, reply({}))!.mcp(['slack'], undefined)).toEqual({ apps: [], readOnlyTools: [], failed: ['slack'] });
});

test('forward reenvía el mensaje y valida la respuesta; un 4xx del orquestador es error, no un resultado', async () => {
  const seen: unknown[] = [];
  const f = (async (url: string, init: RequestInit) => { seen.push([url, JSON.parse(String(init.body))]); return new Response(JSON.stringify({ status: 200, text: '{}', session: 's1', extra: 'x' })); }) as unknown as typeof fetch;
  expect(await connectorsRemote(ENV, f)!.forward('slack', { method: 'tools/list' }, 's0', 'tok')).toEqual({ status: 200, text: '{}', session: 's1' });
  expect(seen[0]).toEqual(['https://orq.test/gw/connectors/forward/slack', { message: { method: 'tools/list' }, session: 's0' }]);
  await expect(connectorsRemote(ENV, reply({ code: 'not-read-only' }, 403))!.forward('slack', {}, undefined, 'tok')).rejects.toThrow();
  await expect(connectorsRemote(ENV, reply({ status: 'x' }))!.forward('slack', {}, undefined, 'tok')).rejects.toThrow();
});

test('el slug de app que acepta la VM es el mismo que acepta el orquestador: sin _ en los bordes ni doble', async () => {
  const { APP_SLUG, isAgentAppSlug } = await import('../src/runtime/connectors');
  for (const ok of ['slack', 'google_sheets', 'a1_b2']) expect([APP_SLUG.test(ok), isAgentAppSlug(ok)], ok).toEqual([true, true]);
  for (const bad of ['a_', '_a', 'a__b', 'wt', 'approval', 'A', '']) expect(isAgentAppSlug(bad), bad).toBe(false);
});
