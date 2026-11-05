import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { checkPriceOfContract, createGatewayProxy, runTokenVerifier, type GatewayProxyDeps, type PricedUsage } from '../src/orchestrator/gateway-proxy';
import { issueIdentity, issueRunToken } from '../src/orchestrator/identity';
import { ALL_SCOPES } from '../src/runtime/session';
import type { TokenUsage } from '../src/orchestrator/chat-index';

// deploy-sandbox.md §1: el proxy verifica el token, comprueba el tope, reenvía con la credencial del orquestador y suma el gasto.
const keys = generateKeyPairSync('ed25519');
const NOW = 5_000_000;
const MAX_RUN = 60 * 60_000;
const token = issueRunToken(keys.privateKey, 'user_1', 'chat-a', '', 60_000, MAX_RUN, () => NOW);
const URL_ = 'https://orq.test/gw/claude-code/v1/messages';

interface Rig {
  readonly proxy: (req: Request) => Promise<Response>;
  readonly upstreamCalls: { url: string; headers: Headers }[];
  readonly priced: PricedUsage[];
  readonly errors: unknown[];
  readonly ledger: { total: number; reserves: number[]; releases: number[] };
  readonly spends: { owner: string; usd: number; model: string; usage: TokenUsage }[];
  readonly adjustDays: (string | undefined)[];
}

function rig(opts: { spent?: number; respond?: () => Response; cap?: number; waitUntil?: (p: Promise<unknown>) => void; addDelayMs?: number; failAdds?: { n: number }; maxBodyBytes?: number; deadlineMs?: number; throwingOnError?: boolean; upstreamThrows?: boolean; onUpstream?: () => void; ambiguous?: { n: number }; clock?: { t: number }; scheduled?: number[]; credentialThrows?: boolean } = {}): Rig {
  const upstreamCalls: Rig['upstreamCalls'] = [];
  const spends: Rig['spends'] = [];
  const priced: PricedUsage[] = [];
  const errors: unknown[] = [];
  const adjustDays: (string | undefined)[] = [];
  const ledger = { total: opts.spent ?? 0, reserves: [] as number[], releases: [] as number[] };
  const appliedIds = new Set<string>();
  const delay = () => (opts.addDelayMs ? new Promise((r) => setTimeout(r, opts.addDelayMs)) : undefined);
  const deps: GatewayProxyDeps = {
    verify: runTokenVerifier(keys.publicKey, MAX_RUN, () => NOW),
    index: {
      readSpend: async (owner) => ({ owner, spent: ledger.total, byModel: {}, applied: [], updatedAt: 0 }),
      reserveSpend: async (owner, usd, cap) => { await delay(); const counter = { owner, spent: ledger.total, byModel: {}, applied: [], updatedAt: 0 }; if (ledger.total + usd > cap) return { ok: false, counter }; ledger.total += usd; ledger.reserves.push(usd); return { ok: true, counter: { ...counter, spent: ledger.total }, day: '2026-11-05' }; },
      adjustSpend: async (owner, delta, t, opId, day) => {
        adjustDays.push(day);
        if (opts.failAdds && opts.failAdds.n-- > 0) throw new Error('contención');
        await delay();
        if (opId && appliedIds.has(opId)) return { owner, spent: ledger.total, byModel: {}, applied: [], updatedAt: 0 };
        if (opId) appliedIds.add(opId);
        ledger.total += delta;
        if (t) spends.push({ owner, usd: delta + (ledger.reserves.at(-1) ?? 0), model: t.model, usage: t.usage });
        else ledger.releases.push(delta);
        if (opts.ambiguous && opts.ambiguous.n-- > 0) throw new Error('timeout tras aplicar');
        return { owner, spent: ledger.total, byModel: {}, applied: [], updatedAt: 0 };
      },
    },
    caps: { owner: opts.cap ?? 1e9 },
    waitUntil: opts.waitUntil ?? (() => undefined),
    priceOf: (_m, u) => (priced.push(u), 0) + u.input * 1 + u.output * 10 + u.cache_creation_input * 2 + u.cache_read_input * 0.5,
    onError: (e) => { errors.push(e); if (opts.throwingOnError) throw new Error('onError roto'); },
    ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}),
    sleep: async () => undefined,
    spendAttempts: 2,
    ...(opts.clock ? { now: () => opts.clock!.t } : {}),
    ...(opts.scheduled ? { schedule: (_fn: () => void, ms: number) => { opts.scheduled!.push(ms); return () => undefined; } } : {}),
    credential: async () => { if (opts.credentialThrows) throw new Error('oidc'); return 'Bearer ORQ-OIDC'; },
    upstream: async (url, init) => { upstreamCalls.push({ url, headers: new Headers(init.headers) }); opts.onUpstream?.(); if (opts.upstreamThrows) throw new Error('conexión'); return (opts.respond ?? json)(); },
  };
  return { proxy: createGatewayProxy(deps), upstreamCalls, spends, priced, errors, ledger, adjustDays };
}

