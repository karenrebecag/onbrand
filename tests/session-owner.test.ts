import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ID_FAMILIES, NO_ID_FAMILIES } from '../src/runtime/http-router';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type RuntimeOptions } from '../src/runtime/server';
import { ownerSlug } from '../src/runtime/brand-store';
import { ALL_SCOPES, providerVerifier, owns, type SessionVerifier } from '../src/runtime/session';

// docs/spec/identidad-sesion.md §5 y §10 fase 2: el dueño de un chat lo fija run-cycle, y toda ruta con id lo resuelve antes
// del handler. Un chat ajeno se ve igual que uno inexistente.
const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };
const byHeader: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user'] ?? 'local'), scopes: ALL_SCOPES }) };

let tmp: string;
let server: Server;
let runtime: Runtime;

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose: async () => PAGE, build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), session: byHeader, ...extra });
  runtime = t;
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function freePort(): Promise<number> {
  const s = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'session-owner-'));
  mkdirSync(join(tmp, 'vault'));
});
afterEach(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const as = (user: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { 'content-type': 'application/json', 'x-user': user, ...(init.headers as Record<string, string> | undefined) } });
const post = (at: string, user: string, id: string, body: object) => fetch(`${at}/runs`, as(user, { method: 'POST', body: JSON.stringify({ messageId: id.padEnd(32, '0'), ...body }) }));

test('un chat ajeno responde 404 con el mismo cuerpo que un id inexistente, en cada familia de ruta con id', async () => {
  const at = await boot();
  expect((await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' })).status).toBe(202);
  await (await fetch(`${at}/runs/chata000000000000000000000000000/events?cursor=-1`, as('a'))).text();
  const routes: [string, string][] = [
    ['GET', '/chats/ID'], ['GET', '/chats/ID/canvas'], ['GET', '/runs/ID'], ['GET', '/runs/ID/files'], ['GET', '/runs/ID/events?cursor=-1'],
    ['GET', '/runs/ID/versions'], ['GET', '/runs/ID/diff'], ['POST', '/runs/ID/cancel'], ['POST', '/chats/ID/approvals/c1'], ['PUT', '/chats/ID/plans/p1'],
  ];
  for (const [method, path] of routes) {
    const call = (user: string, id: string) => fetch(`${at}${path.replace('ID', id)}`, as(user, { method, ...(method === 'GET' ? {} : { body: '{}' }) }));
    // Approvals y plans no existen en este chat: su 404 propio no prueba nada del dueño.
    if (!/approvals|plans/.test(path)) expect([method, path, (await call('a', 'chata000000000000000000000000000')).status === 404]).toEqual([method, path, false]);
    const theirs = await call('b', 'chata000000000000000000000000000');
    const ghost = await call('b', 'noexiste');
    expect([method, path, theirs.status]).toEqual([method, path, 404]);
    // Mismo cuerpo que un id inexistente (con el id sustituido): ajeno e inexistente no se distinguen.
    expect((await theirs.text()).replace('chata000000000000000000000000000', 'X')).toBe((await ghost.text()).replace('noexiste', 'X'));
  }
});

test('el dueño queda en el índice y un follow-up de otro dueño sobre ese chat es 404 sin crear mensaje', async () => {
  const at = await boot();
  await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' });
  await (await fetch(`${at}/runs/chata000000000000000000000000000/events?cursor=-1`, as('a'))).text();
  const index = () => JSON.parse(readFileSync(join(tmp, 'state', 'index.json'), 'utf8')) as Record<string, { owner?: string }>;
  expect(index().chata000000000000000000000000000?.owner).toBe('a');
  for (const body of [{ prompt: 'x', parentId: 'chata000000000000000000000000000' }, { restoreFrom: 'chata000000000000000000000000000' }, { repair: 'runtime', parentId: 'chata000000000000000000000000000' }, { variants: { sourceId: 'chata000000000000000000000000000', count: 1 } }]) {
    const res = await post(at, 'b', `intruso${Object.keys(body)[0]?.toLowerCase()}`, body);
    expect([Object.keys(body)[0], res.status]).toEqual([Object.keys(body)[0], 404]);
  }
  expect(Object.keys(index()).filter((k) => k.startsWith('intruso'))).toEqual([]);
});

test('un chat sin dueño es del dueño local (opción c) y la sesión con chats acotados solo ve los suyos', () => {
  expect(owns({ owner: 'local', scopes: ALL_SCOPES }, { ws: 'w' })).toBe(true);
  expect(owns({ owner: 'a', scopes: ALL_SCOPES }, { ws: 'w' })).toBe(false);
  expect(owns({ owner: 'a', scopes: ALL_SCOPES, chats: new Set(['w']) }, { ws: 'w', owner: 'a' })).toBe(true);
  expect(owns({ owner: 'a', scopes: ALL_SCOPES, chats: new Set(['otro']) }, { ws: 'w', owner: 'a' })).toBe(false);
});

test('guarda estática: toda familia de ruta de http-router.ts es de id (con dueño) o está declarada sin id', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'runtime', 'http-router.ts'), 'utf8');
  const families = new Set([...source.matchAll(/parts\[0\] === '([a-z-]+)'/g)].map((m) => m[1] as string));
  const known = new Set<string>([...ID_FAMILIES, ...NO_ID_FAMILIES]);
  expect([...families].filter((f) => !known.has(f))).toEqual([]);
  // El chequeo de dueño nombra cada familia de id: quitar una de `handle` rompe esto.
  for (const f of ID_FAMILIES) expect(source).toContain(`parts[0] === '${f}'`);
});

