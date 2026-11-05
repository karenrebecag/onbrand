import { afterEach, expect, test } from 'bun:test';
import { agentEnv } from '../src/runtime/agent-loop';
import { assertNoKeyWithProxy, gatewayConnection, GATEWAY_BASE_URL } from '../src/runtime/gateway-auth';
import { gatewayInfer } from '../src/runtime/infer';

// docs/spec/deploy-sandbox.md §1: dentro de la VM nadie tiene la llave del Gateway. Con proxy (base + ANTHROPIC_AUTH_TOKEN) el
// CLI y los clientes del Gateway hablan con el orquestador con el token de la corrida; sin proxy todo queda como siempre.
const PROXY = 'https://orq.example/gw/claude-code';
const KEYS = { AI_GATEWAY_API_KEY: 'llave-del-gateway', VERCEL_OIDC_TOKEN: 'oidc', ANTHROPIC_API_KEY: 'sk-real' };

test('con proxy el entorno del CLI no lleva la llave: base y token de la corrida, ANTHROPIC_API_KEY vacía', () => {
  const env = agentEnv({ PATH: '/bin', ...KEYS, WT_GATEWAY_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token' });
  expect(env.ANTHROPIC_BASE_URL).toBe(PROXY);
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe('run-token');
  expect(env.ANTHROPIC_API_KEY).toBe('');
  expect(env.AI_GATEWAY_API_KEY).toBeUndefined();
  expect(env.VERCEL_OIDC_TOKEN).toBeUndefined();
  expect(Object.values(env)).not.toContain('llave-del-gateway');
  expect(Object.values(env)).not.toContain('sk-real');
  expect(env.PATH).toBe('/bin');
});

test('ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (la forma que ya lee el CLI) también enciende el proxy', () => {
  const env = agentEnv({ ...KEYS, ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token' });
  expect(env).toMatchObject({ ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token', ANTHROPIC_API_KEY: '' });
});

test('sin proxy el entorno del CLI es el de siempre, también con un ANTHROPIC_BASE_URL propio y su API key', () => {
  expect(agentEnv({ PATH: '/bin', ...KEYS })).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real' });
  expect(agentEnv({ ...KEYS, ANTHROPIC_BASE_URL: 'http://localhost:4000' })).toEqual({ ANTHROPIC_API_KEY: 'sk-real', ANTHROPIC_BASE_URL: 'http://localhost:4000' });
});

test('gatewayConnection: el proxy gana a la llave, sin proxy sigue llave u OIDC, y pedir proxy sin token no cae a la llave', () => {
  expect(gatewayConnection({ ...KEYS, WT_GATEWAY_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token' })).toEqual({ baseURL: PROXY, token: 'run-token' });
  expect(gatewayConnection({ AI_GATEWAY_API_KEY: 'k', VERCEL_OIDC_TOKEN: 'o' })).toEqual({ baseURL: GATEWAY_BASE_URL, token: 'k' });
  expect(gatewayConnection({ VERCEL_OIDC_TOKEN: 'o' })).toEqual({ baseURL: GATEWAY_BASE_URL, token: 'o' });
  expect(() => gatewayConnection({})).toThrow('falta AI_GATEWAY_API_KEY');
  expect(() => gatewayConnection({ ...KEYS, WT_GATEWAY_BASE_URL: PROXY })).toThrow('exige ANTHROPIC_AUTH_TOKEN');
  expect(() => agentEnv({ ...KEYS, WT_GATEWAY_BASE_URL: PROXY })).toThrow('exige ANTHROPIC_AUTH_TOKEN');
});

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

test('gatewayInfer con proxy pega al proxy con el token de la corrida y nunca manda la llave', async () => {
  const seen: { path: string; auth: string | null; xkey: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), xkey: req.headers.get('x-api-key') });
      return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  try {
    Object.assign(process.env, { ...KEYS, WT_GATEWAY_BASE_URL: `http://127.0.0.1:${server.port}/gw/claude-code`, ANTHROPIC_AUTH_TOKEN: 'run-token' });
    expect(await gatewayInfer()('sys', '{}')).toEqual({ ok: true });
    expect(seen).toEqual([{ path: '/gw/claude-code/v1/messages', auth: 'Bearer run-token', xkey: null }]);
  } finally {
    server.stop(true);
  }
});

test('guard de arranque: proxy + llave falla, proxy sin llave y sin proxy + llave arrancan', () => {
  const proxy = { WT_GATEWAY_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token' };
  expect(() => assertNoKeyWithProxy({ ...proxy, AI_GATEWAY_API_KEY: 'k' })).toThrow('la llave no entra en la VM');
  expect(() => assertNoKeyWithProxy({ ...proxy, VERCEL_OIDC_TOKEN: 'o' })).toThrow('VERCEL_OIDC_TOKEN');
  expect(() => assertNoKeyWithProxy({ ANTHROPIC_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'run-token', AI_GATEWAY_API_KEY: 'k' })).toThrow('AI_GATEWAY_API_KEY');
  expect(() => assertNoKeyWithProxy({ ...proxy, ANTHROPIC_API_KEY: 'sk' })).not.toThrow();
  expect(() => assertNoKeyWithProxy(proxy)).not.toThrow();
  expect(() => assertNoKeyWithProxy({ AI_GATEWAY_API_KEY: 'k' })).not.toThrow();
  expect(() => assertNoKeyWithProxy({ ANTHROPIC_BASE_URL: 'http://localhost:4000', AI_GATEWAY_API_KEY: 'k' })).not.toThrow();
});

test('la base del proxy exige https, salvo loopback: el token de la corrida no viaja en claro', () => {
  const token = { ANTHROPIC_AUTH_TOKEN: 'run-token' };
  for (const base of ['https://orq.example/gw', 'http://127.0.0.1:5300/gw', 'http://localhost:5300/gw']) expect(gatewayConnection({ WT_GATEWAY_BASE_URL: base, ...token }).baseURL).toBe(base);
  for (const base of ['http://orq.example/gw', 'http://10.0.0.5/gw', 'ftp://orq.example', 'no-es-url']) {
    expect(() => gatewayConnection({ WT_GATEWAY_BASE_URL: base, ...token })).toThrow('gateway:');
    expect(() => agentEnv({ ANTHROPIC_BASE_URL: base, ...token })).toThrow('gateway:');
  }
});

test('el token de la corrida (argumento) gana al de la VM; sin proxy se ignora y el entorno es idéntico', () => {
  const vm = { PATH: '/bin', ...KEYS, WT_GATEWAY_BASE_URL: PROXY, ANTHROPIC_AUTH_TOKEN: 'token-de-la-vm' };
  expect(agentEnv(vm, 'token-de-la-corrida').ANTHROPIC_AUTH_TOKEN).toBe('token-de-la-corrida');
  expect(agentEnv(vm).ANTHROPIC_AUTH_TOKEN).toBe('token-de-la-vm');
  expect(agentEnv({ PATH: '/bin', ...KEYS }, 'token-de-la-corrida')).toEqual(agentEnv({ PATH: '/bin', ...KEYS }));
});