const json = (): Response => new Response(JSON.stringify({ model: 'm', usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
const post = (t: string | undefined, extra: Record<string, string> = {}, url = URL_) => new Request(url, { method: 'POST', headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), 'content-type': 'application/json', ...extra }, body: '{"model":"m"}' });
const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const START = ev('message_start', { message: { model: 'm', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 1 } } });
const sse = (chunks: string[], hang = false): Response => {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) { c.enqueue(new TextEncoder().encode(chunks[i++])); return; }
      if (!hang) c.close();
      else return new Promise(() => undefined);
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

test('un token de identidad (typ cruzado) o sin token es 401 y no llega nada al upstream', async () => {
  const r = rig();
  const identity = issueIdentity(keys.privateKey, { owner: 'user_1', scopes: ALL_SCOPES }, 'chat-a', 60_000, () => NOW);
  for (const t of [identity, undefined, 'basura']) {
    const res = await r.proxy(post(t));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('authentication_error');
  }
  expect(r.upstreamCalls).toHaveLength(0);
});

test('sobre el tope: 429 con x-should-retry false, formato de error de la API y cero llamadas upstream', async () => {
  const r = rig({ spent: 10, cap: 10 });
  const res = await r.proxy(post(token));
  expect(res.status).toBe(429);
  expect(res.headers.get('x-should-retry')).toBe('false');
  expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
  expect(r.upstreamCalls).toHaveLength(0);
});

test('HEAD /api/hello es 404 sin token; otras rutas tampoco se reenvían', async () => {
  const r = rig();
  expect((await r.proxy(new Request('https://orq.test/gw/claude-code/api/hello', { method: 'HEAD' }))).status).toBe(404);
  expect((await r.proxy(new Request('https://orq.test/gw/claude-code/v1/other', { method: 'POST', headers: { authorization: `Bearer ${token}` } }))).status).toBe(404);
  expect(r.upstreamCalls).toHaveLength(0);
});

test('la credencial del cliente no sube: upstream recibe la del orquestador y solo los headers permitidos', async () => {
  const r = rig();
  const res = await r.proxy(post(token, { 'x-api-key': 'sk-cliente', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'b1', 'x-session-id': 's1', cookie: 'c=1' }));
  expect(res.status).toBe(200);
  const call = r.upstreamCalls[0]!;
  expect(call.url).toBe('https://ai-gateway.vercel.sh/v1/messages');
  expect(call.headers.get('authorization')).toBe('Bearer ORQ-OIDC');
  expect(call.headers.get('x-api-key')).toBeNull();
  expect(call.headers.get('cookie')).toBeNull();
  expect([call.headers.get('anthropic-version'), call.headers.get('anthropic-beta'), call.headers.get('x-session-id')]).toEqual(['2023-06-01', 'b1', 's1']);
});

test('respuesta JSON: suma body.usage una vez, con los cache_* aparte', async () => {
  const r = rig();
  await (await r.proxy(post(token))).text();
  expect(r.spends).toEqual([{ owner: 'user_1', usd: 3 + 20 + 2 + 2, model: 'm', usage: { input: 3, output: 2, cache_creation_input: 1, cache_read_input: 4 } }]);
});

test('stream: input + cachés de message_start y el ÚLTIMO output acumulado, sumado una sola vez, aunque el evento parta en chunks', async () => {
  const delta = (n: number) => ev('message_delta', { usage: { output_tokens: n } });
  const full = START + delta(5) + delta(40) + ev('message_stop', {});
  const cut = full.indexOf('"output_tokens":40') + 3;
  const r = rig({ respond: () => sse([full.slice(0, cut), full.slice(cut)]) });
  const res = await r.proxy(post(token));
  expect(await res.text()).toBe(full);
  expect(r.spends).toEqual([{ owner: 'user_1', usd: 100 + 400 + 20 + 10, model: 'm', usage: { input: 100, output: 40, cache_creation_input: 10, cache_read_input: 20 } }]);
});

