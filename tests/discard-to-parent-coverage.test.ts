// #593: los descartes vuelven al árbol del padre (baseOf), no a HEAD. Con un padre que no es HEAD, volver a HEAD dejaba el
// workspace (y el preview vivo) en la versión de otra rama. Cada caso termina mirando el árbol de trabajo contra el commit
// que debería tener: el del padre, o HEAD en el primer mensaje. Sin LLM ni reloj: agente falso y esperas por intentos.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import type { MessageEntry } from '../src/runtime/shared';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');

/** Qué hace el agente falso. `hang` espera el abort; `stray` escribe fuera de `.wt/plans` en un turno de plan. */
interface Script { write?: boolean; hang?: boolean; stray?: boolean }

let tmp: string;
let root: string;
let servers: Server[];
let scripts: Record<string, Script>;
const started = new Set<string>();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'discard-parent-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  scripts = {};
  started.clear();
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

const agent: Composer = async (req: ComposeRequest) => {
  const dir = req.workspace?.dir as string;
  const id = req.messageId;
  const s = scripts[id] ?? { write: true };
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, '.wt', 'plans', `${id}.md`), PLAN_MD);
    if (s.stray) writeFileSync(join(dir, 'src', `${id}-stray.tsx`), 'export {}\n');
    const origin = new URL(req.approval?.url as string).origin;
    await fetch(`${origin}/mcp/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: `.wt/plans/${id}.md`, summary: 'Plan' } } }),
    });
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: `sess-${id}` } } as unknown as PageModel;
  }
  if (s.write) writeFileSync(join(dir, 'src', `${id}.tsx`), 'export {}\n');
  started.add(id);
  if (s.hang) await new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const files = s.write ? [`src/${id}.tsx`] : [];
  return { sections: [], agent: { files, summary: 'Listo', missing: [], sessionId: `sess-${id}` } } as unknown as PageModel;
};

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), autoRepair: false, ...extra });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const logOf = (id: string): (EngineEvent & { callId?: string })[] => readEvents(join(root, 'logs'), id).events as (EngineEvent & { callId?: string })[];
async function until(what: string, ok: () => boolean, tries = 1000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`discard-parent: ${what} no llegó`);
}
const settled = (id: string) => until(`${id} settled`, () => logOf(id).some((e) => e.type === 'settled'));
async function run(at: string, body: Record<string, unknown>): Promise<void> {
  expect((await send(at, '/runs', body)).status).toBe(202);
  await settled(body.messageId as string);
}
const index = (): Record<string, MessageEntry> => JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, MessageEntry>;
const commitOf = (id: string) => index()[id]?.commit as string;
const git = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
/** Lo que el árbol de trabajo tiene distinto de `commit`: cambios, borrados y archivos nuevos no ignorados. `.wt` queda fuera,
 * como en git-workspace (WT_OUT): es estado del transport (planes), no de la versión. */
const offFrom = (dir: string, commit: string): string[] =>
  [...git(dir, ['diff', '--name-only', commit]).split('\n'), ...git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter((f) => f && !f.startsWith('.wt/')).sort();
const dirOf = (id: string) => join(root, 'ws', index()[id]?.ws as string);

/** a0 → a1 (HEAD). Lo que sigue corre sobre a0, que ya no es HEAD. */
async function twoVersions(at: string): Promise<void> {
  await run(at, { prompt: 'base', messageId: 'a0' });
  await run(at, { prompt: 'mueve HEAD', messageId: 'a1', parentId: 'a0' });
  expect(git(dirOf('a0'), ['rev-parse', 'HEAD']).trim()).toBe(commitOf('a1'));
}

test('recover de un turno caído sin escrituras sobre un padre que no es HEAD: sin versión y el árbol es el del padre', async () => {
  const at = await boot();
  await twoVersions(at);
  scripts.r1 = { hang: true };
  expect((await send(at, '/runs', { prompt: 'cae', messageId: 'r1', parentId: 'a0' })).status).toBe(202);
  await until('r1 arrancó', () => started.has('r1'));
  // Otro transport sobre el mismo root hace de proceso reiniciado: recover corre en su constructor. El primero queda colgado
  // sin abortar, como un kill -9.
  await boot();
  await settled('r1');
  expect(index().r1?.commit).toBeUndefined();
  expect(index().r1).toMatchObject({ outcome: 'stopped', interrupted: true, continuable: false });
  expect(offFrom(dirOf('a0'), commitOf('a0'))).toEqual([]);
});

test('recover de un turno caído con escrituras sobre un padre que no es HEAD: la versión es el padre más lo escrito', async () => {
  const at = await boot();
  await twoVersions(at);
  scripts.r2 = { hang: true, write: true };
  expect((await send(at, '/runs', { prompt: 'cae escribiendo', messageId: 'r2', parentId: 'a0' })).status).toBe(202);
  await until('r2 arrancó', () => started.has('r2'));
  await boot();
  await settled('r2');
  expect(index().r2).toMatchObject({ outcome: 'stopped', interrupted: true });
  // Nada de la rama de a1 se cuela en la versión: contra el padre solo cambia lo que escribió el agente.
  expect(git(dirOf('a0'), ['diff', '--name-only', commitOf('a0'), commitOf('r2')]).split('\n').filter(Boolean)).toEqual(['src/r2.tsx']);
});

test('plan rechazado y plan cancelado sobre un padre que no es HEAD dejan el árbol del padre', async () => {
  const at = await boot();
  await twoVersions(at);
  for (const [id, close] of [['p1', 'reject'], ['p2', 'cancel']] as const) {
    expect((await send(at, '/runs', { prompt: `plan ${id}`, messageId: id, parentId: 'a0', mode: 'plan' })).status).toBe(202);
    await settled(id);
    const callId = logOf(id).find((e) => e.type === 'plan.ready')?.callId as string;
    if (close === 'reject') expect((await send(at, `/chats/${id}/approvals/${callId}`, { decision: 'reject' })).status).toBe(200);
    else expect((await send(at, `/runs/${id}/cancel`, {})).status).toBe(202);
    expect(index()[id]?.plan?.status).toBe(close === 'reject' ? 'rejected' : 'cancelled');
    expect(offFrom(dirOf('a0'), commitOf('a0'))).toEqual([]);
  }
});

test('un turno de plan que escribió fuera de .wt sobre un padre que no es HEAD: se descarta al árbol del padre', async () => {
  const at = await boot();
  await twoVersions(at);
  scripts.p3 = { stray: true };
  expect((await send(at, '/runs', { prompt: 'plan p3', messageId: 'p3', parentId: 'a0', mode: 'plan' })).status).toBe(202);
  await settled('p3');
  expect(index().p3).toMatchObject({ outcome: 'asked', commit: commitOf('a0'), plan: { status: 'pending' } });
  expect(offFrom(dirOf('a0'), commitOf('a0'))).toEqual([]);
});

test('un arreglo de runtime que no tocó nada sobre un padre que no es HEAD no deja versión y vuelve al padre', async () => {
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  const at = await boot({ previews, previewCheck: async () => [{ field: 'preview.runtime', owner: 'L6' as const, kind: 'pageerror', slug: '01-hero', viewport: 1440, message: 'x.map is not a function' }] });
  await twoVersions(at);
  // El preview-check de a0 es tardío: el arreglo se pide cuando ya está en su log.
  await until('preview-check de a0', () => logOf('a0').some((e) => e.type === 'step.end' && (e as { stepId?: string }).stepId === 'transport:preview-check'));
  scripts.f1 = {};
  await run(at, { repair: 'runtime', parentId: 'a0', messageId: 'f1' });
  expect(index().f1?.commit).toBeUndefined();
  expect(index().f1?.outcome).toBe('ok');
  expect(offFrom(dirOf('a0'), commitOf('a0'))).toEqual([]);
});

test('primer mensaje sin padre: un Stop sin escrituras y uno con escrituras sin page.json no dejan versión y el árbol queda en HEAD', async () => {
  const at = await boot();
  for (const [id, s] of [['n1', { hang: true }], ['n2', { hang: true, write: true }]] as const) {
    scripts[id] = s;
    expect((await send(at, '/runs', { prompt: `nuevo ${id}`, messageId: id })).status).toBe(202);
    await until(`${id} arrancó`, () => started.has(id));
    expect((await send(at, `/runs/${id}/cancel`, {})).status).toBe(202);
    await settled(id);
    expect(index()[id]).toMatchObject({ outcome: 'stopped' });
    expect(index()[id]?.commit).toBeUndefined();
    expect(offFrom(join(root, 'ws', id), 'HEAD')).toEqual([]);
  }
});
