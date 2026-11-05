import { SPEND_TOOLS } from '../src/runtime/approvals';
import { expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { BlobConflictError, BlobExistsError, createChatIndex, type BlobClient, type ChatEntry } from '../src/orchestrator/chat-index';
import { issueIdentity, issueMediaToken, issueRunToken } from '../src/orchestrator/identity';
import { GW_ROUTES, IMAGE_TYPES, matchGw, matchRoute, ROUTES, UPLOAD_MAX_BYTES, vmPath, type Route } from '../src/orchestrator/route-table';
import { createOrchestrator } from '../src/orchestrator/routes';
import type { Scope, Session } from '../src/runtime/session';
import { verify as verifyToken } from '../src/signed-token';

// Spec orquestador-enrutamiento §3: cada fila de la allowlist se prueba contra el orquestador real con una VM de mentira.
const NO_PENDING = {
  registerPending: async () => { throw new Error('sin registro'); }, readPending: async () => undefined, decidePending: async () => 'none' as const,
  takeGrant: async () => undefined, useGrant: async () => false, revertPending: async () => undefined,
};
const NO_ALWAYS = { ...NO_PENDING, readAlways: async () => [] as string[], addAlways: async () => [] as string[], removeAlways: async () => [] as string[] };
const keys = generateKeyPairSync('ed25519');
const CHAT = 'a'.repeat(26);
class MemBlob implements BlobClient {
  private files = new Map<string, { text: string; etag: number }>();
  private seq = 0;
  async read(p: string) { const h = this.files.get(p); return h ? { text: h.text, etag: `e${h.etag}` } : undefined; }
  async create(p: string, body: string) { if (this.files.has(p)) throw new BlobExistsError(p); this.files.set(p, { text: body, etag: ++this.seq }); return { etag: `e${this.seq}` }; }
  async replace(p: string, body: string, ifMatch: string) { const h = this.files.get(p); if (!h || `e${h.etag}` !== ifMatch) throw new BlobConflictError(p); this.files.set(p, { text: body, etag: ++this.seq }); return { etag: `e${this.seq}` }; }
  async list(prefix: string) { return [...this.files.keys()].filter((k) => k.startsWith(prefix)); }
}
const entry = (owner: string): ChatEntry => ({ chatId: CHAT, owner, title: '', sandbox: { name: '' }, head: { messageId: '', commit: '' }, updatedAt: 0, spend: 0 });
const ALL: readonly Scope[] = ['chat:read', 'chat:write', 'spend', 'brand:write'];
const PARAMS: Record<string, string> = { m: 'm1', g: 'g1', file: 'a.png', name: 'a.png', callId: 'c1', id: 'b1', tool: 'Bash' };

function rig(scopes: readonly Scope[] = ALL, vm?: (url: string, init: RequestInit) => Response, over: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
  const forwarded: { url: string; init: RequestInit }[] = [];
  const always = new Map<string, Set<string>>();
  const real = createChatIndex({ blob: new MemBlob() });
  let woke = 0;
  const handler = createOrchestrator({
    authenticate: async (): Promise<Session> => ({ owner: 'u', scopes: new Set(scopes) }),
    index: {
      createChat: async (e) => e,
      getChat: async (owner, id) => (owner === 'u' && id === CHAT ? entry('u') : undefined),
      listChats: async () => [],
      registerPending: real.registerPending, readPending: real.readPending, decidePending: real.decidePending, takeGrant: real.takeGrant, useGrant: real.useGrant, revertPending: real.revertPending,
      readAlways: async (o) => [...(always.get(o) ?? [])].sort(), addAlways: async (o, t) => { always.set(o, (always.get(o) ?? new Set<string>()).add(t)); return [...always.get(o)!]; }, removeAlways: async (o, t) => { always.get(o)?.delete(t); return [...(always.get(o) ?? [])]; },
      readSpend: async (owner) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }),
    },
    privateKey: keys.privateKey, gateway: async () => new Response('gw'), ownerCapUsd: 5,
    runtimeUrl: async () => { woke++; return 'http://vm.test'; },
    onError: (e) => { if (process.env.DBG) console.error("ERR", e instanceof Error ? e.stack?.split("\n").slice(0, 4).join(" | ") : e); },
    forward: async (url, init) => { forwarded.push({ url, init }); return vm ? vm(url, init) : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); },
    ...over,
  });
  return { handler, forwarded, always, woke: () => woke };
}

const pathOf = (r: Route): string => `/chats/${CHAT}${r.path.split('/').map((s) => (s.startsWith(':') ? PARAMS[s.slice(1)]! : s)).join('/')}`;
function requestFor(r: Route, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  let body: BodyInit | undefined;
  if (r.body === 'json') { headers['content-type'] = 'application/json'; body = r.runToken ? '{"prompt":"x"}' : '{}'; }
  else if (r.body === 'none' && r.method !== 'GET') headers['content-type'] = 'application/json';
  else if (r.body === 'multipart') { headers['content-type'] = 'multipart/form-data; boundary=xyz'; headers['x-wt-request'] = '1'; body = '--xyz--'; }
  else if (r.body === 'image') { headers['content-type'] = 'image/png'; body = new Uint8Array([137, 80, 78, 71]); }
  return new Request(`https://orq.test${pathOf(r)}${r.query ? `?${r.query[0]}=v` : ''}`, { method: r.method, headers, ...(body === undefined ? {} : { body }) });
}
const responseFor = (r: Route): Response => new Response('{}', { headers: { 'content-type': r.types?.[0] ?? 'application/json' } });

const SPEND_TOOL = [...SPEND_TOOLS][0]!;
const asJson = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('GET y DELETE /approvals/always son del dueño: sin VM, con su scope, idempotentes, y un nombre que no es de tool es 400', async () => {
  const t = rig();
  t.always.set('u', new Set([SPEND_TOOL]));
  t.always.set('otro', new Set(['mcp__x__y']));
  expect(await (await t.handler(new Request('https://orq.test/approvals/always'))).json()).toEqual({ tools: [SPEND_TOOL] });
  expect((await t.handler(new Request(`https://orq.test/approvals/always/${SPEND_TOOL}`, { method: 'DELETE' }))).status).toBe(204);
  expect((await t.handler(new Request(`https://orq.test/approvals/always/${SPEND_TOOL}`, { method: 'DELETE' }))).status).toBe(204);
  expect(await (await t.handler(new Request('https://orq.test/approvals/always'))).json()).toEqual({ tools: [] });
  expect([...t.always.get('otro')!]).toEqual(['mcp__x__y']);
  expect((await t.handler(new Request('https://orq.test/approvals/always/Bash', { method: 'DELETE' }))).status).toBe(400);
  expect((await t.handler(new Request('https://orq.test/approvals/always', { method: 'POST', body: '{}' }))).status).toBe(405);
  expect((await t.handler(new Request(`https://orq.test/approvals/always/${SPEND_TOOL}`))).status).toBe(405);
  expect(t.woke()).toBe(0);
  const readOnly = rig(['chat:read']);
  expect((await readOnly.handler(new Request(`https://orq.test/approvals/always/${SPEND_TOOL}`, { method: 'DELETE' }))).status).toBe(403);
  const writeOnly = rig(['chat:write']);
  expect((await writeOnly.handler(new Request('https://orq.test/approvals/always'))).status).toBe(403);
});

