import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatAlias, MEDIA_PATHS_MAX, RESERVED_CHAT_ROWS } from '../src/runtime/chat-alias';
import { ROUTES } from '../src/orchestrator/route-table';
import { createChatReservations, MAX_RESERVATIONS, RESERVATIONS_PER_MINUTE } from '../src/runtime/chat-reservations';
import type { Allowlist } from '../src/runtime/runner';
import { Runtime, type Composer } from '../src/runtime/server';
import type { Approvals } from '../src/runtime/approvals';
import { ALL_SCOPES, type Scope, type SessionVerifier } from '../src/runtime/session';

// Base por chat en el Runtime local (orquestador-enrutamiento §1.1, opción A): mismas filas que el orquestador, dueño y chat
// de cada :m/:g comprobados, POST /chats con reserva en memoria hasta la primera corrida (condiciones de Arq y orq, 2026-11-05).
const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const byHeader: SessionVerifier = {
  verify: async (h) => ({ owner: String(h['x-user'] ?? 'local'), scopes: h['x-scopes'] ? new Set(String(h['x-scopes']).split(',') as Scope[]) : ALL_SCOPES }),
};

let tmp: string;
let server: Server;
let at: string;
let runtime: Runtime;

// Tras B3 (#844) solo el camino del agente deja versión, y las variantes lo exigen (variants.ts:164): el composer copia un
// snapshot al workspace, como el e2e del builder.
const SNAPSHOT = join(import.meta.dir, 'fixtures/page-provenance-snapshot');
const snapshotComposer: Composer = async (req) => {
  cpSync(SNAPSHOT, req.workspace!.dir, { recursive: true });
  const files = readdirSync(SNAPSHOT, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name).slice(SNAPSHOT.length + 1));
  return { sections: [], agent: { files, summary: 'snapshot', missing: [], suggestions: [] } };
};

