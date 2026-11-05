// installDeps tras #590: la marca sale antes de reinstalar y vuelve con el hash post-install; el install de cierre va sin
// --frozen-lockfile cuando hubo agente. Un bun falso modela frozen: con --frozen-lockfile falla si bun.lock no corresponde
// a package.json; sin él reescribe bun.lock. Sin red ni reloj: esperas por intentos sobre el log en disco.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChildren } from '../src/runtime/children';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import { INSTALLED_MARK } from '../src/runtime/preview-dist';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';

/** Lo que el agente falso escribe en cada mensaje, además de su sección. */
interface Script { pkg?: string; lock?: string }

let tmp: string;
let root: string;
let server: Server | undefined;
let scripts: Record<string, Script>;
let path: string | undefined;
let installs: string;
let failNext: string;
let prompts: Record<string, string>;

const PKG_A = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0"}}\n';
const PKG_B = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0","b":"2.0.0"}}\n';

// bun falso: anota cada llamada; si existe FAIL_NEXT falla tantas veces como diga (vacío = una; red caída); una dependencia
// "nope" no existe en el registry y falla siempre; frozen exige bun.lock = "lock <cksum>".
const FAKE_BUN = (log: string, fail: string) => `#!/bin/sh
want="lock $(cksum < package.json | cut -d' ' -f1)"
echo "$*" >> "${log}"
if [ -f "${fail}" ]; then n=$(cat "${fail}"); n=$((\${n:-1} - 1)); if [ "$n" -le 0 ]; then rm -f "${fail}"; else echo "$n" > "${fail}"; fi; exit 1; fi
grep -q '"nope"' package.json && { echo "error: package \"nope\" not found" >&2; exit 1; }
case "$*" in
  *--frozen-lockfile*) [ "$(cat bun.lock 2>/dev/null)" = "$want" ] || { echo "lockfile had changes, but lockfile is frozen" >&2; exit 1; } ;;
  *) echo "$want" > bun.lock ;;
esac
mkdir -p node_modules
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'install-deps-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  writeFileSync(join(scaffold, 'package.json'), PKG_A);
  mkdirSync(join(tmp, 'vault'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  installs = join(tmp, 'installs');
  failNext = join(tmp, 'fail-next');
  writeFileSync(join(bin, 'bun'), FAKE_BUN(installs, failNext));
  chmodSync(join(bin, 'bun'), 0o755);
  // El scaffold trae un lockfile consistente con su package.json, como el real.
  execFileSync(join(bin, 'bun'), ['install'], { cwd: scaffold });
  rmSync(installs, { force: true });
  rmSync(join(scaffold, 'node_modules'), { recursive: true, force: true });
  path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  scripts = {};
  prompts = {};
});
afterEach(async () => {
  process.env.PATH = path;
  server?.close();
  server = undefined;
  await killChildren(0);
  rmSync(tmp, { recursive: true, force: true });
});

const agent: Composer = async (req: ComposeRequest) => {
  const dir = req.workspace?.dir as string;
  const s = scripts[req.messageId] ?? {};
  prompts[req.messageId] = req.prompt;
  const files = [`src/${req.messageId}.tsx`];
  writeFileSync(join(dir, files[0] as string), 'export {}\n');
  if (s.pkg !== undefined) { writeFileSync(join(dir, 'package.json'), s.pkg); files.push('package.json'); }
  if (s.lock !== undefined) { writeFileSync(join(dir, 'bun.lock'), s.lock); files.push('bun.lock'); }
  return { sections: [], agent: { files, summary: 'Listo', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
};

async function boot(): Promise<string> {
  const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const logOf = (id: string): (EngineEvent & { stepId?: string; status?: string })[] => readEvents(join(root, 'logs'), id).events as (EngineEvent & { stepId?: string; status?: string })[];
async function run(at: string, body: Record<string, unknown>): Promise<void> {
  const id = body.messageId as string;
  expect((await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(202);
  for (let i = 0; i < 1000; i++) {
    if (logOf(id).some((e) => e.type === 'settled')) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`install-deps: ${id} no cerró`);
}
const outcome = (id: string) => (logOf(id).find((e) => e.type === 'message.end') as { outcome?: string } | undefined)?.outcome;
/** Las llamadas a bun de un tramo: cuántas y con qué flags. */
const calls = (): string[] => (existsSync(installs) ? readFileSync(installs, 'utf8').trim().split('\n').filter(Boolean) : []);
const ws = (id: string) => join(root, 'ws', id);
const mark = (id: string) => join(ws(id), 'node_modules', INSTALLED_MARK);

test('el agente agrega una dependencia: el cierre instala sin frozen, el lock reescrito entra en la versión y el siguiente turno no reinstala', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  expect(calls()).toEqual(['install --frozen-lockfile']);
  scripts.a1 = { pkg: PKG_B };
  await run(at, { prompt: 'agrega b', messageId: 'a1', parentId: 'a0' });
  expect(outcome('a1')).toBe('ok');
  expect(calls().slice(1)).toEqual(['install']);
  // El lockfile que dejó el install de cierre es el del commit: un clon de la versión instala con frozen.
  const lock = execFileSync('git', ['show', 'HEAD:bun.lock'], { cwd: ws('a0'), encoding: 'utf8' });
  expect(lock).toBe(readFileSync(join(ws('a0'), 'bun.lock'), 'utf8'));
  await run(at, { prompt: 'sigue', messageId: 'a2', parentId: 'a1' });
  expect(outcome('a2')).toBe('ok');
  expect(calls()).toHaveLength(2);
});

test('el agente edita solo el lockfile: el cierre lo reconcilia y la marca coincide con lo que quedó', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'b0' });
  scripts.b1 = { lock: 'lock basura\n' };
  await run(at, { prompt: 'toca el lock', messageId: 'b1', parentId: 'b0' });
  expect(outcome('b1')).toBe('ok');
  expect(calls().slice(1)).toEqual(['install']);
  await run(at, { prompt: 'sigue', messageId: 'b2', parentId: 'b1' });
  expect(outcome('b2')).toBe('ok');
  expect(calls()).toHaveLength(2);
});

test('con marca vieja, un install que falla deja el workspace sin marca y el turno siguiente reinstala', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'c0' });
  scripts.c1 = { pkg: PKG_B };
  await run(at, { prompt: 'agrega b', messageId: 'c1', parentId: 'c0' });
  // Volver a c0 cambia package.json: la marca (de B) es vieja. La red sigue caída en el arranque (frozen y su reintento) y
  // en el cierre: el turno cae sin marca.
  writeFileSync(failNext, '3');
  await run(at, { prompt: 'sobre c0', messageId: 'c2', parentId: 'c0' });
  expect(outcome('c2')).toBe('failed');
  expect(existsSync(mark('c0'))).toBe(false);
  await run(at, { prompt: 'otra vez sobre c0', messageId: 'c3', parentId: 'c0' });
  expect(outcome('c3')).toBe('ok');
  expect(existsSync(mark('c0'))).toBe(true);
});

test('follow-up sobre una versión cuyo package.json difiere del HEAD: reinstala con frozen y vuelve a instalar al regresar', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'd0' });
  scripts.d1 = { pkg: PKG_B };
  await run(at, { prompt: 'agrega b', messageId: 'd1', parentId: 'd0' });
  const before = calls().length;
  await run(at, { prompt: 'sobre d0', messageId: 'd2', parentId: 'd0' });
  expect(outcome('d2')).toBe('ok');
  expect(calls().slice(before)).toEqual(['install --frozen-lockfile']);
  await run(at, { prompt: 'sobre d1', messageId: 'd3', parentId: 'd1' });
  expect(outcome('d3')).toBe('ok');
  expect(calls().slice(before + 1)).toEqual(['install --frozen-lockfile']);
});

// HALLAZGO QA (rojo en main 47f3ecd3, transport.ts:1213): si el install de cierre cae después de que el agente movió deps,
// la versión failed guarda package.json nuevo con el lock viejo, y el install de arranque de cada follow-up sobre ella iba con
// --frozen-lockfile, que fallaba antes del compose: el agente nunca corría y el hilo quedaba atascado. Ahora el arranque
// reintenta sin frozen.
test('el install de cierre falla tras un cambio de deps: el siguiente turno, con la red de vuelta, no queda atascado en frozen', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'e0' });
  scripts.e1 = { pkg: PKG_B };
  writeFileSync(failNext, '');
  await run(at, { prompt: 'agrega b', messageId: 'e1', parentId: 'e0' });
  expect(outcome('e1')).toBe('failed');
  // La versión failed trae package.json B con el lock de A.
  expect(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: ws('e0'), encoding: 'utf8' })).toBe(PKG_B);
  const before = calls().length;
  await run(at, { prompt: 'sigue', messageId: 'e2', parentId: 'e1' });
  expect(outcome('e2')).toBe('ok');
  expect(calls().slice(before)).toEqual(['install --frozen-lockfile', 'install']);
  expect(prompts.e2).toBe('sigue');
  // El lock reconciliado entra en la versión: el turno siguiente no reinstala.
  await run(at, { prompt: 'otra', messageId: 'e3', parentId: 'e2' });
  expect(calls()).toHaveLength(before + 2);
});

// Una dependencia que no existe falla con y sin frozen: el turno no aborta, el agente corre con el error en su prompt y,
// si arregla package.json, el install de cierre deja el hilo sano.
test('dep inexistente: el arranque falla dos veces, el agente corre con el error y al arreglar package.json el turno cierra ok', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'f0' });
  const PKG_NOPE = '{"name":"ws","private":true,"dependencies":{"a":"1.0.0","nope":"9.9.9"}}\n';
  scripts.f1 = { pkg: PKG_NOPE };
  await run(at, { prompt: 'agrega nope', messageId: 'f1', parentId: 'f0' });
  expect(outcome('f1')).toBe('failed');
  const before = calls().length;
  scripts.f2 = { pkg: PKG_A };
  await run(at, { prompt: 'arregla', messageId: 'f2', parentId: 'f1' });
  const evs = logOf('f2');
  expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:install')?.status).toBe('error');
  expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:install-retry')?.status).toBe('error');
  expect(prompts.f2).toStartWith('arregla\n\n');
  expect(prompts.f2).toContain('nope not found');
  expect(outcome('f2')).toBe('ok');
  expect(calls().slice(before)).toEqual(['install --frozen-lockfile', 'install', 'install']);
  expect(existsSync(mark('f0'))).toBe(true);
});