const delta = (n: number) => ev('message_delta', { usage: { output_tokens: n } });
const STOP = ev('message_stop', {});

test('abort a mitad del stream: se drena el upstream y se suma el usage REAL, no lo último visto', async () => {
  const registered: Promise<unknown>[] = [];
  const r = rig({ waitUntil: (p) => registered.push(p), respond: () => sse([START, delta(7), delta(30), STOP]) });
  const reader = (await r.proxy(post(token))).body!.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.all(registered);
  expect(r.spends).toHaveLength(1);
  expect(r.spends[0]!.usage).toEqual({ input: 100, output: 30, cache_creation_input: 10, cache_read_input: 20 });
});

test('HIGH: abortar antes de leer nada (antes de message_start) igual cobra el usage real', async () => {
  const registered: Promise<unknown>[] = [];
  const r = rig({ waitUntil: (p) => registered.push(p), addDelayMs: 20, respond: () => sse([START, delta(9), STOP]) });
  const res = await r.proxy(post(token));
  await res.body!.cancel();
  expect(registered.length).toBeGreaterThan(0);
  await Promise.all(registered);
  expect(r.spends).toHaveLength(1);
  expect(r.spends[0]!.usd).toBeGreaterThan(0);
  expect(r.spends[0]!.usage.output).toBe(9);
});

test('HIGH: si el upstream corta sin usage, se cobra la estimación (bytes/3 de entrada y max_tokens de salida), no cero', async () => {
  const body = JSON.stringify({ model: 'm', max_tokens: 4000, messages: [{ role: 'user', content: 'x'.repeat(3000) }] });
  const broken = () => new Response(new ReadableStream({ pull(c) { c.error(new Error('reset')); } }), { headers: { 'content-type': 'text/event-stream' } });
  const r = rig({ respond: broken });
  const res = await r.proxy(new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body }));
  await res.text().catch(() => undefined);
  expect(r.spends).toHaveLength(1);
  expect(r.spends[0]!.usage.output).toBe(4000);
  expect(r.spends[0]!.usage.input).toBe(Math.ceil(new TextEncoder().encode(body).byteLength / 3));
});

test('MEDIUM: message_delta pisa input, cachés y server_tool_use con el acumulado, y priceOf los recibe', async () => {
  const r = rig({ respond: () => sse([START, ev('message_delta', { usage: { output_tokens: 5, input_tokens: 150, cache_read_input_tokens: 25, server_tool_use: { web_search_requests: 2 } } }), STOP]) });
  await (await r.proxy(post(token))).text();
  expect(r.spends[0]!.usage).toEqual({ input: 150, output: 5, cache_creation_input: 10, cache_read_input: 25 });
  expect(r.priced.at(-1)!.server_tool_use).toEqual({ web_search_requests: 2 });
});

test('MEDIUM: caps.owner NaN, undefined o negativo no arranca el proxy', () => {
  const base = rig();
  void base;
  for (const bad of [Number.NaN, undefined as unknown as number, -1, Number.POSITIVE_INFINITY]) {
    expect(() => createGatewayProxy({ ...({} as GatewayProxyDeps), caps: { owner: bad } })).toThrow('caps.owner');
  }
});

test('MEDIUM: si addSpend agota reintentos el dueño queda bloqueado (429) hasta que el gasto pendiente se registre', async () => {
  const fails = { n: 2 };
  const r = rig({ failAdds: fails });
  await (await r.proxy(post(token))).text();
  expect(r.errors.length).toBeGreaterThan(0);
  expect(r.spends).toHaveLength(0);
  fails.n = 2;
  const blocked = await r.proxy(post(token));
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('x-should-retry')).toBe('false');
  expect(r.upstreamCalls).toHaveLength(1);
  const ok = await r.proxy(post(token));
  expect(ok.status).toBe(200);
  expect(r.spends).toHaveLength(2);
});

test('MEDIUM: contrato de priceOf: desconocido nunca más barato que un modelo conocido', () => {
  const price = (m: string, u: PricedUsage) => (m === 'cheap' ? 1 : 5) * (u.input + u.output);
  expect(() => checkPriceOfContract(price, ['cheap', 'big'])).not.toThrow();
  expect(() => checkPriceOfContract((m, u) => (m === 'unknown' ? 0 : u.input), ['big'])).toThrow('desconocido');
  expect(() => checkPriceOfContract(() => Number.NaN, [])).toThrow();
});