async function boot(): Promise<void> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  const rt = new Runtime({ root: join(tmp, 'state'), allow, agent: true, compose: snapshotComposer, autoRepair: false, build: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), session: byHeader });
  runtime = rt;
  server = rt.listen(0);
  await new Promise((r) => server.once('listening', r));
  at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'chat-alias-'));
  mkdirSync(join(tmp, 'vault'));
  await boot();
});
afterEach(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const as = (user: string, init: RequestInit = {}, scopes?: string): RequestInit =>
  ({ ...init, headers: { 'content-type': 'application/json', 'x-user': user, ...(scopes ? { 'x-scopes': scopes } : {}) } });
const call = (user: string, method: string, path: string, body?: object, scopes?: string) =>
  fetch(`${at}${path}`, as(user, { method, ...(body ? { body: JSON.stringify(body) } : method === 'GET' ? {} : { body: '{}' }) }, scopes));
async function newChat(user: string): Promise<string> {
  const res = await call(user, 'POST', '/chats', {});
  expect(res.status).toBe(201);
  return ((await res.json()) as { chatId: string }).chatId;
}
/** Crea el chat por el alias y espera a que su primera corrida cierre. */
async function chatWithRun(user: string): Promise<string> {
  const id = await newChat(user);
  expect((await call(user, 'POST', `/chats/${id}/runs`, { prompt: 'hola', messageId: id })).status).toBe(202);
  await (await call(user, 'GET', `/chats/${id}/runs/${id}/events?cursor=-1`)).text();
  return id;
}

describe('POST /chats y la primera corrida', () => {
  test('crear un chat y lanzar su primera corrida por el alias; GET /chats lista solo los del dueño', async () => {
    const id = await newChat('a');
    expect(id).toMatch(/^[a-z0-9-]{26,63}$/);
    expect(((await (await call('a', 'GET', '/chats')).json()) as { chats: { chatId: string }[] }).chats.map((c) => c.chatId)).toEqual([id]);
    expect(((await (await call('b', 'GET', '/chats')).json()) as { chats: unknown[] }).chats).toEqual([]);
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'hola', messageId: id })).status).toBe(202);
    const events = await (await call('a', 'GET', `/chats/${id}/runs/${id}/events?cursor=-1`)).text();
    expect(events).toContain('"message.end"');
    expect((await call('a', 'GET', `/chats/${id}`)).status).toBe(200);
  });

  test('GET /chats lista reservas y chats con corridas del dueño, el más reciente primero; las variantes no son chats aparte', async () => {
    const run = await chatWithRun('a');
    const reserved = await newChat('a');
    await chatWithRun('b');
    const list = ((await (await call('a', 'GET', '/chats')).json()) as { chats: { chatId: string; owner: string; title: string; updatedAt: number }[] }).chats;
    expect(list.map((c) => c.chatId)).toEqual([reserved, run]);
    expect(list.every((c) => c.owner === 'a' && typeof c.title === 'string' && c.updatedAt > 0)).toBe(true);
    const res = await call('a', 'POST', `/chats/${run}/runs`, { parentId: run, variants: { sourceId: run, count: 2, creativeRange: 'medium' } });
    expect(res.status).toBe(202);
    expect(((await (await call('a', 'GET', '/chats')).json()) as { chats: { chatId: string }[] }).chats.map((c) => c.chatId).sort()).toEqual([reserved, run].sort());
  });

  test('la reserva es de quien la pidió: otro dueño da 404 y no la gasta', async () => {
    const id = await newChat('a');
    expect((await call('b', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id })).status).toBe(404);
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id })).status).toBe(202);
  });

  test('sin reserva, con otro messageId o con padre no se crea un chat por el alias', async () => {
    const ghost = 'f'.repeat(36);
    expect((await call('a', 'POST', `/chats/${ghost}/runs`, { prompt: 'x', messageId: ghost })).status).toBe(404);
    const id = await newChat('a');
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: 'otro-id-000000000000000000000000' })).status).toBe(404);
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id, parentId: id })).status).toBe(404);
  });

  test('una primera corrida que falla devuelve la reserva; un id ajeno da 404 aunque el cuerpo sea inválido', async () => {
    const id = await newChat('a');
    expect((await call('a', 'POST', `/chats/${id}/runs`, { messageId: id })).status).toBe(400);
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id })).status).toBe(202);
    const other = await newChat('a');
    const bad = await fetch(`${at}/chats/${other}/runs`, as('b', { method: 'POST', body: '{no es json' }));
    expect(bad.status).toBe(404);
  });

  test('dos primeras corridas a la vez: una crea el chat y la otra no, nunca dos', async () => {
    const id = await newChat('a');
    const both = await Promise.all([0, 1].map(() => call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id })));
    expect(both.map((r) => r.status).sort()).toEqual([202, 404]);
  });

  test('un chat solo reservado no responde lo que lee su workspace', async () => {
    const id = await newChat('a');
    for (const [method, path] of [['GET', `/chats/${id}`], ['GET', `/chats/${id}/canvas`], ['POST', `/chats/${id}/media-urls`]] as const) {
      expect([path, (await call('a', method, path, method === 'POST' ? { paths: [`runs/${id}/shots/a.png`] } : undefined)).status]).toEqual([path, 404]);
    }
  });

  test('RESERVED_CHAT_ROWS son filas de route-table, ninguna lee el workspace del chat', () => {
    for (const row of RESERVED_CHAT_ROWS) {
      const route = ROUTES.find((r) => `${r.method} ${r.path}` === row);
      expect([row, route !== undefined && !route.vm.startsWith('/chats/:chat')]).toEqual([row, true]);
    }
  });

  test('el dueño de una reserva usa sus filas antes de la primera corrida; otro dueño o un id sin reservar da 404; la reserva sigue', async () => {
    const id = await newChat('a');
    const loose = '3f0c2b7a-9d14-4e6b-8a55-0c1d2e3f4a5b';
    expect((await call('a', 'GET', `/chats/${id}/brands`)).status).toBe(200);
    for (const [method, path] of [['GET', '/brands'], ['GET', '/connectors/accounts'], ['POST', '/prompt-enhancements'], ['POST', '/preview/heartbeat']] as const) {
      expect([path, (await call('b', method, `/chats/${id}${path}`, method === 'POST' ? { prompt: 'x', visible: [] } : undefined)).status]).toEqual([path, 404]);
      expect([path, (await call('a', method, `/chats/${loose}${path}`, method === 'POST' ? { prompt: 'x', visible: [] } : undefined)).status]).toEqual([path, 404]);
    }
    expect((await call('a', 'POST', `/chats/${id}/runs`, { prompt: 'x', messageId: id })).status).toBe(202);
  });

  test('sobre un chat reservado el scope sigue siendo el de la fila: transcribe sin spend es 403, PUT de marca sin brand:write también', async () => {
    const id = await newChat('a');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(8)], { type: 'audio/webm' }), 'a.webm');
    const res = await fetch(`${at}/chats/${id}/transcribe`, { method: 'POST', body: form, headers: { 'x-user': 'a', 'x-scopes': 'chat:read,chat:write', 'x-wt-request': '1' } });
    expect(res.status).toBe(403);
    expect((await call('a', 'PUT', `/chats/${id}/brands/acme/memory`, { text: 'x' }, 'chat:read,chat:write')).status).toBe(403);
  });
});

