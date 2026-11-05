// ADR 0014 condición 6, diferidos de PR 2 con dueña QA. 6.6: supersede no deja huérfano un lateChecks (v0-late-steps:77
// mira el log, no el Map). 6.8: shutdown con un tardío en vuelo y con un plan pendiente. Contra run-cycle.ts (claim →
// supersede) y run-close.ts (startLate y su finally). `lateChecks` se lee por cast: por 6.9 sigue siendo un campo de
// Runtime. Sin LLM ni reloj: preview-check diferido a mano y esperas por intentos.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';
import type { MessageEntry } from '../src/runtime/shared';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

let tmp: string;
let root: string;
let servers: Server[];
let checks: { promise: Promise<never[]>; resolve: (v: never[]) => void }[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'late-supersede-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  checks = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  for (const c of checks) c.resolve([]);
  rmSync(tmp, { recursive: true, force: true });
});

const agent: Composer = async (req: ComposeRequest) => {
  const dir = req.workspace?.dir as string;
  const id = req.messageId;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, '.wt', 'plans', `${id}.md`), PLAN_MD);
    await fetch(`${new URL(req.approval?.url as string).origin}/mcp/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: `.wt/plans/${id}.md`, summary: 'Plan' } } }),
    });
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: `sess-${id}` } } as unknown as PageModel;
  }
  writeFileSync(join(dir, 'src', `${id}.tsx`), 'export {}\n');
  return { sections: [], agent: { files: [`src/${id}.tsx`], summary: 'Listo', missing: [], sessionId: `sess-${id}` } } as unknown as PageModel;
};

async function boot(): Promise<{ at: string; t: Runtime; lateChecks: Map<string, AbortController> }> {
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  // Cada preview-check queda en vuelo hasta que el test lo suelta: así el tardío de una versión vive mientras corre otra.
  const previewCheck = () => { const d = deferred<never[]>(); checks.push(d); return d.promise; };
  const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), autoRepair: false, previews, previewCheck });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return { at: `http://127.0.0.1:${(s.address() as { port: number }).port}`, t, lateChecks: (t as unknown as { lateChecks: Map<string, AbortController> }).lateChecks };
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const logOf = (id: string): (EngineEvent & { stepId?: string; callId?: string; error?: { type?: string } })[] => readEvents(join(root, 'logs'), id).events as never;
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`late-supersede: ${what} no llegó`);
}
const has = (id: string, type: string) => () => logOf(id).some((e) => e.type === type);
const checkEnd = (id: string) => logOf(id).filter((e): e is Extract<ReturnType<typeof logOf>[number], { type: 'step.end' }> => e.type === 'step.end' && e.stepId === 'transport:preview-check');
const index = (): Record<string, MessageEntry> => JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, MessageEntry>;

