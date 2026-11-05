// Barrido de #596-#599 sobre lo que sus tests no fijan: PUT del plan desde otro chat (#596), la zona del steer (#598) y dos
// bordes del install de arranque tolerante (#597): sin preview vivo y con Stop a mitad. Solo HTTP y disco; sin LLM ni reloj.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChildren } from '../src/runtime/children';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import { isoDateInTz } from '../src/runtime/shared';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');
const BRAND = 'acme';
// Kiritimati (UTC+14) y Pago_Pago (UTC-11) están a 25 h: nunca comparten fecha.
const ENV_TZ = 'Pacific/Pago_Pago';
const REQ_TZ = 'Pacific/Kiritimati';

type Ev = EngineEvent & { stepId?: string; status?: string; outcome?: string };
let tmp: string;
let root: string;
let servers: Server[];
let agent: Composer;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sweep-596-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  mkdirSync(join(tmp, 'brands', `brand-pack-${BRAND}`), { recursive: true });
  writeFileSync(join(tmp, 'brands', `brand-pack-${BRAND}`, 'brand.json'), JSON.stringify({ name: 'Acme', accent: 'orange' }));
  servers = [];
});
// El PATH de antes de prepender el bun falso: un test que vence su timeout abandona su función y su finally no corre;
// afterEach sí, y sin esto el resto de la suite lanzaba el bun falso.
const ORIGINAL_PATH = process.env.PATH;
afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  for (const s of servers) s.close();
  await killChildren(0);
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = new Runtime({ root, allow: {}, agent: true, compose: (req, log) => agent(req, log), build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), autoRepair: false, ...extra });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, method: string, path: string, body?: unknown) =>
  fetch(`${at}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const logOf = (id: string): Ev[] => readEvents(join(root, 'logs'), id).events as Ev[];
async function until(what: string, ok: () => boolean, tries = 1000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sweep-596: ${what} no llegó`);
}
const settled = (id: string) => until(`${id} settled`, () => logOf(id).some((e) => e.type === 'settled'));
async function run(at: string, body: Record<string, unknown>): Promise<void> {
  expect((await send(at, 'POST', '/runs', body)).status).toBe(202);
  await settled(body.messageId as string);
}
const outcome = (id: string) => logOf(id).find((e) => e.type === 'message.end')?.outcome;
const rpc = async (req: ComposeRequest, method: string, params?: unknown): Promise<unknown> =>
  fetch(`${new URL(req.approval?.url as string).origin}/mcp/${req.messageId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const page = (files: string[]): PageModel => ({ sections: [], agent: { files, summary: 'Listo', missing: [], sessionId: 's' } }) as unknown as PageModel;
function writeApp(req: ComposeRequest): PageModel {
  writeFileSync(join(req.workspace?.dir as string, 'src', `${req.messageId}.tsx`), 'export {}\n');
  return page([`src/${req.messageId}.tsx`]);
}

describe('#596 PUT /chats/:chat/plans/:id valida :chat', () => {
  test('un borrador desde otro chat da 404 y el plan en disco no cambia', async () => {
    agent = async (req) => {
      if (req.plan?.mode !== 'plan') return writeApp(req);
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
      writeFileSync(join(dir, '.wt', 'plans', `${req.messageId}.md`), PLAN_MD);
      await rpc(req, 'tools/call', { name: 'exit_plan_mode', arguments: { planPath: `.wt/plans/${req.messageId}.md`, summary: 'Plan' } });
      return page([]);
    };
    const at = await boot();
    await run(at, { prompt: 'plan', messageId: 'g1', mode: 'plan' });
    await run(at, { prompt: 'otro chat', messageId: 'h1' });
    const res = await send(at, 'PUT', '/chats/h1/plans/g1', { plan: `${PLAN_MD}\n- línea de otro chat\n` });
    expect(res.status).toBe(404);
    expect(((await (await send(at, 'GET', '/chats/g1/plans/g1')).json()) as { plan: string }).plan).toBe(PLAN_MD);
    // Desde su propio chat el borrador sí entra: el 404 es por :chat, no porque el plan no espere edición.
    expect((await send(at, 'PUT', '/chats/g1/plans/g1', { plan: `${PLAN_MD}\n- propia\n` })).status).toBe(200);
  });
});

describe('#598 zona horaria en un mensaje que entra como steer', () => {
  const memory = (): string => readFileSync(join(root, 'brand-memory', `${BRAND}.md`), 'utf8');

  test('una zona inválida en el steer da 400 sin llegar al agente; una válida pasa a la fecha del remember del turno vivo', async () => {
    const steered: string[] = [];
    let release: () => void = () => {};
    const got = new Promise<void>((r) => { release = r; });
    agent = async (req) => {
      req.steer?.bind((text) => { steered.push(text); release(); return true; });
      await got;
      await rpc(req, 'tools/call', { name: 'remember', arguments: { fact: 'Atienden de lunes a viernes de 9 a 18' } });
      return writeApp(req);
    };
    const at = await boot({ timezone: ENV_TZ });
    expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 's1', brand: BRAND })).status).toBe(202);
    await until('turno vivo', () => logOf('s1').some((e) => e.type === 'message.start'));
    const bad = await send(at, 'POST', '/runs', { prompt: 'y el horario', messageId: 's2', parentId: 's1', timezone: 'Nope/NotAZone' });
    expect(bad.status).toBe(400);
    expect(steered).toEqual([]);
    expect(logOf('s1').some((e) => e.type === 'steer')).toBe(false);
    const ok = await send(at, 'POST', '/runs', { prompt: 'y el horario', messageId: 's3', parentId: 's1', timezone: REQ_TZ });
    expect(ok.ok).toBe(true);
    await settled('s1');
    expect(steered).toEqual(['y el horario']);
    expect(memory()).toContain(isoDateInTz(new Date(), REQ_TZ));
    expect(memory()).not.toContain(isoDateInTz(new Date(), ENV_TZ));
  });
});

// bun falso: anota cada llamada; con HANG cuelga (para el Stop); un "nope" en package.json no existe en el registry; frozen
// exige bun.lock = "lock <cksum>".
const FAKE_BUN = (log: string, hang: string) => `#!/bin/sh
want="lock $(cksum < package.json | cut -d' ' -f1)"
echo "$*" >> "${log}"
[ -f "${hang}" ] && exec sleep 30
grep -q '"nope"' package.json && { echo "error: package \\"nope\\" not found" >&2; exit 1; }
case "$*" in
  *--frozen-lockfile*) [ "$(cat bun.lock 2>/dev/null)" = "$want" ] || { echo "lockfile had changes, but lockfile is frozen" >&2; exit 1; } ;;
  *) echo "$want" > bun.lock ;;
