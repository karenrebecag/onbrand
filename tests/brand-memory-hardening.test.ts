// Endurecimiento de la memoria de marca (M2, revisión de Arq sobre #549): dónde se escribe (bajo la raíz del transport,
// no junto al pack), carrera entre escrituras de la misma marca, que `remember` no corra en fase plan, y que context.usage
// salga en todos los cierres (asked y plan, no solo con versión). Sin LLM ni reloj.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrandStore, ownerSlug } from '../src/runtime/brand-store';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import { rememberFact } from '../src/runtime/memory-tool';
import { ALL_SCOPES, LOCAL_OWNER, type SessionVerifier } from '../src/runtime/session';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import { isoDateInTz, parseInstructions } from '../src/runtime/shared';

const BRAND = 'acme';
const CONTEXT = { ratio: 0.33, lastTokens: 50_000, floorTokens: 20_000, window: 200_000 };

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'brand-mem-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('(1) la memoria vive bajo la raíz del transport, no junto al pack', () => {
  test('writeMemory escribe en <root>/brand-memory y nada bajo brandsRoot', () => {
    const root = join(tmp, 'state');
    const brandsRoot = join(tmp, 'packs');
    mkdirSync(brandsRoot, { recursive: true });
    const bs = new BrandStore({ root, brandsRoot, parseInstructions });
    bs.writeMemory(LOCAL_OWNER, BRAND, `- hecho · a1 · 2026-11-04`);
    expect(existsSync(join(root, 'brand-memory', `${BRAND}.md`))).toBe(true);
    expect(existsSync(join(brandsRoot, BRAND))).toBe(false);
    expect(bs.memory(LOCAL_OWNER, BRAND)).toContain('hecho');
  });
});

describe('(3) withMemory serializa escrituras concurrentes de la misma marca', () => {
  test('dos remember a la vez conservan ambos hechos', async () => {
    const bs = new BrandStore({ root: join(tmp, 'state'), brandsRoot: join(tmp, 'packs'), parseInstructions });
    const once = (fact: string, messageId: string) =>
      bs.withMemory(LOCAL_OWNER, BRAND, (current) => {
        const o = rememberFact(current, { fact }, { messageId, date: '2026-11-04' });
        if (o.ok && o.added) bs.writeMemory(LOCAL_OWNER, BRAND, o.text);
        return o;
      });
    await Promise.all([once('hecho uno', 'm1'), once('hecho dos', 'm2')]);
    const lines = bs.memory(LOCAL_OWNER, BRAND).split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(bs.memory(LOCAL_OWNER, BRAND)).toContain('hecho uno');
    expect(bs.memory(LOCAL_OWNER, BRAND)).toContain('hecho dos');
  });
});

describe('(ec-3) una lectura en cola ve la escritura que estaba antes', () => {
  // Lo que usa GET /brands/:id/memory: withMemory(id, (c) => c). Encolada detrás de un remember, devuelve el texto ya escrito.
  test('withMemory de lectura pedida sin esperar a la escritura devuelve el texto nuevo', async () => {
    const bs = new BrandStore({ root: join(tmp, 'state'), brandsRoot: join(tmp, 'packs'), parseInstructions });
    bs.writeMemory(LOCAL_OWNER, BRAND, '- viejo · m0 · 2026-11-04');
    const write = bs.withMemory(LOCAL_OWNER, BRAND, () => { bs.writeMemory(LOCAL_OWNER, BRAND, '- nuevo · m1 · 2026-11-04'); return true; });
    const read = bs.withMemory(LOCAL_OWNER, BRAND, (current) => current);
    await write;
    expect(await read).toContain('nuevo');
    expect(await read).not.toContain('viejo');
  });
});

// ---- Harness de servidor para (2) y (4) ----
let servers: Server[];
let seen: ComposeRequest[];
let toolsSeen: string[][];
let rememberReply: { isError?: boolean; content?: { text: string }[] } | undefined;
let noWrite: Set<string>;
let callRemember: Set<string>;