describe('alias de un chat con corridas', () => {
  test(':m y :g de otro chat del MISMO dueño son 404, y un follow-up no puede colgar de otro chat', async () => {
    const a = await chatWithRun('a');
    const b = await chatWithRun('a');
    expect((await call('a', 'GET', `/chats/${a}/runs/${a}/files`)).status).toBe(200);
    expect((await call('a', 'GET', `/chats/${a}/runs/${b}/files`)).status).toBe(404);
    expect((await call('a', 'POST', `/chats/${a}/runs`, { prompt: 'sigue', parentId: b })).status).toBe(404);
    expect((await call('a', 'POST', `/chats/${a}/variants/grupo-ajeno/cancel`)).status).toBe(404);
  });

  test('los ids del cuerpo (restoreFrom, variants.sourceId) también son del chat; la primera corrida no trae ninguno', async () => {
    const a = await chatWithRun('a');
    const b = await chatWithRun('a');
    expect((await call('a', 'POST', `/chats/${a}/runs`, { parentId: a, restoreFrom: b })).status).toBe(404);
    expect((await call('a', 'POST', `/chats/${a}/runs`, { parentId: a, variants: { sourceId: b, count: 2 } })).status).toBe(404);
    const r = await newChat('a');
    expect((await call('a', 'POST', `/chats/${r}/runs`, { messageId: r, restoreFrom: b })).status).toBe(404);
  });

  test('las variantes de un chat se leen y cancelan por ese chat', async () => {
    const a = await chatWithRun('a');
    const res = await call('a', 'POST', `/chats/${a}/runs`, { parentId: a, variants: { sourceId: a, count: 2, creativeRange: 'medium' } });
    expect(res.status).toBe(202);
    const { groupId, variants } = (await res.json()) as { groupId: string; variants: { messageId: string }[] };
    expect((await call('a', 'GET', `/chats/${a}/runs/${variants[0]!.messageId}/versions`)).status).toBe(200);
    expect((await call('a', 'POST', `/chats/${a}/variants/${groupId}/cancel`)).status).toBe(202);
    const other = await chatWithRun('a');
    expect((await call('a', 'POST', `/chats/${other}/variants/${groupId}/cancel`)).status).toBe(404);
  });

  // El builder decide por la base del chat (/chats/<chat>/approvals/:callId); la tarjeta de gasto de una variante vive en el ws
  // de la variante, así que se busca entre los ws del chat y no solo en el suyo.
  test('una aprobación pendiente de una variante se decide por la base del chat', async () => {
    const a = await chatWithRun('a');
    const res = await call('a', 'POST', `/chats/${a}/runs`, { parentId: a, variants: { sourceId: a, count: 1, creativeRange: 'medium' } });
    const v = ((await res.json()) as { variants: { messageId: string }[] }).variants[0]!.messageId;
    const approvals = (runtime as unknown as { approvals: Approvals }).approvals;
    const sink = { request: () => undefined, decision: () => undefined };
    const pending = approvals.ask(v, 'ask', new Set(), { tool_name: 'mcp__wt__generate_image', input: { prompt: 'p', target_path: '/images/a.jpg' }, tool_use_id: 'tv1' }, sink);
    expect((await call('a', 'POST', `/chats/${a}/approvals/tv1`, { decision: 'allow' })).status).toBe(200);
    await pending;
    const other = await chatWithRun('a');
    approvals.ask(v, 'ask', new Set(), { tool_name: 'mcp__wt__generate_image', input: { prompt: 'p', target_path: '/images/b.jpg' }, tool_use_id: 'tv2' }, sink);
    expect((await call('a', 'POST', `/chats/${other}/approvals/tv2`, { decision: 'allow' })).status).toBe(404);
    approvals.decide(v, 'tv2', 'skip');
  });

  test('un chat ajeno da 404 por cualquier fila del alias', async () => {
    const a = await chatWithRun('a');
    for (const path of [`/chats/${a}/runs/${a}/files`, `/chats/${a}/brands`, `/chats/${a}/connectors/accounts`]) {
      expect([path, (await call('b', 'GET', path)).status]).toEqual([path, 404]);
    }
  });

  test('el scope sale de la ruta VM: con solo chat:read se lee pero no se cancela', async () => {
    const a = await chatWithRun('a');
    expect((await call('a', 'GET', `/chats/${a}/runs/${a}/versions`, undefined, 'chat:read')).status).toBe(200);
    expect((await call('a', 'POST', `/chats/${a}/runs/${a}/cancel`, undefined, 'chat:read')).status).toBe(403);
  });

  test('lo que el orquestador no expone sigue fuera del alias', async () => {
    const a = await chatWithRun('a');
    for (const rest of ['', '/tree', '/publishable', '/file?path=src/App.tsx']) {
      expect([rest, (await call('a', 'GET', `/chats/${a}/runs/${a}${rest}`)).status]).toEqual([rest, 404]);
    }
  });

  test('conectores por el chat llegan a /connectors; approvals/always sigue en la raíz', async () => {
    const a = await chatWithRun('a');
    const viaChat = await call('a', 'GET', `/chats/${a}/connectors/accounts`);
    const root = await call('a', 'GET', '/connectors/accounts');
    expect(viaChat.status).toBe(root.status);
    expect(await viaChat.text()).toBe(await root.text());
    expect((await call('a', 'GET', `/chats/${a}/approvals/always`)).status).toBe(404);
    expect((await call('a', 'GET', '/approvals/always')).status).toBe(200);
  });

  test('media-urls: forma de §4, sin firma, chat:read basta; otra familia o más de 50 rutas es 400', async () => {
    const a = await chatWithRun('a');
    const paths = [`runs/${a}/shots/a.png`, 'canvas/files/foto.webp'];
    const res = await call('a', 'POST', `/chats/${a}/media-urls`, { paths }, 'chat:read');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { urls: Record<string, string>; expiresAt: number };
    expect(body.urls).toEqual({ [paths[0]!]: paths[0]!, [paths[1]!]: paths[1]! });
    expect(body.expiresAt).toBeGreaterThan(0);
    expect((await call('a', 'POST', `/chats/${a}/media-urls`, { paths: [`runs/${a}/files`] })).status).toBe(400);
    expect((await call('a', 'POST', `/chats/${a}/media-urls`, { paths: ['canvas/files/../x'] })).status).toBe(400);
    expect((await call('a', 'POST', `/chats/${a}/media-urls`, { paths: Array.from({ length: MEDIA_PATHS_MAX + 1 }, (_, i) => `canvas/files/f${i}.png`) })).status).toBe(400);
  });
});