test('el scope se aplica después del dueño: 403 en una ruta propia, 404 en un id ajeno o inexistente', async () => {
  const bySet: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user']), scopes: h['x-scopes'] === 'none' ? new Set() : ALL_SCOPES }) };
  const at = await boot({ session: bySet });
  await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' });
  await (await fetch(`${at}/runs/chata000000000000000000000000000/events?cursor=-1`, as('a'))).text();
  const noScopes = (user: string, path: string, method = 'GET') => fetch(`${at}${path}`, as(user, { method, headers: { 'x-scopes': 'none' }, ...(method === 'GET' ? {} : { body: '{}' }) }));
  expect((await noScopes('a', '/runs', 'POST')).status).toBe(403);
  expect((await noScopes('a', '/runs/chata000000000000000000000000000')).status).toBe(403);
  expect((await noScopes('b', '/runs/chata000000000000000000000000000')).status).toBe(404);
  expect((await noScopes('a', '/runs/noexiste')).status).toBe(404);
  // La marca pide brand:write; leer, solo chat:read.
  expect((await noScopes('a', '/brands/x/memory', 'POST')).status).toBe(403);
});

test('el "siempre" de un dueño no autoriza al chat de otro: ask() usa el dueño del chat', async () => {
  const { Approvals } = await import('../src/runtime/approvals');
  const IMG = 'mcp__wt__generate_image';
  const owners: Record<string, string> = { chata000000000000000000000000000: 'a', chatb000000000000000000000000000: 'b' };
  const approvals = new Approvals(10_000, join(tmp, 'approvals.json'), (chat) => owners[chat] ?? 'local');
  const sink = { request: () => {}, decision: () => {} };
  const ask = (chat: string, id: string) => approvals.ask(chat, 'ask', new Set(), { tool_name: IMG, input: {}, tool_use_id: id }, sink);
  const first = ask('chata000000000000000000000000000', 't1');
  approvals.decide('chata000000000000000000000000000', 't1', 'always');
  await first;
  expect(approvals.alwaysTools('a')).toEqual([IMG]);
  expect(approvals.alwaysTools('b')).toEqual([]);
  expect(await ask('chata000000000000000000000000000', 't2')).toMatchObject({ behavior: 'allow' });
  const other = ask('chatb000000000000000000000000000', 't3');
  approvals.decide('chatb000000000000000000000000000', 't3', 'skip');
  expect(await other).toMatchObject({ behavior: 'deny' });
});

test('un id que no es string en el cuerpo no esquiva el dueño: parentId/restoreFrom como arreglo es 400 y no toca el chat ajeno', async () => {
  const at = await boot();
  await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' });
  await (await fetch(`${at}/runs/chata000000000000000000000000000/events?cursor=-1`, as('a'))).text();
  const index = () => JSON.parse(readFileSync(join(tmp, 'state', 'index.json'), 'utf8')) as Record<string, unknown>;
  const before = Object.keys(index()).sort();
  // Los handlers coaccionan con String(): ['chata000000000000000000000000000'] llegaba a 'chata000000000000000000000000000' sin pasar por el chequeo.
  for (const body of [{ restoreFrom: ['chata000000000000000000000000000'] }, { prompt: 'x', parentId: ['chata000000000000000000000000000'] }, { patch: {}, parentId: ['chata000000000000000000000000000'] }, { applyBrand: 'x', parentId: ['chata000000000000000000000000000'] }, { repair: 'runtime', parentId: ['chata000000000000000000000000000'] }]) {
    const res = await post(at, 'b', `intruso${Object.keys(body)[0]?.toLowerCase()}`, body);
    expect([Object.keys(body)[0], res.status]).toEqual([Object.keys(body)[0], 400]);
  }
  expect(Object.keys(index()).sort()).toEqual(before);
});