async function fakeAgent(req: ComposeRequest): Promise<PageModel> {
  seen.push(req);
  const origin = new URL(req.approval?.url as string).origin;
  const rpc = async (method: string, params?: unknown): Promise<{ result?: unknown }> =>
    (await (await fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: unknown };
  toolsSeen.push(((await rpc('tools/list')).result as { tools?: { name: string }[] } | undefined)?.tools?.map((t) => t.name) ?? []);
  if (callRemember.has(req.messageId) || (req.plan?.mode === 'plan' && req.brand)) rememberReply = (await rpc('tools/call', { name: 'remember', arguments: { fact: 'Atienden de lunes a viernes de 9 a 18' } })).result as typeof rememberReply;
  const dir = req.workspace?.dir as string;
  if (!noWrite.has(req.messageId)) { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${seen.length}</main>; }\n`); }
  return { sections: [], page: { lang: 'es' }, agent: { files: noWrite.has(req.messageId) ? [] : ['src/App.tsx'], summary: 'ok', missing: [], suggestions: [], question: noWrite.has(req.messageId) ? { question: '¿cuál?' } : undefined, trace: { context: CONTEXT } } } as unknown as PageModel;
}

async function boot(timezone?: string, session?: SessionVerifier): Promise<string> {
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  mkdirSync(join(tmp, 'brands', `brand-pack-${BRAND}`), { recursive: true });
  writeFileSync(join(tmp, 'brands', `brand-pack-${BRAND}`, 'brand.json'), JSON.stringify({ name: 'Acme', accent: 'orange' }));
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, agent: true, compose: fakeAgent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), ...(timezone ? { timezone } : {}), ...(session ? { session } : {}) });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

type Ev = EngineEvent & Record<string, unknown>;
const logOf = (id: string): Ev[] => readEvents(join(tmp, 'state', 'logs'), id).events as Ev[];
async function run(at: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Ev[]> {
  expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).ok).toBe(true);
  for (let i = 0; i < 500; i++) {
    if (logOf(body.messageId as string).some((e) => e.type === 'message.end')) return logOf(body.messageId as string);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sin message.end: ${logOf(body.messageId as string).map((e) => e.type).join(',')}`);
}

describe('(2) remember no corre en fase plan', () => {
  beforeEach(() => { servers = []; seen = []; toolsSeen = []; rememberReply = undefined; noWrite = new Set(); callRemember = new Set(); });
  afterEach(() => { for (const s of servers) s.close(); });

  test('en un turno de plan con marca, remember no se lista y si se llama da isError', async () => {
    const at = await boot();
    await run(at, { prompt: 'landing', messageId: 'p1', brand: BRAND, mode: 'plan' });
    expect(toolsSeen[0]).not.toContain('remember');
    expect(rememberReply?.isError).toBe(true);
  });
});

describe('(4) context.usage sale en todos los cierres', () => {
  beforeEach(() => { servers = []; seen = []; toolsSeen = []; rememberReply = undefined; noWrite = new Set(); callRemember = new Set(); });
  afterEach(() => { for (const s of servers) s.close(); });

  test('cierre de plan (keepPlan) emite context.usage', async () => {
    const at = await boot();
    const evs = await run(at, { prompt: 'landing', messageId: 'q1', brand: BRAND, mode: 'plan' });
    expect(evs.filter((e) => e.type === 'context.usage')).toEqual([expect.objectContaining(CONTEXT)]);
  });

  test('cierre asked (sin escritura) emite context.usage', async () => {
    const at = await boot();
    await run(at, { prompt: 'landing', messageId: 'q2' });
    noWrite.add('q3');
    const evs = await run(at, { prompt: 'una pregunta', messageId: 'q3', parentId: 'q2' });
    expect(evs.filter((e) => e.type === 'context.usage')).toEqual([expect.objectContaining(CONTEXT)]);
  });
});