test('LOW: de la query solo sube beta=true', async () => {
  const r = rig();
  await r.proxy(post(token, {}, `${URL_}?beta=true&x=1&key=zzz`));
  await r.proxy(post(token, {}, `${URL_}?x=1`));
  expect(r.upstreamCalls.map((c) => c.url)).toEqual(['https://ai-gateway.vercel.sh/v1/messages?beta=true', 'https://ai-gateway.vercel.sh/v1/messages']);
});

test('un upstream con error no suma gasto y pasa el status', async () => {
  const r = rig({ respond: () => new Response('{"type":"error"}', { status: 529, headers: { 'content-type': 'application/json' } }) });
  expect((await r.proxy(post(token))).status).toBe(529);
  expect(r.spends).toHaveLength(0);
});

test('token vencido o con vida mayor al tope de corrida es 401', async () => {
  const r = rig();
  const old = issueRunToken(keys.privateKey, 'user_1', 'chat-a', '', 1_000, MAX_RUN, () => NOW - 5_000);
  expect((await r.proxy(post(old))).status).toBe(401);
  const long = issueRunToken(keys.privateKey, 'user_1', 'chat-a', '', MAX_RUN, MAX_RUN, () => NOW);
  const strict = createGatewayProxy({ ...({} as GatewayProxyDeps), waitUntil: () => undefined, verify: runTokenVerifier(keys.publicKey, MAX_RUN - 1, () => NOW), index: { readSpend: async () => { throw new Error('no debe llegar'); }, reserveSpend: async () => { throw new Error('no'); } } as unknown as GatewayProxyDeps['index'], caps: { owner: 1 } });
  expect((await strict(post(long))).status).toBe(401);
});

test('cierre normal: el gasto ya está sumado cuando el stream termina, y también se registra en waitUntil', async () => {
  const registered: Promise<unknown>[] = [];
  const r = rig({ waitUntil: (p) => registered.push(p), addDelayMs: 20, respond: () => sse([START, delta(3), STOP]) });
  const res = await r.proxy(post(token));
  await res.text();
  expect(r.spends).toHaveLength(1);
  expect(registered).toHaveLength(1);
});

test('la query (?beta=true) llega al upstream y count_tokens pasa con el mismo token, sin sumar gasto ni mirar el tope', async () => {
  const r = rig({ spent: 10, cap: 10, respond: () => Response.json({ input_tokens: 9 }) });
  const res = await r.proxy(post(token, {}, `${URL_}/count_tokens?beta=true`));
  expect(res.status).toBe(200);
  expect(r.upstreamCalls[0]!.url).toBe('https://ai-gateway.vercel.sh/v1/messages/count_tokens?beta=true');
  expect(r.upstreamCalls[0]!.headers.get('authorization')).toBe('Bearer ORQ-OIDC');
  expect(r.spends).toHaveLength(0);
  expect((await r.proxy(post(undefined, {}, `${URL_}/count_tokens?beta=true`))).status).toBe(401);
  const ok = rig();
  await ok.proxy(post(token, {}, `${URL_}?beta=true`));
  expect(ok.upstreamCalls[0]!.url).toBe('https://ai-gateway.vercel.sh/v1/messages?beta=true');
});

test('HIGH: dos requests JSON en paralelo del mismo dueño con addSpend lento registran los DOS gastos', async () => {
  const r = rig({ addDelayMs: 30, cap: 1000 });
  const [a, b] = await Promise.all([r.proxy(post(token)), r.proxy(post(token))]);
  await Promise.all([a.text(), b.text()]);
  expect(r.spends).toHaveLength(2);
  expect(r.ledger.total).toBe(27 * 2);
});

test('HIGH: la reserva se cobra antes de reenviar (visible en readSpend) y se ajusta al usage real', async () => {
  let during = -1;
  let r!: Rig;
  r = rig({ onUpstream: () => { during = r.ledger.total; } });
  await (await r.proxy(post(token))).text();
  expect(during).toBe(5);
  expect(r.ledger.total).toBe(27);
});

test('HIGH: un upstream que rechaza devuelve la reserva; uno que no responde (502) la deja cobrada', async () => {
  const rejected = rig({ respond: () => new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }) });
  expect((await rejected.proxy(post(token))).status).toBe(400);
  expect(rejected.ledger.total).toBe(0);
  const down = rig({ upstreamThrows: true });
  expect((await down.proxy(post(token))).status).toBe(502);
  expect(down.ledger.total).toBe(5);
});