test('GET /gw/always: la VM pregunta con el token de la corrida y solo ve el "siempre" del dueño del token', async () => {
  const t = rig();
  t.always.set('u', new Set([SPEND_TOOL]));
  t.always.set('otro', new Set(['mcp__x__y']));
  const ask = (token?: string) => t.handler(new Request('https://orq.test/gw/always', { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const run = issueRunToken(keys.privateKey, 'u', CHAT, '', 60_000, 3_600_000);
  expect(await (await ask(run)).json()).toEqual({ tools: [SPEND_TOOL] });
  expect((await ask()).status).toBe(401);
  expect((await ask('basura')).status).toBe(401);
  // Un token de otro tipo (media, identity) no vale para esto.
  expect((await ask(issueMediaToken(keys.privateKey, 'u', CHAT, 'runs/m1/shots/a.png'))).status).toBe(401);
  expect((await ask(issueIdentity(keys.privateKey, { owner: 'u', scopes: new Set<Scope>(ALL) }, CHAT, 60_000))).status).toBe(401);
  expect((await t.handler(new Request('https://orq.test/gw/always', { method: 'POST' }))).status).not.toBe(200);
});

test('un stream sin cursor (prompt-enhancements) se corta con error, no con un fin limpio que haría pasar texto truncado por completo', async () => {
  const endless = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('Mejora de')); } }), { headers: { 'content-type': 'text/plain' } });
  const t = rig(ALL, endless, { streamMaxMs: 30 });
  const res = await t.handler(new Request(`https://orq.test/chats/${CHAT}/prompt-enhancements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x"}' }));
  await expect(res.text()).rejects.toThrow();
});

test('sin el scope de la fila es 403 y la VM no se despierta; con un chat ajeno es 404 igual que uno inexistente', async () => {
  for (const r of ROUTES) {
    for (const missing of r.scopes) {
      const t = rig(ALL.filter((s) => s !== missing));
      expect((await t.handler(requestFor(r))).status, `${r.method} ${r.path} sin ${missing}`).toBe(403);
      expect(t.woke()).toBe(0);
    }
  }
  const t = rig();
  const foreign = await t.handler(new Request(`https://orq.test/chats/${'b'.repeat(26)}/runs/m1/files`));
  expect(foreign.status).toBe(404);
  expect(t.woke()).toBe(0);
});

test('lo que no está en la tabla es 404 y un método fuera de la fila es 405, sin despertar la VM', async () => {
  const t = rig();
  const outside = ['/runs/m1', '/runs/m1/tree', '/runs/m1/file', '/approval-requests', '/mcp/x', '/connector-mcp', '/plans', '/runs/m1/sections/s/suggestions',
    '/runs/..%2f..%2fadmin', '/runs/%2E%2e%2F', '/runs/a%2fb', '/runs//files', '/runs/M1/files', '/canvas/files/..', '/canvas/files/a%2fb', '/canvas/files/', '/'];
  for (const p of outside) expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}${p}`))).status, p).toBe(404);
  for (const [method, p] of [['DELETE', '/runs/m1/files'], ['PUT', '/runs'], ['GET', '/runs'], ['POST', '/canvas'], ['PATCH', '/canvas'], ['POST', '/brands']] as const) {
    const res = await t.handler(new Request(`https://orq.test/chats/${CHAT}${p}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) }));
    expect(res.status, `${method} ${p}`).toBe(405);
  }
  expect(t.forwarded).toHaveLength(0);
  expect(t.woke()).toBe(0);
});