describe('(ec-1) writeMemory es atómico', () => {
  test('no deja archivos .tmp tras escribir', () => {
    const root = join(tmp, 'state');
    const bs = new BrandStore({ root, brandsRoot: join(tmp, 'packs'), parseInstructions });
    bs.writeMemory(LOCAL_OWNER, BRAND, `- hecho · a1 · 2026-11-04`);
    const files = readdirSync(join(root, 'brand-memory'));
    expect(files).toContain(`${BRAND}.md`);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('(ec-1b) writeMemory limpia su temporal si falla', () => {
  test('un rename que falla no deja .tmp y propaga el error', () => {
    const root = join(tmp, 'state');
    const bs = new BrandStore({ root, brandsRoot: join(tmp, 'packs'), parseInstructions });
    // El destino es un directorio: writeFileSync(tmp) funciona y renameSync falla.
    mkdirSync(join(root, 'brand-memory', `${BRAND}.md`), { recursive: true });
    expect(() => bs.writeMemory(LOCAL_OWNER, BRAND, '- hecho · a1 · 2026-11-04')).toThrow();
    expect(readdirSync(join(root, 'brand-memory')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('(ec-1c) las cadenas de memoria se podan', () => {
  test('N lecturas de ids distintos no dejan entradas, ni siquiera tras un fallo', async () => {
    const bs = new BrandStore({ root: join(tmp, 'state'), brandsRoot: join(tmp, 'packs'), parseInstructions });
    const chains = (bs as unknown as { memoryChains: Map<string, unknown> }).memoryChains;
    await Promise.all(Array.from({ length: 20 }, (_, i) => bs.withMemory(LOCAL_OWNER, `marca-${i}`, (current) => current)));
    await expect(bs.withMemory(LOCAL_OWNER, 'rota', () => { throw new Error('disco'); })).rejects.toThrow('disco');
    expect(chains.size).toBe(0);
  });

  test('con otra sección encolada detrás, la cadena vigente no se borra', async () => {
    const bs = new BrandStore({ root: join(tmp, 'state'), brandsRoot: join(tmp, 'packs'), parseInstructions });
    const chains = (bs as unknown as { memoryChains: Map<string, unknown> }).memoryChains;
    const order: number[] = [];
    const first = bs.withMemory(LOCAL_OWNER, BRAND, () => { order.push(1); });
    const second = bs.withMemory(LOCAL_OWNER, BRAND, () => { order.push(2); });
    await first;
    // La llave de la cadena es (dueño, marca).
    expect(chains.has(`${LOCAL_OWNER}\u0000${BRAND}`)).toBe(true);
    await second;
    expect(order).toEqual([1, 2]);
    expect(chains.size).toBe(0);
  });
});

describe('(ec-2) un fallo de escritura en remember sale como isError de tool', () => {
  beforeEach(() => { servers = []; seen = []; toolsSeen = []; rememberReply = undefined; noWrite = new Set(); callRemember = new Set(); });
  afterEach(() => { for (const s of servers) s.close(); });

  test('si brand-memory no se puede escribir, remember responde isError y el turno cierra', async () => {
    const at = await boot();
    // brand-memory ocupado por un archivo: mkdir/rename de writeMemory falla.
    writeFileSync(join(tmp, 'state', 'brand-memory'), 'x');
    callRemember.add('n1');
    const evs = await run(at, { prompt: 'landing', messageId: 'n1', brand: BRAND });
    expect(rememberReply?.isError).toBe(true);
    expect(evs.some((e) => e.type === 'message.end')).toBe(true);
    // El texto que ve el modelo lleva el errno entre paréntesis, no la ruta absoluta del .tmp.
    const text = rememberReply?.content?.[0]?.text ?? '';
    expect(text).toMatch(/\(.+\)/);
    expect(text).not.toContain(tmp);
    expect(text).not.toContain('.tmp');
  });
});

describe('(ec-4) fecha de la memoria en una zona configurada', () => {
  test('isoDateInTz formatea AAAA-MM-DD en la zona dada; sin zona, UTC', () => {
    const d = new Date('2026-11-05T02:00:00Z'); // 20:00 del 4 en CDMX (UTC-6)
    expect(isoDateInTz(d, 'America/Mexico_City')).toBe('2026-11-04');
    expect(isoDateInTz(d, 'UTC')).toBe('2026-11-05');
    expect(isoDateInTz(d)).toBe('2026-11-05');
    // Más allá de la fecha de UTC: Kiritimati (UTC+14) ya está en el 5 a las 23:00Z del 4.
    expect(isoDateInTz(new Date('2026-11-04T23:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-05');
    expect(isoDateInTz(d, 'America/Mexico_City')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('una timezone inválida falla al construir el Runtime', () => {
    expect(() => new Runtime({ root: join(tmp, 'tzbad'), allow: {}, compose: fakeAgent, imageModels: [], timezone: 'Nope/NotAZone' } as unknown as RuntimeOptions)).toThrow(/timezone inválida/);
  });
});

describe('(tz) zona horaria por request, como user_timezone de Lovable', () => {
  beforeEach(() => { servers = []; seen = []; toolsSeen = []; rememberReply = undefined; noWrite = new Set(); callRemember = new Set(); });
  afterEach(() => { for (const s of servers) s.close(); });
  // Kiritimati (UTC+14) y Pago_Pago (UTC-11) están a 25 h: nunca comparten fecha, sin depender de la hora del test.
  const ENV_TZ = 'Pacific/Pago_Pago';
  const REQ_TZ = 'Pacific/Kiritimati';
  const memory = (): string => readFileSync(join(tmp, 'state', 'brand-memory', `${BRAND}.md`), 'utf8');

  test('la zona del request gana a WT_TZ en la fecha del hecho', async () => {
    const at = await boot(ENV_TZ);
    callRemember.add('z1');
    await run(at, { prompt: 'landing', messageId: 'z1', brand: BRAND, timezone: REQ_TZ });
    expect(memory()).toContain(isoDateInTz(new Date(), REQ_TZ));
    expect(memory()).not.toContain(isoDateInTz(new Date(), ENV_TZ));
  });

  test('sin zona en el request, la fecha usa WT_TZ', async () => {
    const at = await boot(ENV_TZ);
    callRemember.add('z2');
    await run(at, { prompt: 'landing', messageId: 'z2', brand: BRAND });
    expect(memory()).toContain(isoDateInTz(new Date(), ENV_TZ));
  });

  test('una zona que no es IANA da 400 y no crea el mensaje', async () => {
    const at = await boot();
    const r = await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'z3', timezone: 'Nope/NotAZone' }) });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toMatch(/timezone inválida/);
    expect((await fetch(`${at}/chats/z3`)).status).toBe(404);
  });
});

describe('la marca de la corrida es la del dueño del chat', () => {
  beforeEach(() => { servers = []; seen = []; toolsSeen = []; rememberReply = undefined; noWrite = new Set(); callRemember = new Set(); });
  afterEach(() => { for (const s of servers) s.close(); });

  test('applyPageBrand lee las instrucciones del dueño y remember escribe bajo by-owner/<hash>, no en la ruta local', async () => {
    const byUser: SessionVerifier = { verify: async (h) => ({ owner: String(h['x-user']), scopes: ALL_SCOPES }) };
    const at = await boot(undefined, byUser);
    const as = (user: string): Record<string, string> => ({ 'x-user': user });
    const put = await fetch(`${at}/brands/${BRAND}/instructions`, { method: 'PUT', headers: { 'content-type': 'application/json', ...as('a') }, body: JSON.stringify({ instructions: ['tutea siempre'] }) });
    expect(put.status).toBe(200);
    const mine = 'ra'.padEnd(32, '0');
    const theirs = 'rb'.padEnd(32, '0');
    callRemember.add(mine);
    await run(at, { prompt: 'landing', messageId: mine, brand: BRAND }, as('a'));
    await run(at, { prompt: 'landing', messageId: theirs, brand: BRAND }, as('b'));
    // La corrida de a ve sus instrucciones; la de b, ninguna.
    expect(seen.find((r) => r.messageId === mine)?.brand?.instructions).toEqual(['tutea siempre']);
    expect(seen.find((r) => r.messageId === theirs)?.brand?.instructions).toBeUndefined();
    // remember cayó en la carpeta de a, no en la ruta de 'local'.
    expect(existsSync(join(tmp, 'state', 'brand-memory', 'by-owner', ownerSlug('a'), `${BRAND}.md`))).toBe(true);
    expect(existsSync(join(tmp, 'state', 'brand-memory', `${BRAND}.md`))).toBe(false);
    expect(existsSync(join(tmp, 'state', 'brand-memory', 'by-owner', ownerSlug('b'), `${BRAND}.md`))).toBe(false);
  });
});