test('HIGH: el deadline cierra la cuenta con lo visto aunque el upstream no termine', async () => {
  const registered: Promise<unknown>[] = [];
  const r = rig({ deadlineMs: 30, waitUntil: (p) => registered.push(p), respond: () => sse([START], true) });
  const res = await r.proxy(post(token));
  const reader = res.body!.getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await Promise.all(registered);
  expect(r.spends).toHaveLength(1);
  expect(r.spends[0]!.usage).toMatchObject({ input: 100, cache_creation_input: 10, cache_read_input: 20 });
});

test('MEDIUM: el body se corta al pasar el tope sin leerlo entero y no se reenvía', async () => {
  const r = rig({ maxBodyBytes: 100 });
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(60)); } });
  const res = await r.proxy(new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body, duplex: 'half' } as RequestInit));
  expect(res.status).toBe(413);
  expect(pulled).toBeLessThan(5);
  expect(r.upstreamCalls).toHaveLength(0);
  expect(r.ledger.total).toBe(0);
});

test('LOW: un onError que lanza no deja trabada la cuenta del dueño', async () => {
  const fails = { n: 2 };
  const r = rig({ failAdds: fails, throwingOnError: true });
  await (await r.proxy(post(token))).text();
  expect(await (await r.proxy(post(token))).status).toBe(200);
  expect(r.spends).toHaveLength(2);
});

test('M1: un reintento tras un error ambiguo (el write sí se aplicó) no repite el delta', async () => {
  const r = rig({ ambiguous: { n: 1 } });
  await (await r.proxy(post(token))).text();
  expect(r.ledger.total).toBe(27);
  expect(r.spends).toHaveLength(1);
});

test('M2: el deadline cuenta desde que entró la request, no desde que se armó el settler', async () => {
  const clock = { t: 1_000 };
  const scheduled: number[] = [];
  const r = rig({ clock, scheduled, deadlineMs: 100, onUpstream: () => { clock.t += 60; }, respond: () => sse([START, delta(2), STOP]) });
  await (await r.proxy(post(token))).text();
  expect(scheduled).toEqual([40]);
});

test('LOW: si credential() lanza tras reservar, 502 y la reserva queda cobrada', async () => {
  const r = rig({ credentialThrows: true });
  expect((await r.proxy(post(token))).status).toBe(502);
  expect(r.upstreamCalls).toHaveLength(0);
  expect(r.ledger.total).toBe(5);
});

test('createGatewayProxy exige waitUntil: sin él el gasto se perdería en silencio en una Function', () => {
  expect(() => createGatewayProxy({ ...({} as GatewayProxyDeps), caps: { owner: 1 } })).toThrow('waitUntil');
});

test('HIGH: una llamada cuya reserva no cabe en el tope restante es 429 sin upstream ni cobro, aunque el dueño esté en cero', async () => {
  const r = rig({ cap: 100 });
  const res = await r.proxy(new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"model":"m","max_tokens":50}' }));
  expect(res.status).toBe(429);
  expect(r.upstreamCalls).toHaveLength(0);
  expect(r.ledger.total).toBe(0);
});

test('HIGH: max_tokens por encima del tope por llamada es 400 antes de reservar', async () => {
  const r = rig();
  const res = await r.proxy(new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"model":"m","max_tokens":16001}' }));
  expect(res.status).toBe(400);
  expect(r.upstreamCalls).toHaveLength(0);
  expect(r.ledger.reserves).toHaveLength(0);
});

test('el tope por llamada es 16 000: justo en el tope se reserva y se reenvía', async () => {
  const r = rig();
  const res = await r.proxy(new Request(URL_, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"model":"m","max_tokens":16000}' }));
  expect(res.status).toBe(200);
  expect(r.ledger.reserves).toHaveLength(1);
});

test('la liquidación y la liberación de una reserva viajan con el día en que se reservó', async () => {
  const ok = rig();
  const res = await ok.proxy(post(token));
  await res.text();
  expect(ok.adjustDays).toEqual(['2026-11-05']);
  // El upstream rechaza sin generar: la reserva se devuelve contra el mismo día.
  const rejected = rig({ respond: () => new Response('{}', { status: 400 }) });
  await rejected.proxy(post(token));
  expect(rejected.ledger.releases).toHaveLength(1);
  expect(rejected.adjustDays).toEqual(['2026-11-05']);
});