describe('chatAlias (pura)', () => {
  test('traduce solo filas cuya ruta VM no es /chats/:chat; métodos y rutas fuera de la tabla no son alias', () => {
    expect(chatAlias('GET', ['chats', 'c1', 'runs', 'm1', 'events'])).toEqual({ kind: 'route', chatId: 'c1', parts: ['runs', 'm1', 'events'], row: 'GET /runs/:m/events' });
    expect(chatAlias('POST', ['chats', 'c1', 'uploads'])).toEqual({ kind: 'route', chatId: 'c1', parts: ['uploads'], row: 'POST /uploads' });
    expect(chatAlias('GET', ['chats', 'c1', 'canvas'])).toBeUndefined();
    expect(chatAlias('PUT', ['chats', 'c1', 'plans', 'm1'])).toBeUndefined();
    expect(chatAlias('GET', ['chats', 'c1', 'runs', 'm1', 'tree'])).toBeUndefined();
    expect(chatAlias('POST', ['chats', 'c1', 'media-urls'])).toEqual({ kind: 'media-urls', chatId: 'c1' });
  });
});

describe('reservas (topes y vida)', () => {
  test(`${RESERVATIONS_PER_MINUTE} por minuto y ${MAX_RESERVATIONS} por dueño; un id que choca se sortea de nuevo; consumir es del dueño y una sola vez`, () => {
    let t = 0;
    const ids = ['ya-existe', ...Array.from({ length: 200 }, (_, i) => `id-${i}`)];
    const r = createChatReservations({ exists: (id) => id === 'ya-existe', now: () => t, newId: () => ids.shift()! });
    const first = r.reserve('a', '');
    expect(first).toEqual({ ok: true, chatId: 'id-0' });
    for (let i = 1; i < RESERVATIONS_PER_MINUTE; i++) expect(r.reserve('a', '').ok).toBe(true);
    expect(r.reserve('a', '')).toEqual({ ok: false, code: 'rate-limited' });
    expect(r.reserve('b', '').ok).toBe(true);
    for (let m = 1; r.list('a').length < MAX_RESERVATIONS; m++) { t = m * 60_001; for (let i = 0; i < RESERVATIONS_PER_MINUTE && r.list('a').length < MAX_RESERVATIONS; i++) r.reserve('a', ''); }
    t += 60_001;
    expect(r.reserve('a', '')).toEqual({ ok: false, code: 'chat-limit' });
    expect(r.owns('b', 'id-0')).toBe(false);
    expect(r.consume('b', 'id-0')).toBeUndefined();
    const taken = r.consume('a', 'id-0');
    expect(taken?.chatId).toBe('id-0');
    expect(r.consume('a', 'id-0')).toBeUndefined();
    r.restore(taken!);
    expect(r.owns('a', 'id-0')).toBe(true);
    r.consume('a', 'id-0');
    expect(r.list('a').length).toBe(MAX_RESERVATIONS - 1);
  });
});