test('una escritura con el tipo de cuerpo equivocado o sin x-wt-request se rechaza antes de despertar la VM', async () => {
  const t = rig();
  const base = `https://orq.test/chats/${CHAT}`;
  const post = (path: string, headers: Record<string, string>, body: BodyInit = '{}') => t.handler(new Request(`${base}${path}`, { method: 'POST', headers, body }));
  expect((await post('/runs/m1/cancel', { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await post('/uploads', { 'content-type': 'application/json' })).status).toBe(415);
  expect((await post('/uploads', { 'content-type': 'multipart/form-data; boundary=xyz' }, '--xyz--')).status).toBe(403);
  expect((await post('/canvas/files?name=a.svg', { 'content-type': 'image/svg+xml' })).status).toBe(415);
  expect((await post('/canvas/files?name=a.png', { 'content-type': 'text/html' })).status).toBe(415);
  expect(t.woke()).toBe(0);
});

test('multipart e imágenes pasan con su boundary y se cortan en 4 MiB', async () => {
  const t = rig();
  const big = new Uint8Array(UPLOAD_MAX_BYTES + 1);
  const mp = { 'content-type': 'multipart/form-data; boundary=xyz', 'x-wt-request': '1' };
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/uploads`, { method: 'POST', headers: mp, body: big }))).status).toBe(413);
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/canvas/files?name=a.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: big }))).status).toBe(413);
  expect(t.woke()).toBe(0);
  const ok = await t.handler(new Request(`https://orq.test/chats/${CHAT}/uploads`, { method: 'POST', headers: mp, body: '--xyz--' }));
  expect(ok.status).toBe(200);
  expect(new Headers(t.forwarded[0]!.init.headers).get('content-type')).toBe('multipart/form-data; boundary=xyz');
});

test('de la query solo pasan los parámetros de la fila', async () => {
  const t = rig();
  await t.handler(new Request(`https://orq.test/chats/${CHAT}/runs/m1/events?cursor=4&evil=1&path=/etc`));
  await t.handler(new Request(`https://orq.test/chats/${CHAT}/runs/m1/files?cursor=4`));
  expect(t.forwarded[0]!.url).toBe('http://vm.test/runs/m1/events?cursor=4');
  expect(t.forwarded[1]!.url).toBe('http://vm.test/runs/m1/files');
});

test('de la VM solo salen los tipos de la fila; set-cookie, location y un SVG no pasan; la descarga conserva un attachment simple', async () => {
  const get = async (path: string, vm: Response) => rig(ALL, () => vm).handler(new Request(`https://orq.test/chats/${CHAT}${path}`));
  expect((await get('/runs/m1/shots/a.png', new Response('x', { headers: { 'content-type': 'image/svg+xml' } }))).status).toBe(502);
  expect((await get('/runs/m1/shots/a.png', new Response('x', { headers: { 'content-type': IMAGE_TYPES[0] } }))).status).toBe(200);
  const cookie = await get('/runs/m1/files', new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'access-control-allow-origin': '*' } }));
  expect(cookie.headers.get('set-cookie')).toBeNull();
  expect(cookie.headers.get('access-control-allow-origin')).toBeNull();
  expect((await get('/runs/m1/files', new Response('x', { status: 302, headers: { location: 'https://evil.test' } }))).status).toBe(502);
  expect((await get('/runs/m1/files', new Response('<b>', { headers: { 'content-type': 'text/html' } }))).status).toBe(502);
  const zip = await get('/runs/m1/export?format=zip', new Response('z', { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="page.zip"' } }));
  expect(zip.headers.get('content-disposition')).toBe('attachment; filename="page.zip"');
  // Un export nunca sale inline, ni el HTML bajo el origen de la API: attachment sintetizado y CSP sandbox aunque la VM no lo mande o lo falsee.
  const evil = await get('/runs/m1/export?format=zip', new Response('z', { headers: { 'content-type': 'application/zip', 'content-disposition': 'inline; filename="../x"' } }));
  expect(evil.headers.get('content-disposition')).toBe('attachment; filename="export.zip"');
  const html = await get('/runs/m1/export?format=page', new Response('<script>1</script>', { headers: { 'content-type': 'text/html' } }));
  expect(html.status).toBe(200);
  expect(html.headers.get('content-disposition')).toBe('attachment; filename="export.html"');
  expect(html.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect((await get('/runs/m1/export?format=design-md', new Response('#', { headers: { 'content-type': 'text/markdown; charset=utf-8' } }))).status).toBe(200);
  const edge = await get('/runs/m1/files', new Response('{}', { headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=3600' } }));
  expect(edge.headers.get('cache-control')).toBe('private, no-store');
  const img = await get('/runs/m1/shots/a.png', new Response('x', { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } }));
  expect(img.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
});

test('matchRoute no deja que un parámetro salga de su formato', () => {
  expect(matchRoute('GET', '/runs/m1/events')).toMatchObject({ params: { m: 'm1' } });
  for (const bad of ['/runs/%2e%2e/events', '/runs/M1/events', '/runs/a.b/events', '/canvas/files/.', '/canvas/files/..', `/runs/${'a'.repeat(64)}/events`]) expect(matchRoute('GET', bad), bad).toBeUndefined();
});

test('un DELETE sin cuerpo ni content-type llega a la VM: no es un form y ya fuerza preflight', async () => {
  // Ninguna fila DELETE llega hoy a la VM (conectores y siempre son 501): el chequeo es que ni siquiera exigen content-type antes de eso.
  const t = rig();
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts?id=x`, { method: 'DELETE' }))).status).toBe(501);
});

// --- Token media (spec §4) -------------------------------------------------------------------------------------------------

function mediaRig(vm?: (url: string, init: RequestInit) => Response, now: () => number = Date.now) {
  const forwarded: { url: string; init: RequestInit }[] = [];
  let woke = 0;
  const handler = createOrchestrator({
    // Solo un Bearer válido autentica: lo que llegue por token media tiene que entrar por su camino propio.
    authenticate: async (req): Promise<Session | { code: 'no-session' }> => (req.headers.get('authorization') === 'Bearer ok' ? { owner: 'u', scopes: new Set<Scope>(ALL) } : { code: 'no-session' }),
    index: {
      createChat: async (e) => e,
      getChat: async (owner, id) => (owner === 'u' && id === CHAT ? entry('u') : undefined),
      listChats: async () => [],
      ...NO_ALWAYS, readSpend: async (owner) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }),
    },
    privateKey: keys.privateKey, gateway: async () => new Response('gw'), ownerCapUsd: 5, now,
    runtimeUrl: async () => { woke++; return 'http://vm.test'; }, onError: () => undefined,
    forward: async (url, init) => { forwarded.push({ url, init }); return vm ? vm(url, init) : new Response('img', { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } }); },
  });
  const ask = async (paths: unknown, headers: Record<string, string> = { authorization: 'Bearer ok' }) =>
    handler(new Request(`https://orq.test/chats/${CHAT}/media-urls`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ paths }) }));
  return { handler, forwarded, woke: () => woke, ask };
}
const SHOT = 'runs/m1/shots/a.png';
const CANVAS = 'canvas/files/b.png';
const tokenOf = (rel: string): string => new URL(`https://x/${rel}`).searchParams.get('wt_media')!;

test('media-urls firma una URL por ruta de imagen y rechaza lo que no es una fila media, a quien no lee o de un chat ajeno', async () => {
  const t = mediaRig();
  const ok = await t.ask([SHOT, CANVAS]);
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { urls: Record<string, string>; expiresAt: number };
  expect(Object.keys(body.urls)).toEqual([SHOT, CANVAS]);
  expect(body.urls[SHOT]).toStartWith(`${SHOT}?wt_media=`);
  const v = verifyToken(createPublicKey(keys.privateKey), tokenOf(body.urls[SHOT]!), { typ: 'media', chat: CHAT, path: SHOT, now: Date.now() });
  expect(v).toMatchObject({ ok: true, claims: { owner: 'u', scopes: [], path: SHOT } });
  for (const bad of [['runs/m1/files'], ['runs/m1/export'], ['/runs/m1/shots/a.png'], ['runs/m1/shots/..'], ['canvas'], [], [1], 'x', Array.from({ length: 51 }, () => SHOT)]) {
    expect((await t.ask(bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
  }
  expect((await t.ask([SHOT], {})).status).toBe(401);
  expect(t.woke()).toBe(0);
});

test('GET con token media: abre solo esa imagen de ese chat, con identidad chat:read y sin el token hacia la VM', async () => {
  const t = mediaRig();
  const { urls } = (await (await t.ask([SHOT])).json()) as { urls: Record<string, string> };
  const res = await t.handler(new Request(`https://orq.test/chats/${CHAT}/${urls[SHOT]}`));
  expect(res.status).toBe(200);
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-type')).toBe('image/png');
  const sent = t.forwarded[0]!;
  expect(sent.url).toBe('http://vm.test/runs/m1/shots/a.png');
  const identity = new Headers(sent.init.headers).get('x-wt-identity')!;
  const payload = JSON.parse(Buffer.from(identity.split('.')[0]!, 'base64url').toString('utf8')) as { owner: string; scopes: string[]; typ: string };
  // Un token media nunca abre algo con chat:write: la identidad que llega a la VM lee y nada más.
  expect(payload).toMatchObject({ typ: 'identity', owner: 'u', scopes: ['chat:read'] });
});

test('un token media no abre otra ruta, otro chat, otro método ni vale vencido; tampoco una ruta que no es de imagen', async () => {
  let clock = Date.UTC(2026, 10, 5, 12);
  const t = mediaRig(undefined, () => clock);
  const { urls } = (await (await t.ask([SHOT])).json()) as { urls: Record<string, string> };
  const token = tokenOf(urls[SHOT]!);
  const get = (path: string, init: RequestInit = {}) => t.handler(new Request(`https://orq.test/chats/${CHAT}/${path}?wt_media=${token}`, init));
  expect((await get('runs/m1/shots/b.png')).status).toBe(401);
  expect((await get('runs/m2/shots/a.png')).status).toBe(401);
  expect((await get('runs/m1/files')).status).toBe(401);
  expect((await get('canvas/files/b.png')).status).toBe(401);
  expect((await t.handler(new Request(`https://orq.test/chats/${'b'.repeat(26)}/${SHOT}?wt_media=${token}`))).status).toBe(401);
  expect((await get(SHOT, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
  expect((await get(SHOT, { method: 'DELETE' })).status).toBe(401);
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/${SHOT}?wt_media=basura`))).status).toBe(401);
  expect(t.forwarded).toHaveLength(0);
  expect((await get(SHOT)).status).toBe(200);
  clock += 5 * 60_000 + 1;
  expect((await get(SHOT)).status).toBe(401);
});

test('un token media de otro dueño o de un chat que ya no es suyo es 404, y el SVG de una VM no sale', async () => {
  const t = mediaRig(() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
  const { urls } = (await (await t.ask([SHOT])).json()) as { urls: Record<string, string> };
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/${urls[SHOT]}`))).status).toBe(502);
  const forged = issueMediaToken(keys.privateKey, 'otro', CHAT, SHOT);
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/${SHOT}?wt_media=${forged}`))).status).toBe(404);
});

test('media-urls pide chat:read', async () => {
  const handler = createOrchestrator({
    authenticate: async (): Promise<Session> => ({ owner: 'u', scopes: new Set<Scope>(['chat:write']) }),
    index: { createChat: async (e) => e, getChat: async () => entry('u'), listChats: async () => [], ...NO_ALWAYS, readSpend: async (owner) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }) },
    privateKey: keys.privateKey, gateway: async () => new Response('gw'), ownerCapUsd: 5, runtimeUrl: async () => 'http://vm.test', onError: () => undefined,
  });
  const res = await handler(new Request(`https://orq.test/chats/${CHAT}/media-urls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [SHOT] }) }));
  expect(res.status).toBe(403);
});

// --- PR 4: catálogo, streams y conectores fuera de la VM -----------------------------------------------------------------------
const CATALOG = { models: [{ id: 'm/uno', name: 'Uno', provider: 'p' }], imageModels: [{ id: 'i/uno', name: 'Imagen', provider: 'p' }], capabilities: { transcribe: true } };

test('/models e /image-models los sirve el orquestador sin despertar una VM; sin catálogo son 404 y solo GET', async () => {
  const t = rig(ALL, undefined, { catalog: CATALOG });
  const models = await t.handler(new Request('https://orq.test/models'));
  expect(models.status).toBe(200);
  expect(await models.json()).toEqual({ models: CATALOG.models, capabilities: { transcribe: true } });
  expect(await (await t.handler(new Request('https://orq.test/image-models'))).json()).toEqual({ models: CATALOG.imageModels });
  expect((await t.handler(new Request('https://orq.test/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(404);
  expect(t.woke()).toBe(0);
  const none = rig();
  expect((await none.handler(new Request('https://orq.test/models'))).status).toBe(404);
  const leaky = rig(ALL, undefined, { catalog: { models: [{ id: 'a', name: 'A', provider: 'p', apiKey: 'sk-secreto', baseUrl: 'https://interno' } as never], imageModels: [], capabilities: { transcribe: true, extra: 'x' } as never } });
  const leakRes = await leaky.handler(new Request('https://orq.test/models'));
  expect(leakRes.headers.get('cache-control')).toBe('private, no-store');
  const leakBody = await leakRes.text();
  expect(leakBody).not.toContain('sk-secreto');
  expect(leakBody).not.toContain('interno');
  expect(JSON.parse(leakBody)).toEqual({ models: [{ id: 'a', name: 'A', provider: 'p' }], capabilities: { transcribe: true } });
  const noCaps = rig(ALL, undefined, { catalog: { models: [], imageModels: [] } });
  expect(await (await noCaps.handler(new Request('https://orq.test/models'))).json()).toEqual({ models: [], capabilities: { transcribe: false } });
});

test('el catálogo pide sesión', async () => {
  const handler = createOrchestrator({
    authenticate: async () => ({ code: 'no-session' as const }),
    index: { createChat: async (e) => e, getChat: async () => undefined, listChats: async () => [], ...NO_ALWAYS, readSpend: async (owner) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }) },
    privateKey: keys.privateKey, gateway: async () => new Response('gw'), ownerCapUsd: 5, runtimeUrl: async () => 'http://vm.test', onError: () => undefined, catalog: CATALOG,
  });
  expect((await handler(new Request('https://orq.test/models'))).status).toBe(401);
});

test('un stream con cursor se corta a streamMaxMs con un fin limpio y la request a la VM se cancela; una respuesta que no es stream no se corta', async () => {
  let cancelled = false;
  const endless = (type: string) => () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('{"a":1}\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': type } });
  const events = rig(ALL, endless('application/x-ndjson'), { streamMaxMs: 30 });
  const res = await events.handler(new Request(`https://orq.test/chats/${CHAT}/runs/m1/events`));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('{"a":1}\n');
  expect(cancelled).toBe(true);
  cancelled = false;
  const files = rig(ALL, () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), { streamMaxMs: 1 });
  expect(await (await files.handler(new Request(`https://orq.test/chats/${CHAT}/runs/m1/files`))).text()).toBe('{"ok":true}');
});

test('si la VM muere a mitad de un stream el cliente ve un error, no un fin limpio', async () => {
  const dying = () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('x\n')); },
    pull() { throw new Error('vm murió'); },
  }), { headers: { 'content-type': 'application/x-ndjson' } });
  const t = rig(ALL, dying, { streamMaxMs: 60_000 });
  const res = await t.handler(new Request(`https://orq.test/chats/${CHAT}/runs/m1/events`));
  await expect(res.text()).rejects.toThrow();
});

test('puerto connectors: el orquestador lo atiende por dueño, valida la entrada, proyecta la salida y no despierta la VM', async () => {
  const calls: unknown[][] = [];
  const connectors = {
    apps: async (q: string, after: string) => { calls.push(['apps', q, after]); return { apps: [{ slug: 'slack', name: 'Slack', description: null, icon: 'https://assets.pipedream.net/s.png', secreto: 'x' }], total: 1, next: null }; },
    accounts: async (o: string) => { calls.push(['accounts', o]); return { accounts: [{ id: 'apn_1', app: 'slack', name: 'Equipo', state: 'connected', token: 'secreto' }] }; },
    connect: async (o: string, app: string) => { calls.push(['connect', o, app]); return { url: app === 'mala' ? 'http://x.test/c' : 'https://connect.test/c', expiresAt: null }; },
    disconnect: async (o: string, id: string) => { calls.push(['disconnect', o, id]); return id === 'apn_1'; },
  };
  const t = rig(ALL, undefined, { connectors });
  const [apps, accounts, connect, bad, http, gone, ok] = await Promise.all([
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/apps?q=sl&after=c&limit=999`)),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts`)),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app":"slack"}' })),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app":"../x"}' })),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app":"mala"}' })),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts?id=ajena`, { method: 'DELETE' })),
    t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts?id=apn_1`, { method: 'DELETE' })),
  ]);
  expect(await apps.json()).toEqual({ apps: [{ slug: 'slack', name: 'Slack', description: null, icon: 'https://assets.pipedream.net/s.png' }], total: 1, next: null });
  expect(await accounts.json()).toEqual({ accounts: [{ id: 'apn_1', app: 'slack', name: 'Equipo', state: 'connected' }] });
  expect(await connect.json()).toEqual({ url: 'https://connect.test/c', expiresAt: null });
  expect([bad.status, http.status, gone.status, ok.status]).toEqual([400, 502, 404, 200]);
  expect(calls).toContainEqual(['apps', 'sl', 'c']);
  expect(calls).toContainEqual(['connect', 'u', 'slack']);
  expect(calls).toContainEqual(['disconnect', 'u', 'ajena']);
  expect(calls.some((c) => c[1] === '../x')).toBe(false);
  expect(t.woke()).toBe(0);
  expect(t.forwarded).toHaveLength(0);
  // Un form o un fetch no-cors arma text/plain: connect pide JSON.
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/connect`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"app":"slack"}' }))).status).toBe(415);
  // Sin scope de escritura no se conecta ni se desconecta.
  const ro = rig(['chat:read'], undefined, { connectors });
  expect((await ro.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts?id=apn_1`, { method: 'DELETE' }))).status).toBe(403);
});