test('un plan ajeno y uno inexistente dan el mismo error en GET /chats/:chat/plans/:id', async () => {
  const at = await boot({ agent: true });
  await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' });
  await post(at, 'b', 'chatb000000000000000000000000000', { prompt: 'hola' });
  const get = (id: string) => fetch(`${at}/chats/chata000000000000000000000000000/plans/${id}`, as('a'));
  const foreign = await get('chatb000000000000000000000000000');
  const ghost = await get('noexiste');
  expect(foreign.status).toBe(ghost.status);
  expect((await foreign.text()).replace('chatb000000000000000000000000000', 'X')).toBe((await ghost.text()).replace('noexiste', 'X'));
});

test('el latido: un ws ajeno sale igual que uno inexistente y el dueño no cambia de estado', async () => {
  const at = await boot({ previewPort: await freePort() });
  await post(at, 'a', 'chata000000000000000000000000000', { prompt: 'hola' });
  await (await fetch(`${at}/runs/chata000000000000000000000000000/events?cursor=-1`, as('a'))).text();
  const beat = async (user: string, visible: string[]) => (await (await fetch(`${at}/preview/heartbeat`, as(user, { method: 'POST', body: JSON.stringify({ visible }) }))).json()) as { states: Record<string, { status: string; version: string | null; url: string; previewToken?: string }> };
  const b = await beat('b', ['chata000000000000000000000000000', 'noexiste']);
  expect(Object.keys(b.states).sort()).toEqual(['chata000000000000000000000000000', 'noexiste']);
  expect({ ...b.states.chata000000000000000000000000000, url: '' }).toEqual({ ...b.states.noexiste, url: '' });
  expect(b.states.chata000000000000000000000000000?.version).toBeNull();
  expect(b.states.chata000000000000000000000000000?.previewToken).toBeUndefined();
});

test('con identidad real el messageId del cliente exige 128 bits; con el dueño local los ids cortos siguen valiendo', async () => {
  const at = await boot();
  const short = await fetch(`${at}/runs`, as('a', { method: 'POST', body: JSON.stringify({ messageId: 'my-page', prompt: 'x' }) }));
  expect(short.status).toBe(400);
  expect(((await short.json()) as { error: string }).error).toContain('128 bits');
  expect((await fetch(`${at}/runs`, as('a', { method: 'POST', body: JSON.stringify({ messageId: ['x'.repeat(32)], prompt: 'x' }) }))).status).toBe(400);
  expect((await fetch(`${at}/runs`, as('a', { method: 'POST', body: JSON.stringify({ messageId: crypto.randomUUID(), prompt: 'x' }) }))).status).toBe(202);
  // Sin messageId lo genera el runtime (uuid sin guiones).
  expect((await fetch(`${at}/runs`, as('a', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) }))).status).toBe(202);
  // El dueño local es el del core (sin verifier del perfil): ahí los ids cortos siguen valiendo.
  server.close();
  const local = await boot({ session: undefined });
  expect((await post(local, 'local', 'corto', { prompt: 'x' })).status).toBe(202);
});