describe('6.6 supersede no deja huérfano un lateChecks', () => {
  test('el check viejo sale del Map al supersede, su finally tardío no borra el del turno nuevo y al final el Map queda vacío', async () => {
    const { at, lateChecks } = await boot();
    expect((await send(at, '/runs', { prompt: 'base', messageId: 'm1' })).status).toBe(202);
    await until('check de m1 en vuelo', () => checks.length === 1);
    const ws = index().m1?.ws as string;
    const old = lateChecks.get(ws);
    expect(old?.signal.aborted).toBe(false);
    // m2 reclama el workspace: supersede corta el check de m1 y lo saca del Map.
    expect((await send(at, '/runs', { prompt: 'cambio', messageId: 'm2', parentId: 'm1' })).status).toBe(202);
    await until('check de m2 en vuelo', () => checks.length === 2);
    expect(old?.signal.aborted).toBe(true);
    const mine = lateChecks.get(ws);
    expect(mine).toBeDefined();
    expect(mine).not.toBe(old);
    await until('m1 settled', has('m1', 'settled'));
    expect(checkEnd('m1')).toHaveLength(1);
    expect(checkEnd('m1')[0]?.error?.type).toBe('superseded');
    // El check de m1 termina tarde: su finally no puede borrar el controlador de m2.
    checks[0]?.resolve([]);
    await new Promise((r) => setTimeout(r, 50));
    expect(lateChecks.get(ws)).toBe(mine);
    expect(mine?.signal.aborted).toBe(false);
    checks[1]?.resolve([]);
    await until('m2 settled', has('m2', 'settled'));
    expect(checkEnd('m2')[0]).toMatchObject({ status: 'ok' });
    expect([...lateChecks.keys()]).toEqual([]);
  });

  test('una cadena de tres turnos seguidos sobre el mismo workspace deja una sola entrada viva y ninguna al terminar', async () => {
    const { at, lateChecks } = await boot();
    let parent: string | undefined;
    for (const [n, id] of ['c1', 'c2', 'c3'].entries()) {
      expect((await send(at, '/runs', { prompt: id, messageId: id, ...(parent ? { parentId: parent } : {}) })).status).toBe(202);
      await until(`check de ${id}`, () => checks.length === n + 1);
      expect(lateChecks.size).toBe(1);
      parent = id;
    }
    for (const c of checks) c.resolve([]);
    for (const id of ['c1', 'c2', 'c3']) await until(`${id} settled`, has(id, 'settled'));
    expect(lateChecks.size).toBe(0);
    expect(['c1', 'c2'].map((id) => checkEnd(id)[0]?.error?.type)).toEqual(['superseded', 'superseded']);
  });
});

describe('6.8 shutdown', () => {
  test('con un preview-check tardío en vuelo: lo corta, el mensaje cierra con settled y el Map queda vacío', async () => {
    const { at, t, lateChecks } = await boot();
    expect((await send(at, '/runs', { prompt: 'base', messageId: 's1' })).status).toBe(202);
    await until('check de s1 en vuelo', () => checks.length === 1);
    const ctl = [...lateChecks.values()][0];
    await t.shutdown(500);
    expect(ctl?.signal.aborted).toBe(true);
    await until('s1 settled', has('s1', 'settled'));
    expect(checkEnd('s1')).toHaveLength(1);
    expect(checkEnd('s1')[0]?.status).toBe('error');
    // QA 6.8: el apagado no se reporta como "otra corrida empezó".
    expect(checkEnd('s1')[0]).toMatchObject({ label: 'Preview check stopped', error: { type: 'stopped' } });
    // La versión ya estaba guardada antes del tardío: el apagado no la toca.
    expect(index().s1).toMatchObject({ outcome: 'ok' });
    expect(index().s1?.commit).toBeString();
    expect(lateChecks.size).toBe(0);
  });

  test('con un plan pendiente (turno de plan ya cerrado): el plan sigue pendiente y se aprueba tras reiniciar', async () => {
    const { at, t } = await boot();
    expect((await send(at, '/runs', { prompt: 'base', messageId: 'b0' })).status).toBe(202);
    await until('b0 check', () => checks.length === 1);
    checks[0]?.resolve([]);
    await until('b0 settled', has('b0', 'settled'));
    expect((await send(at, '/runs', { prompt: 'plan', messageId: 'p1', parentId: 'b0', mode: 'plan' })).status).toBe(202);
    await until('p1 settled', has('p1', 'settled'));
    const before = index().p1;
    expect(before?.plan?.status).toBe('pending');
    await t.shutdown(500);
    for (const s of servers) s.close();
    // El apagado no decide el plan (§8): ni cancelled ni un evento nuevo en su log.
    expect(index().p1).toEqual(before);
    const { at: at2 } = await boot();
    const callId = logOf('p1').find((e) => e.type === 'plan.ready')?.callId as string;
    expect((await send(at2, `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
    await until('build de p1', () => logOf('p1').filter((e) => e.type === 'message.end').length === 2);
    expect(index().p1?.plan?.status).toBe('approved');
    expect(index().p1?.commit).not.toBe(index().b0?.commit);
  });
});