test('connect: el límite por minuto es propio de la acción y devuelve 429', async () => {
  const connectors = { apps: async () => ({}), accounts: async () => ({}), connect: async () => ({ url: 'https://connect.test/c' }), disconnect: async () => true };
  const t = rig(ALL, undefined, { connectors });
  const post = () => t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app":"slack"}' }));
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await post()).status);
  expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
  expect(codes[10]).toBe(429);
});

test('/gw/connectors: la VM usa las apps del dueño del token de corrida y solo pasan tools de lectura', async () => {
  const forwarded: unknown[][] = [];
  const connectors = {
    apps: async () => ({}), accounts: async () => ({}), connect: async () => ({}), disconnect: async () => true,
    mcp: async (o: string, slugs: readonly string[]) => ({ apps: slugs.filter((s) => s === 'slack'), readOnlyTools: ['mcp__slack__list', 'mcp__otra__x'] }),
    forward: async (o: string, slug: string, message: unknown, session?: string) => { forwarded.push([o, slug, message, session]); return { status: 200, text: '{"ok":1}', session: 's1' }; },
  };
  const t = rig(ALL, undefined, { connectors });
  const run = issueRunToken(keys.privateKey, 'u', CHAT, '', 60_000, 3_600_000, Date.now, ['slack']);
  const post = (path: string, body: unknown, token: string | null = run, type = 'application/json') =>
    t.handler(new Request(`https://orq.test${path}`, { method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
  expect(await (await post('/gw/connectors/mcp', { slugs: ['slack'] })).json()).toEqual({ apps: ['slack'], readOnlyTools: ['mcp__slack__list'] });
  const ok = await post('/gw/connectors/forward/slack', { message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list', arguments: {} } }, session: 's0' });
  expect(await ok.json()).toEqual({ status: 200, text: '{"ok":1}', session: 's1' });
  expect(forwarded[0]![0]).toBe('u');
  expect(forwarded[0]![3]).toBe('s0');
  // Una tool que escribe, un método fuera de la lista, un slug raro, un token que no es de corrida o JSON de otro origen: ninguno llega al puerto.
  const before = forwarded.length;
  expect((await post('/gw/connectors/forward/slack', { message: { id: 2, method: 'tools/call', params: { name: 'send' } } })).status).toBe(403);
  expect((await post('/gw/connectors/forward/slack', { message: { id: 3, method: 'resources/read' } })).status).toBe(400);
  expect((await post('/gw/connectors/forward/..%2Fx', { message: { method: 'ping' } })).status).toBe(404);
  expect((await post('/gw/connectors/mcp', { slugs: ['../x'] })).status).toBe(400);
  // El agente tiene el token, pero solo las apps que la corrida pidió: gmail no se pidió.
  expect((await post('/gw/connectors/forward/gmail', { message: { id: 4, method: 'tools/list' } })).status).toBe(403);
  expect((await post('/gw/connectors/mcp', { slugs: ['slack', 'gmail'] })).status).toBe(403);
  const noApps = issueRunToken(keys.privateKey, 'u', CHAT, '', 60_000, 3_600_000);
  expect((await post('/gw/connectors/forward/slack', { message: { id: 5, method: 'tools/list' } }, noApps)).status).toBe(403);
  expect((await post('/gw/connectors/mcp', { slugs: ['slack'] }, null)).status).toBe(401);
  expect((await post('/gw/connectors/mcp', { slugs: ['slack'] }, issueMediaToken(keys.privateKey, 'u', CHAT, 'runs/m1/shots/a.png'))).status).toBe(401);
  expect((await post('/gw/connectors/mcp', { slugs: ['slack'] }, run, 'text/plain')).status).toBe(415);
  expect(forwarded.length).toBe(before);
  expect(t.woke()).toBe(0);
  // Sin mcp/forward en el puerto, la VM no recibe apps.
  const bare = rig(ALL, undefined, { connectors: { apps: async () => ({}), accounts: async () => ({}), connect: async () => ({}), disconnect: async () => true } });
  expect((await bare.handler(new Request('https://orq.test/gw/connectors/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${run}` }, body: '{"slugs":["slack"]}' }))).status).toBe(501);
});

test('POST /runs firma en el token de corrida solo los slugs válidos de connectors', async () => {
  const t = rig();
  await t.handler(new Request(`https://orq.test/chats/${CHAT}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x","connectors":["slack","../x",3,"slack","wt","approval"]}' }));
  const token = new Headers(t.forwarded[0]!.init.headers).get('x-wt-run-token')!;
  const claims = verifyToken(createPublicKey(keys.privateKey), token, { typ: 'run', maxTtlMs: 3_600_000, now: Date.now() });
  expect(claims.ok && claims.claims.apps).toEqual(['slack']);
});

const portOf = (over: Record<string, unknown> = {}) => ({
  apps: async () => ({ apps: [], total: 0, next: null }), accounts: async () => ({ accounts: [] }), connect: async () => ({ url: 'https://connect.test/c' }), disconnect: async () => true,
  mcp: async (_o: string, slugs: readonly string[]) => ({ apps: [...slugs], readOnlyTools: slugs.map((x) => `mcp__${x}__list`) }),
  forward: async () => ({ status: 200, text: '{}' }),
  ...over,
});
const runWith = (apps: string[]) => issueRunToken(keys.privateKey, 'u', CHAT, '', 60_000, 3_600_000, Date.now, apps);
const gwPost = (t: ReturnType<typeof rig>, path: string, body: unknown, token: string | null) =>
  t.handler(new Request(`https://orq.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));

test('GW_ROUTES es la única puerta de /gw: cada fila pide el token de corrida, el método ajeno es 405 y lo que no está en la tabla es 404 sin autenticar', async () => {
  const t = rig(ALL, undefined, { connectors: portOf() });
  for (const r of GW_ROUTES) {
    const path = r.path.replace('/*', '/v1/messages').replace(':slug', 'slack');
    expect(matchGw(r.method === '*' ? 'DELETE' : r.method, path), r.path).toEqual(r);
    if (r.id === 'gateway') continue; // el proxy valida su propio token (tests de gateway-proxy-run)
    const method = r.method === '*' ? 'POST' : r.method;
    expect((await t.handler(new Request(`https://orq.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }))).status, `${r.method} ${r.path} sin token`).toBe(401);
    const other = method === 'GET' ? 'POST' : 'GET';
    expect((await t.handler(new Request(`https://orq.test${path}`, { method: other }))).status, `${other} ${r.path}`).toBe(405);
  }
  for (const stray of ['/gw/otra', '/gw/connectors/otra', '/gw/connectors/forward/a/b', '/gw/connectors/forward/_a', '/gw/always/x']) {
    expect((await t.handler(new Request(`https://orq.test${stray}`, { method: 'POST' }))).status, stray).toBe(404);
  }
  expect(await (await t.handler(new Request('https://orq.test/gw/claude-code/v1/messages', { method: 'POST' }))).text()).toBe('gw');
});

test('/gw/connectors: los tokens que no son de corrida (identity, media) dan 401 y un token run sin apps no ve ninguna', async () => {
  const t = rig(ALL, undefined, { connectors: portOf() });
  const session = { owner: 'u', scopes: new Set<Scope>(ALL) };
  expect((await gwPost(t, '/gw/connectors/mcp', { slugs: [] }, issueIdentity(keys.privateKey, session, CHAT, 60_000))).status).toBe(401);
  expect((await gwPost(t, '/gw/connectors/mcp', { slugs: [] }, issueMediaToken(keys.privateKey, 'u', CHAT, 'runs/m1/shots/a.png'))).status).toBe(401);
  expect(await (await gwPost(t, '/gw/connectors/mcp', { slugs: [] }, runWith([]))).json()).toEqual({ apps: [], readOnlyTools: [] });
  expect((await gwPost(t, '/gw/connectors/mcp', { slugs: ['slack'] }, runWith([]))).status).toBe(403);
  expect((await gwPost(t, '/gw/connectors/forward/slack', { message: { method: 'ping' } }, runWith([]))).status).toBe(403);
  const bare = rig(ALL, undefined, { connectors: { apps: async () => ({}), accounts: async () => ({}), connect: async () => ({}), disconnect: async () => true } });
  expect((await gwPost(bare, '/gw/connectors/forward/slack', { message: { method: 'ping' } }, runWith(['slack']))).status).toBe(501);
});

test('/gw/connectors/forward: tope por minuto propio, slugs sin guion bajo en los bordes y respuesta medida en bytes', async () => {
  const big = '€'.repeat(400_000); // 1,2 MB en UTF-8 pero 400 000 caracteres: por bytes pasa a más de 2 MiB al escaparse en la VM
  let text = '{}';
  const t = rig(ALL, undefined, { connectors: portOf({ forward: async () => ({ status: 200, text }) }) });
  const run = runWith(['a', 'a_b']);
  const ping = () => gwPost(t, '/gw/connectors/forward/a', { message: { method: 'ping' } }, run);
  for (let i = 0; i < 120; i++) expect((await ping()).status).toBe(200);
  expect((await ping()).status).toBe(429);
  const t2 = rig(ALL, undefined, { connectors: portOf({ forward: async () => ({ status: 200, text }) }) });
  text = big.repeat(2);
  expect((await gwPost(t2, '/gw/connectors/forward/a', { message: { method: 'ping' } }, run)).status).toBe(502);
  text = '€'.repeat(100_000);
  expect((await gwPost(t2, '/gw/connectors/forward/a', { message: { method: 'ping' } }, run)).status).toBe(200);
  // `a_` y `_a` no son slugs: ninguna app puede hacerse pasar por `a` con `mcp__a___b`.
  expect((await gwPost(t2, '/gw/connectors/mcp', { slugs: ['a_'] }, run)).status).toBe(400);
  expect((await gwPost(t2, '/gw/connectors/mcp', { slugs: ['_a'] }, run)).status).toBe(400);
  const tools = rig(ALL, undefined, { connectors: portOf({ mcp: async () => ({ apps: ['a', 'a_b'], readOnlyTools: ['mcp__a__x', 'mcp__a_b__y', 'mcp__c__z'] }) }) });
  expect(await (await gwPost(tools, '/gw/connectors/mcp', { slugs: ['a', 'a_b'] }, run)).json()).toEqual({ apps: ['a', 'a_b'], readOnlyTools: ['mcp__a__x', 'mcp__a_b__y'] });
});

test('A1(a): /connectors/* en la raíz del dueño funciona sin chat ni VM, con sus scopes, y el alias bajo /chats/:id sigue', async () => {
  const t = rig(ALL, undefined, { connectors: portOf() });
  expect(await (await t.handler(new Request('https://orq.test/connectors/accounts'))).json()).toEqual({ accounts: [] });
  expect(await (await t.handler(new Request('https://orq.test/connectors/apps?q=x'))).json()).toEqual({ apps: [], total: 0, next: null });
  const connect = (tt: ReturnType<typeof rig>) => tt.handler(new Request('https://orq.test/connectors/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"app":"slack"}' }));
  expect(await (await connect(t)).json()).toEqual({ url: 'https://connect.test/c', expiresAt: null });
  expect((await t.handler(new Request('https://orq.test/connectors/accounts?id=apn_1', { method: 'DELETE' }))).status).toBe(200);
  expect((await t.handler(new Request('https://orq.test/connectors/apps', { method: 'POST' }))).status).toBe(405);
  expect((await t.handler(new Request('https://orq.test/connectors/otra'))).status).toBe(404);
  expect(t.woke()).toBe(0);
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/connectors/accounts`))).status).toBe(200);
  const ro = rig(['chat:read'], undefined, { connectors: portOf() });
  expect((await connect(ro)).status).toBe(403);
  expect((await ro.handler(new Request('https://orq.test/connectors/accounts'))).status).toBe(200);
  const none = rig(ALL);
  expect((await none.handler(new Request('https://orq.test/connectors/accounts'))).status).toBe(501);
});

const CALL = 'toolu_01';
const register = (t: ReturnType<typeof rig>, tool: string, apps: string[] = [], callId = CALL, input: unknown = {}) =>
  gwPost(t, '/gw/approvals/pending', { callId, tool, input }, runWith(apps));
const decide = (t: ReturnType<typeof rig>, decision: string, callId = CALL) =>
  t.handler(new Request(`https://orq.test/chats/${CHAT}/approvals/${callId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) }));
const vmSays = () => asJson({ ok: true, always: 'mcp__x__y', otro: 'dato de la VM' });

test('"siempre": la tarjeta sale del registro del orquestador y el índice guarda lo que la persona vio, no lo que diga la VM', async () => {
  const t = rig(ALL, vmSays);
  const reg = await register(t, SPEND_TOOL);
  expect(await reg.json()).toMatchObject({ patterns: [`Tool(${SPEND_TOOL}:*)`], rememberPatterns: [`Dynamic(${SPEND_TOOL})`] });
  const view = await t.handler(new Request(`https://orq.test/chats/${CHAT}/approvals/${CALL}`));
  expect(await view.json()).toMatchObject({ callId: CALL, tool: SPEND_TOOL, patterns: [`Tool(${SPEND_TOOL}:*)`], rememberPatterns: [`Dynamic(${SPEND_TOOL})`] });
  expect(view.headers.get('cache-control')).toBe('private, no-store');
  expect(await (await decide(t, 'always')).json()).toEqual({ ok: true, always: true });
  expect([...t.always.get('u')!]).toEqual([SPEND_TOOL]);
  expect((await decide(t, 'always')).status).toBe(409);
  expect((await t.handler(new Request(`https://orq.test/chats/${CHAT}/approvals/otra`))).status).toBe(404);
});

test('una VM que fabrica un "siempre" no lo consigue: sin registro, con allow, sin spend o en una tool que no admite "siempre" el índice queda vacío', async () => {
  const noRecord = rig(ALL, vmSays);
  expect((await decide(noRecord, 'always')).status).toBe(404);
  expect(noRecord.forwarded.filter((f) => f.url.includes('/approvals/')).length).toBe(0);
  const allow = rig(ALL, vmSays);
  await register(allow, SPEND_TOOL);
  expect(await (await decide(allow, 'allow')).json()).toEqual({ ok: true });
  const noSpend = rig(['chat:read', 'chat:write'], vmSays);
  await register(noSpend, SPEND_TOOL);
  expect((await decide(noSpend, 'always')).status).toBe(403);
  const connectorTool = rig(ALL, vmSays);
  await register(connectorTool, 'mcp__slack__send', ['slack']);
  expect(await (await decide(connectorTool, 'always')).json()).toEqual({ ok: true, always: false });
  expect(noRecord.always.size + allow.always.size + noSpend.always.size + connectorTool.always.size).toBe(0);
});

test('registro de aprobaciones: solo tools de gasto o de una app de la corrida, callId acotado y tope por chat', async () => {
  const t = rig(ALL);
  expect((await register(t, 'mcp__gmail__send', ['slack'])).status).toBe(403);
  expect((await register(t, 'Bash', ['slack'])).status).toBe(400);
  expect((await register(t, 'mcp__slack__send', ['slack'], '../x')).status).toBe(400);
  expect((await register(t, 'mcp__slack__send', ['slack'], CALL)).status).toBe(200);
  // Idempotente por callId: la primera tool registrada manda, la VM no puede cambiar la tarjeta.
  expect((await register(t, SPEND_TOOL, [], CALL)).status).toBe(200);
  expect((await (await t.handler(new Request(`https://orq.test/chats/${CHAT}/approvals/${CALL}`))).json() as { tool: string }).tool).toBe('mcp__slack__send');
  for (let i = 1; i < 16; i++) expect((await register(t, 'mcp__slack__send', ['slack'], `c${i}`)).status).toBe(200);
  expect((await register(t, 'mcp__slack__send', ['slack'], 'c99')).status).toBe(429);
});

test('grant por llamada: se entrega una sola vez tras la decisión y abre exactamente esa llamada, una vez', async () => {
  const calls: unknown[] = [];
  const connectors = portOf({ mcp: async () => ({ apps: ['slack'], readOnlyTools: ['mcp__slack__list'] }), forward: async (_o: string, _s: string, message: unknown) => { calls.push(message); return { status: 200, text: '{}' }; } });
  const t = rig(ALL, () => asJson({ ok: true }), { connectors });
  const run = runWith(['slack']);
  const grant = (callId = CALL) => gwPost(t, '/gw/approvals/grant', { callId }, run);
  const call = (name: string, extra: Record<string, unknown>, args: unknown = { to: 'a@x.test', text: 'hola' }) => gwPost(t, '/gw/connectors/forward/slack', { message: { id: 1, method: 'tools/call', params: { name, arguments: args } }, ...extra }, run);
  await register(t, 'mcp__slack__send', ['slack'], CALL, { text: 'hola', to: 'a@x.test' });
  expect((await grant()).status).toBe(404); // sin decisión no hay permiso
  expect((await decide(t, 'allow')).status).toBe(200);
  const g = (await (await grant()).json()) as { grant: string; tool: string };
  expect(g.tool).toBe('mcp__slack__send');
  expect((await grant()).status).toBe(404); // se entrega una vez
  expect((await call('send', {})).status).toBe(403); // sin permiso
  expect((await call('send', { callId: CALL, grant: 'basura' })).status).toBe(403);
  expect((await call('delete', { callId: CALL, grant: g.grant })).status).toBe(403); // otra tool
  expect((await call('send', { callId: 'otra', grant: g.grant })).status).toBe(403); // otro callId
  // Los argumentos son los que la tarjeta registró: otro destinatario con el mismo permiso no pasa.
  expect((await call('send', { callId: CALL, grant: g.grant }, { to: 'otro@x.test', text: 'hola' })).status).toBe(403);
  expect((await call('send', { callId: CALL, grant: g.grant }, {})).status).toBe(403);
  expect(calls).toHaveLength(0);
  expect((await call('send', { callId: CALL, grant: g.grant }, { text: 'hola', to: 'a@x.test' })).status).toBe(200); // mismas claves en otro orden
  expect(calls).toHaveLength(1);
  expect((await call('send', { callId: CALL, grant: g.grant }, { text: 'hola', to: 'a@x.test' })).status).toBe(403); // un solo uso
  expect((await call('list', {})).status).toBe(200); // lectura: sin permiso
  // Un skip no deja permiso.
  await register(t, 'mcp__slack__send', ['slack'], 'c2');
  expect((await decide(t, 'skip', 'c2')).status).toBe(200);
  expect((await grant('c2')).status).toBe(404);
});

test('si la VM no acepta la decisión la tarjeta se puede volver a decidir; el permiso tiene límite por minuto y los argumentos se acotan', async () => {
  let vmStatus = 500;
  const t = rig(ALL, () => new Response('{}', { status: vmStatus, headers: { 'content-type': 'application/json' } }));
  await register(t, 'mcp__slack__send', ['slack'], CALL, { to: 'a' });
  expect((await decide(t, 'allow')).status).toBe(500);
  expect((await gwPost(t, '/gw/approvals/grant', { callId: CALL }, runWith(['slack']))).status).toBe(404); // revertida: sin decisión no hay permiso
  vmStatus = 200;
  expect((await decide(t, 'allow')).status).toBe(200); // no es 409: la decisión anterior se deshizo
  expect((await gwPost(t, '/gw/approvals/grant', { callId: CALL }, runWith(['slack']))).status).toBe(200);
  const g = rig(ALL);
  for (let i = 0; i < 120; i++) await gwPost(g, '/gw/approvals/grant', { callId: CALL }, runWith(['slack']));
  expect((await gwPost(g, '/gw/approvals/grant', { callId: CALL }, runWith(['slack']))).status).toBe(429);
  expect((await register(g, 'mcp__slack__send', ['slack'], 'big', { text: 'x'.repeat(20_000) })).status).toBe(413);
  expect((await register(g, 'mcp__slack__send', ['slack'], 'arr', [1] as unknown as object)).status).toBe(400);
  const view = await (await g.handler(new Request(`https://orq.test/chats/${CHAT}/approvals/none`))).status;
  expect(view).toBe(404);
});

// QA #889: la VM solo pide `spend` para el "siempre" (agent-mcp.ts, pendingTool); para `allow` el único control es decideApproval. El
// registro caduca a los APPROVAL_TIMEOUT_MS de registrarse y el timer de la VM arranca después, cuando vuelve el register: en esa ventana
// la tarjeta sigue viva en la VM, el registro ya no existe y una sesión sin `spend` aprueba una tool de gasto que pasa tal cual.
test('una decisión sobre un callId sin registro no llega a la VM: un registro caducado no abre la tool de gasto a una sesión sin spend', async () => {
  let clock = Date.now();
  const real = createChatIndex({ blob: new MemBlob(), now: () => clock });
  const index = {
    createChat: async (e: ChatEntry) => e,
    getChat: async (owner: string, id: string) => (owner === 'u' && id === CHAT ? entry('u') : undefined),
    listChats: async () => [],
    registerPending: real.registerPending, readPending: real.readPending, decidePending: real.decidePending, takeGrant: real.takeGrant, useGrant: real.useGrant, revertPending: real.revertPending,
    readAlways: async () => [] as string[], addAlways: async () => [] as string[], removeAlways: async () => [] as string[],
    readSpend: async (owner: string) => ({ owner, spent: 0, byModel: Object.create(null), applied: [], updatedAt: 0 }),
  };
  // Solo el índice lleva el reloj: el token de corrida se emite y se verifica con Date.now.
  const t = rig(['chat:read', 'chat:write'], () => asJson({ ok: true }), { index });
  expect((await register(t, SPEND_TOOL)).status).toBe(200);
  expect((await decide(t, 'allow')).status).toBe(403);
  clock += 120_000 + 1;
  const late = await decide(t, 'allow');
  expect(t.forwarded.filter((f) => f.url.includes('/approvals/'))).toHaveLength(0);
  expect(late.status).toBe(404);
});

test('la fila GET de la tarjeta de aprobación usa la ruta de chat de la VM, no /approvals/:callId (que choca con /approvals/always)', () => {
  const m = matchRoute('GET', '/approvals/always');
  expect(m).toMatchObject({ route: { pending: true } });
  const { route, params } = m as { route: Route; params: Record<string, string> };
  expect(vmPath(route, CHAT, params)).toBe(`/chats/${CHAT}/approvals/always`);
});