test('spend: lo piden las rutas que gastan; el latido solo pide chat:read', async () => {
  const scopes: Record<string, ReadonlySet<'chat:read' | 'chat:write' | 'spend' | 'brand:write'>> = {
    read: new Set(['chat:read']),
    write: new Set(['chat:read', 'chat:write']),
    all: ALL_SCOPES,
  };
  const bySet: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user']), scopes: scopes[String(h['x-scopes'] ?? 'all')] ?? new Set() }) };
  const at = await boot({ session: bySet, previewPort: await freePort() });
  await post(at, 'a', 'chata', { prompt: 'hola' });
  await (await fetch(`${at}/runs/${'chata'.padEnd(32, '0')}/events?cursor=-1`, as('a'))).text();
  const id = 'chata'.padEnd(32, '0');
  const call = (level: string, path: string, body: object = {}) => fetch(`${at}${path}`, as('a', { method: 'POST', headers: { 'x-scopes': level }, body: JSON.stringify(body) }));
  // El latido consulta: chat:read alcanza.
  expect((await call('read', '/preview/heartbeat', { visible: [id] })).status).toBe(200);
  // Lo que gasta pide spend además de chat:write: sin él 403, con él pasa el scope (el handler responde lo suyo).
  for (const [path, body] of [['/prompt-enhancements', { prompt: 'x' }], ['/transcribe', {}], [`/runs/${id}/sections/hero/suggestions`, {}], ['/runs', { prompt: 'x', imageGeneration: { modelId: 'nope' } }], ['/runs', { prompt: 'x', imageGeneration: null }], ['/runs', { variants: { sourceId: id, count: 1 }, imageGeneration: { modelId: 'nope' } }]] as [string, object][]) {
    const denied = await call('write', path, body);
    expect([path, denied.status, ((await denied.json()) as { code?: string }).code]).toEqual([path, 403, 'scope']);
    // El enhancer sin modelo espera su timeout (~5 s): con spend no se llama, basta el 403 de arriba.
    if (path === '/prompt-enhancements') continue;
    const allowed = await call('all', path, body);
    expect([path, allowed.status === 403]).toEqual([path, false]);
  }
  // Sin imageGeneration, POST /runs solo pide chat:write.
  expect((await call('write', '/runs', { prompt: 'x', messageId: 'sinimagen'.padEnd(32, '0') })).status).toBe(202);
  // Espera la primera corrida entera (events hasta el final: prepare + install del ws); bajo la carga de la suite pasa de
  // los 5 s por defecto sin que nada esté mal. Mismo margen que los demás tests que levantan un navegador o una corrida.
}, 30_000);

test('el "siempre" de una tool de gasto exige spend al contestar la tarjeta, allow incluido; skip no', async () => {
  const bySet: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user']), scopes: h['x-scopes'] === 'write' ? new Set(['chat:read' as const, 'chat:write' as const]) : ALL_SCOPES }) };
  const at = await boot({ session: bySet, agent: true });
  const id = 'chata'.padEnd(32, '0');
  await post(at, 'a', 'chata', { prompt: 'hola' });
  await (await fetch(`${at}/runs/${id}/events?cursor=-1`, as('a'))).text();
  const { Approvals } = await import('../src/runtime/approvals');
  const approvals = (runtime as unknown as { approvals: InstanceType<typeof Approvals> }).approvals;
  const sink = { request: () => {}, decision: () => {} };
  const card = (callId: string) => approvals.ask(id, 'ask', new Set(), { tool_name: 'mcp__wt__generate_image', input: {}, tool_use_id: callId }, sink);
  const decide = (scopes: string, callId: string, decision: string) => fetch(`${at}/chats/${id}/approvals/${callId}`, as('a', { method: 'POST', headers: { 'x-scopes': scopes }, body: JSON.stringify({ decision }) }));
  const first = card('c1');
  const denied = await decide('write', 'c1', 'always');
  expect([denied.status, ((await denied.json()) as { code?: string }).code]).toEqual([403, 'scope']);
  // Aprobar es gastar: allow tampoco pasa sin spend, y la tarjeta sigue pendiente; rechazarla sí.
  expect((await decide('write', 'c1', 'allow')).status).toBe(403);
  expect((await decide('write', 'c1', 'skip')).status).toBe(200);
  await first;
  const second = card('c2');
  expect((await decide('all', 'c2', 'always')).status).toBe(200);
  await second;
  expect(approvals.alwaysTools('a')).toEqual(['mcp__wt__generate_image']);
});

test('el dueño va antes que spend: un parentId ajeno con imageGeneration y sin spend es 404, no 403', async () => {
  const bySet: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user']), scopes: h['x-scopes'] === 'write' ? new Set(['chat:read' as const, 'chat:write' as const]) : ALL_SCOPES }) };
  const at = await boot({ session: bySet });
  const id = 'chata'.padEnd(32, '0');
  await post(at, 'a', 'chata', { prompt: 'hola' });
  await (await fetch(`${at}/runs/${id}/events?cursor=-1`, as('a'))).text();
  const asB = (body: object) => fetch(`${at}/runs`, as('b', { method: 'POST', headers: { 'x-scopes': 'write' }, body: JSON.stringify(body) }));
  expect((await asB({ prompt: 'x', parentId: id, imageGeneration: { modelId: 'nope' } })).status).toBe(404);
  expect((await asB({ prompt: 'x', imageGeneration: { modelId: 'nope' } })).status).toBe(403);
});

