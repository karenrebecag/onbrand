import { expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { BlobConflictError, BlobExistsError, createChatIndex, dayWindow, type BlobClient, type ChatEntry } from '../src/orchestrator/chat-index';
import { prefixedBlob } from '../src/orchestrator/prefixed-blob';
import { createOrchestrator, DEFAULT_OWNER_CAP_USD, ownerCapFromEnv, type OrchestratorDeps } from '../src/orchestrator/routes';
import { ALL_SCOPES } from '../src/runtime/session';

class MemBlob implements BlobClient {
  readonly files = new Map<string, string>();
  async read(p: string) { const t = this.files.get(p); return t === undefined ? undefined : { text: t, etag: String(t.length) }; }
  async create(p: string, b: string) { if (this.files.has(p)) throw new BlobExistsError(p); this.files.set(p, b); return { etag: String(b.length) }; }
  async replace(p: string, b: string, m: string) { const t = this.files.get(p); if (t === undefined || String(t.length) !== m) throw new BlobConflictError(p); this.files.set(p, b); return { etag: String(b.length) }; }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}

test('el contador diario cambia de blob a medianoche UTC y GET /spend dice cuándo', async () => {
  const blob = new MemBlob();
  let t = Date.UTC(2026, 10, 5, 23, 59, 0);
  const index = createChatIndex({ blob, daily: true, now: () => t });
  await index.addSpend('u', 2);
  t = Date.UTC(2026, 10, 6, 0, 1, 0);
  expect((await index.readSpend('u')).spent).toBe(0);
  await index.addSpend('u', 1);
  expect([...blob.files.keys()].sort()).toHaveLength(2);
  expect(dayWindow(t)).toEqual({ day: '2026-11-06', resetsAt: Date.UTC(2026, 10, 7) });
});

test('prefixedBlob pone el prefijo al SDK, lo quita al listar y rechaza uno que escriba fuera de su zona', async () => {
  const inner = new MemBlob();
  const b = prefixedBlob(inner, 'qa/x/');
  await b.create('chats/a.json', '{}');
  expect([...inner.files.keys()]).toEqual(['qa/x/chats/a.json']);
  expect(await b.list('chats/')).toEqual(['chats/a.json']);
  for (const bad of ['', 'qa', 'qa/../x/', '/qa/', 'QA/', 'qa//x/']) expect(() => prefixedBlob(inner, bad)).toThrow(/prefijo de blob inválido/);
});

test('el tope diario sale de WT_OWNER_CAP_USD, vale 5 sin ella y un valor roto frena el arranque', () => {
  expect(ownerCapFromEnv({})).toBe(DEFAULT_OWNER_CAP_USD);
  expect(DEFAULT_OWNER_CAP_USD).toBe(5);
  expect(ownerCapFromEnv({ WT_OWNER_CAP_USD: '12.5' })).toBe(12.5);
  for (const bad of ['abc', '-1', 'Infinity', 'NaN']) expect(() => ownerCapFromEnv({ WT_OWNER_CAP_USD: bad })).toThrow(/WT_OWNER_CAP_USD/);
});

// Hallazgos MEDIUM del security-reviewer sobre las rutas: un test por hallazgo, con un índice y una VM de mentira.
const NO_PENDING = {
  registerPending: async () => { throw new Error('sin registro'); }, readPending: async () => undefined, decidePending: async () => 'none' as const,
  takeGrant: async () => undefined, useGrant: async () => false, revertPending: async () => undefined,
};
const NO_ALWAYS = { ...NO_PENDING, readAlways: async () => [] as string[], addAlways: async () => [] as string[], removeAlways: async () => [] as string[] };
const keys = generateKeyPairSync('ed25519');
const CHAT = 'a'.repeat(26);
const entry = (owner: string): ChatEntry => ({ chatId: CHAT, owner, title: '', sandbox: { name: '' }, head: { messageId: '', commit: '' }, updatedAt: 0, spend: 0 });

function app(over: Partial<OrchestratorDeps> & { vm?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const chats = new Map<string, ChatEntry>([[CHAT, entry('u')]]);
  const forwarded: { url: string; init: RequestInit }[] = [];
  const errors: unknown[] = [];
  const handler = createOrchestrator({
    authenticate: async () => ({ owner: 'u', scopes: ALL_SCOPES }),
    index: {
      createChat: async (e) => { chats.set(e.chatId, e); return e; },
      getChat: async (owner, id) => { const c = chats.get(id); return c && c.owner === owner ? c : undefined; },
      listChats: async (owner) => [...chats.values()].filter((c) => c.owner === owner),
      ...NO_ALWAYS, readSpend: async (owner) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }),
    },
    privateKey: keys.privateKey, gateway: async () => new Response('gw'), ownerCapUsd: 5, runtimeUrl: async () => 'http://vm.test',
    onError: (e) => { errors.push(e); },
    forward: async (url, init) => { forwarded.push({ url, init }); return (over.vm ?? (async () => new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } })))(url, init); },
    ...over,
  });
  const req = (path: string, init: RequestInit = {}) => handler(new Request(`https://orq.test${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } }));
  return { req, chats, forwarded, errors };
}
const headersOf = (init: RequestInit): Headers => new Headers(init.headers);

test('un 3xx de la VM es 502 y el reenvío no sigue redirects', async () => {
  const a = app({ vm: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }) });
  const res = await a.req(`/chats/${CHAT}/runs`, { method: 'POST', body: '{"prompt":"x"}' });
  expect(res.status).toBe(502);
  expect(a.forwarded[0]!.init.redirect).toBe('manual');
  expect(res.headers.get('location')).toBeNull();
});

test('solo los tipos de la fila salen de la VM, con nosniff; HTML es 502 y text/event-stream ya no sale por events', async () => {
  const html = app({ vm: async () => new Response('<script>1</script>', { headers: { 'content-type': 'text/html' } }) });
  expect((await html.req(`/chats/${CHAT}/runs/m1/events`)).status).toBe(502);
  const sse = app({ vm: async () => new Response('data: 1\n\n', { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) });
  expect((await sse.req(`/chats/${CHAT}/runs/m1/events`)).status).toBe(502);
  const nd = app({ vm: async () => new Response('{"a":1}\n', { headers: { 'content-type': 'application/x-ndjson' } }) });
  const ok = await nd.req(`/chats/${CHAT}/runs/m1/events`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
});

test('un método fuera de la fila es 405 y una ruta fuera de la tabla 404; el token de gasto solo va en POST /runs exacto', async () => {
  const a = app();
  expect((await a.req(`/chats/${CHAT}/runs/m1/cancel`, { method: 'DELETE' })).status).toBe(405);
  expect((await a.req(`/chats/${CHAT}/runs/m1/files`, { method: 'PUT', body: '{}' })).status).toBe(405);
  expect((await a.req(`/chats/${CHAT}/runs/m1`)).status).toBe(404);
  expect(a.forwarded).toHaveLength(0);
  await a.req(`/chats/${CHAT}/runs/m1/cancel`, { method: 'POST', body: '{}', headers: { 'x-wt-run-token': 'del-cliente', 'x-wt-identity': 'del-cliente' } });
  const cancel = headersOf(a.forwarded[0]!.init);
  expect(cancel.get('x-wt-run-token')).toBeNull();
  expect(cancel.get('x-wt-identity')).not.toBe('del-cliente');
  await a.req(`/chats/${CHAT}/runs`, { method: 'POST', body: '{"prompt":"x"}', headers: { 'x-wt-run-token': 'del-cliente' } });
  const run = headersOf(a.forwarded[1]!.init);
  expect(run.get('x-wt-run-token')).toMatch(/\./);
  expect(run.get('x-wt-run-token')).not.toBe('del-cliente');
});

test('un POST sin application/json es 415 (fuerza preflight) y hacia la VM el tipo se fija', async () => {
  const a = app();
  expect((await a.req('/chats', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  expect((await a.req(`/chats/${CHAT}/runs`, { method: 'POST', body: '{}', headers: { 'content-type': 'multipart/form-data' } })).status).toBe(415);
  expect(a.forwarded).toHaveLength(0);
  await a.req(`/chats/${CHAT}/runs`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json; charset=utf-8' } });
  expect(headersOf(a.forwarded[0]!.init).get('content-type')).toBe('application/json');
});

test('un cuerpo grande es 413 por content-length y por conteo en streaming, en /chats y en runs', async () => {
  const a = app();
  const big = JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 + 1) });
  expect((await a.req('/chats', { method: 'POST', body: big })).status).toBe(413);
  expect((await a.req(`/chats/${CHAT}/runs`, { method: 'POST', body: big })).status).toBe(413);
  // Sin content-length (stream): se corta al pasar el tope sin armar el cuerpo entero.
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(256 * 1024)); } });
  const res = await a.req('/chats', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  expect(res.status).toBe(413);
  expect(a.forwarded).toHaveLength(0);
});

test('un fallo interno es 502 sin detalles y queda en el log; el índice y la VM caídos no tumban el handler', async () => {
  const boom = app({ runtimeUrl: async () => { throw new Error('secreto: blob://qa/interno'); } });
  const res = await boom.req(`/chats/${CHAT}/runs`, { method: 'POST', body: '{"prompt":"x"}' });
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain('secreto');
  expect(boom.errors).toHaveLength(1);
  const down = app({ index: { createChat: async () => { throw new Error('blob caído'); }, getChat: async () => { throw new Error('blob caído'); }, listChats: async () => { throw new Error('blob caído'); }, ...NO_ALWAYS, readSpend: async () => { throw new Error('blob caído'); } } });
  for (const [path, init] of [['/chats', {}], ['/spend', {}], [`/chats/${CHAT}/runs/m1/files`, {}]] as const) expect((await down.req(path, init)).status).toBe(502);
});

test('hay un tope de chats por dueño (409) y de altas por minuto (429)', async () => {
  const limited = app({ maxChatsPerOwner: 1 });
  expect((await limited.req('/chats', { method: 'POST', body: '{}' })).status).toBe(409);
  const fast = app();
  fast.chats.clear();
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await fast.req('/chats', { method: 'POST', body: '{}' })).status);
  expect(codes.filter((c) => c === 201)).toHaveLength(10);
  expect(codes.slice(10)).toEqual([429, 429]);
});

test('el resto de la ruta de runs solo admite segmentos [a-z0-9-]: ..%2f, %2E%2e%2F y vacíos no llegan a la VM', async () => {
  const a = app();
  for (const rest of ['/..%2f..%2fadmin', '/%2E%2e%2F', '/a%2fb', '/a//b', '/A', '/a.b', '/']) {
    expect((await a.req(`/chats/${CHAT}/runs${rest}`)).status).toBe(404);
  }
  expect(a.forwarded).toHaveLength(0);
  expect((await a.req(`/chats/${CHAT}/runs/m1-2/events`)).status).toBe(202);
  expect(a.forwarded[0]!.url).toBe('http://vm.test/runs/m1-2/events');
});

test('cada ruta pide su scope: spend para GET /spend, chat:read para listar, chat:write para crear', async () => {
  const only = (scope: 'chat:read' | 'chat:write' | 'spend') => app({ authenticate: async () => ({ owner: 'u', scopes: new Set([scope]) }) });
  const post = { method: 'POST', body: '{}' };
  const read = only('chat:read');
  expect((await read.req('/chats')).status).toBe(200);
  expect((await read.req('/spend')).status).toBe(403);
  expect((await read.req('/chats', post)).status).toBe(403);
  const spend = only('spend');
  expect((await spend.req('/spend')).status).toBe(200);
  expect((await spend.req('/chats')).status).toBe(403);
  const write = only('chat:write');
  expect((await write.req('/chats', post)).status).toBe(201);
  expect((await write.req('/spend')).status).toBe(403);
});