esac
mkdir -p node_modules
`;
const PKG_A = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0"}}\n';
const PKG_B = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n';
const PKG_NOPE = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0","nope":"9.9.9"}}\n';

describe('#597 install de arranque tolerante', () => {
  let path: string | undefined;
  let installs: string;
  let hang: string;
  let pkgs: Record<string, string>;
  beforeEach(() => {
    const scaffold = join(tmp, 'scaffold');
    writeFileSync(join(scaffold, 'package.json'), PKG_A);
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    installs = join(tmp, 'installs');
    hang = join(tmp, 'hang');
    writeFileSync(join(bin, 'bun'), FAKE_BUN(installs, hang));
    chmodSync(join(bin, 'bun'), 0o755);
    execFileSync(join(bin, 'bun'), ['install'], { cwd: scaffold });
    rmSync(installs, { force: true });
    rmSync(join(scaffold, 'node_modules'), { recursive: true, force: true });
    path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    pkgs = {};
  });
  afterEach(() => { process.env.PATH = path; });
  const calls = (): string[] => (existsSync(installs) ? readFileSync(installs, 'utf8').trim().split('\n').filter(Boolean) : []);
  const withPkg = (seen: Record<string, ComposeRequest>): Composer => async (req) => {
    seen[req.messageId] = req;
    const out = writeApp(req);
    const pkg = pkgs[req.messageId];
    if (pkg === undefined) return out;
    writeFileSync(join(req.workspace?.dir as string, 'package.json'), pkg);
    return page([...(out.agent?.files ?? []), 'package.json']);
  };

  test('el install falla con y sin frozen y vite no arranca: el agente corre sin preview vivo, con el error, y el turno cierra', async () => {
    const seen: Record<string, ComposeRequest> = {};
    let previewDown = false;
    const previews = {
      ensure: async () => {
        if (previewDown) throw new Error('vite: Cannot find module');
        return { url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 };
      },
      drainErrors: () => [],
    } as unknown as PreviewPool;
    const inner = withPkg(seen);
    agent = async (req, log) => { previewDown = false; return inner(req, log); };
    const at = await boot({ previews, previewCheck: async () => [] });
    await run(at, { prompt: 'base', messageId: 'v0' });
    pkgs.v1 = PKG_NOPE;
    await run(at, { prompt: 'agrega nope', messageId: 'v1', parentId: 'v0' });
    expect(outcome('v1')).toBe('failed');
    previewDown = true;
    pkgs.v2 = PKG_A;
    await run(at, { prompt: 'arregla', messageId: 'v2', parentId: 'v1' });
    expect(seen.v2?.workspace?.previewUrl).toBeUndefined();
    expect(seen.v2?.workspace?.installError).toContain('nope');
    expect(logOf('v2').some((e) => e.type === 'step.start' && e.stepId === 'transport:preview-live')).toBe(false);
    expect(outcome('v2')).toBe('ok');
  });

  test('un Stop durante el install de arranque no reintenta sin frozen ni llega al agente', async () => {
    const seen: Record<string, ComposeRequest> = {};
    agent = withPkg(seen);
    const at = await boot();
    await run(at, { prompt: 'base', messageId: 'k0' });
    pkgs.k1 = PKG_B;
    await run(at, { prompt: 'agrega b', messageId: 'k1', parentId: 'k0' });
    // Volver a k0 cambia package.json: el arranque reinstala con frozen, y ese install cuelga.
    writeFileSync(hang, '');
    const before = calls().length;
    expect((await send(at, 'POST', '/runs', { prompt: 'sobre k0', messageId: 'k2', parentId: 'k0' })).status).toBe(202);
    await until('install de k2', () => calls().length > before);
    expect((await send(at, 'POST', '/runs/k2/cancel')).status).toBe(202);
    await settled('k2');
    expect(calls().slice(before)).toEqual(['install --frozen-lockfile']);
    expect(logOf('k2').some((e) => e.stepId === 'transport:install-retry')).toBe(false);
    expect(seen.k2).toBeUndefined();
    // Sin versión: el Stop llegó antes de que el agente escribiera.
    expect(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')).k2?.commit).toBeUndefined();
  });

  // HALLAZGO QA de #597 (también en 2c7e1e03): un Stop antes del compose caía en el catch general de run sin mirar la señal y
  // cerraba failed con un evento error. Arreglado en #627 (run-cycle: catch con cancels abortado → keepStopped).
  test('un Stop durante el install de arranque cierra stopped, sin evento error', async () => {
    agent = withPkg({});
    const at = await boot();
    await run(at, { prompt: 'base', messageId: 'j0' });
    pkgs.j1 = PKG_B;
    await run(at, { prompt: 'agrega b', messageId: 'j1', parentId: 'j0' });
    writeFileSync(hang, '');
    const before = calls().length;
    expect((await send(at, 'POST', '/runs', { prompt: 'sobre j0', messageId: 'j2', parentId: 'j0' })).status).toBe(202);
    await until('install de j2', () => calls().length > before);
    expect((await send(at, 'POST', '/runs/j2/cancel')).status).toBe(202);
    await settled('j2');
    expect(logOf('j2').some((e) => e.type === 'error')).toBe(false);
    expect(logOf('j2').some((e) => e.type === 'step.end' && e.stepId === 'transport:stop')).toBe(true);
    expect(logOf('j2').find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'stopped', finishReason: 'stopped' });
    expect(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')).j2).toMatchObject({ outcome: 'stopped' });
  });
});

// HALLAZGO QA de #596 (500 en b70cc248), arreglado en #608: toda ruta con id decodifica con seg() y un `%` malformado da 400.
test('un % malformado en GET /chats/:id, /runs/:id, /runs/:id/cancel, /runs/:id/publish y /variants/:id/cancel da 400, no 500', async () => {
  agent = async (req) => writeApp(req);
  const at = await boot();
  for (const [method, path] of [['GET', '/chats/%ZZ'], ['GET', '/runs/%ZZ'], ['POST', '/runs/%ZZ/cancel'], ['POST', '/runs/%ZZ/publish'], ['POST', '/variants/%ZZ/cancel']] as const) {
    const r = await send(at, method, path, method === 'POST' ? {} : undefined);
    expect({ path, status: r.status }).toEqual({ path, status: 400 });
  }
});