const MEMORIA = '- el color de la marca es azul · mensaje1 · 2026-11-04';

test('instrucciones y memoria de marca por (dueño, marca): cada sesión ve las suyas, local conserva la ruta de siempre', async () => {
  const packs = join(tmp, 'brands');
  mkdirSync(join(packs, 'brand-pack-acme'), { recursive: true });
  writeFileSync(join(packs, 'brand-pack-acme', 'brand.json'), JSON.stringify({ name: 'Acme', accent: 'blue' }));
  const at = await boot({ brandsRoot: packs });
  const put = (user: string, kind: 'instructions' | 'memory', body: object) => fetch(`${at}/brands/acme/${kind}`, as(user, { method: 'PUT', body: JSON.stringify(body) }));
  const get = async (user: string, kind: 'instructions' | 'memory') => (await (await fetch(`${at}/brands/acme/${kind}`, as(user))).json()) as Record<string, unknown>;
  expect((await put('a', 'instructions', { instructions: ['solo de a'] })).status).toBe(200);
  expect((await put('a', 'memory', { text: MEMORIA })).status).toBe(200);
  expect(await get('a', 'instructions')).toEqual({ instructions: ['solo de a'] });
  expect(await get('b', 'instructions')).toEqual({ instructions: [] });
  expect(String((await get('a', 'memory')).text).trim()).toBe(MEMORIA);
  expect((await get('b', 'memory')).text).toBe('');
  // El dueño implícito sigue en la ruta de antes, sin carpeta by-owner: lo que ya estaba en disco sin dueño es suyo.
  server.close();
  const local = await boot({ brandsRoot: packs, session: undefined });
  expect((await fetch(`${local}/brands/acme/instructions`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instructions: ['legado'] }) })).status).toBe(200);
  expect(JSON.parse(readFileSync(join(tmp, 'state', 'brand-instructions', 'acme.json'), 'utf8'))).toEqual(['legado']);
  expect(existsSync(join(tmp, 'state', 'brand-instructions', 'by-owner', ownerSlug('a'), 'acme.json'))).toBe(true);
});

test('un dueño con caracteres de ruta o larguísimo cae en una carpeta de nombre fijo bajo by-owner', async () => {
  const { BrandStore } = await import('../src/runtime/brand-store');
  const store = new BrandStore({ root: join(tmp, 'state'), parseInstructions: (v) => (Array.isArray(v) ? (v as string[]) : undefined) });
  for (const owner of ['../../etc/passwd', 'user_' + 'x'.repeat(400)]) {
    const path = store.memoryPath(owner, 'acme');
    expect(path).toBe(join(tmp, 'state', 'brand-memory', 'by-owner', ownerSlug(owner), 'acme.md'));
    expect(ownerSlug(owner)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }
  // Y se puede escribir de verdad (un nombre largo daba ENAMETOOLONG).
  const long = 'user_' + 'x'.repeat(400);
  store.writeMemory(long, 'acme', '- hecho · m1 · 2026-11-04\n');
  expect(store.memory(long, 'acme')).toContain('hecho');
});

test('un verifier del perfil no puede devolver el dueño local ni uno vacío', async () => {
  const owning = (owner: string): SessionVerifier => ({ verify: async () => ({ owner, scopes: ALL_SCOPES }) });
  for (const owner of ['local', '']) expect(await providerVerifier(owning(owner)).verify({})).toEqual({ code: 'no-session' });
  expect(await providerVerifier(owning('user_1')).verify({})).toMatchObject({ owner: 'user_1' });
  // Por HTTP: el router envuelve el verifier del perfil, así que 'local' sale 401 y no comparte loopback.
  const at = await boot({ session: owning('local') });
  expect((await fetch(`${at}/brands`, as('a'))).status).toBe(401);
  server.close();
  const ok = await boot({ session: owning('user_1') });
  expect((await fetch(`${ok}/brands`, as('a'))).status).toBe(200);
});
