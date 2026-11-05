// PR 1 de ADR 0014 Enmienda 1 (#612): end() escribe el índice ANTES del message.end, "si el proceso muere entre los dos,
// recover ve done=true" (run-close.ts:114). Aquí se simula esa caída sobre el disco: cada cierre corre entero, después se
// corta su log en el message.end (el índice ya quedó escrito) y un segundo Runtime sobre el mismo root hace de proceso
// reiniciado. Solo HTTP y disco. Sin LLM ni reloj.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';
import type { MessageEntry } from '../src/runtime/shared';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');
interface Script { write?: boolean; hang?: boolean; throws?: boolean }

let tmp: string;
let root: string;
let servers: Server[];
let scripts: Record<string, Script>;
const started = new Set<string>();
let buildHangs = false;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crash-window-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  scripts = {};
  started.clear();
  buildHangs = false;
});
afterEach(() => {
  for (const s of servers) s.close();
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
  const s = scripts[id] ?? { write: true };
  if (s.write) writeFileSync(join(dir, 'src', `${id}.tsx`), 'export {}\n');
  started.add(id);
  if (s.throws) throw new Error('el CLI murió sin result');
  if (s.hang || (req.plan?.mode === 'build' && buildHangs)) await new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const files = s.write ? [`src/${id}.tsx`] : [];
  return { sections: [], agent: { files, summary: s.write ? 'Listo' : '¿Qué color?', missing: [], sessionId: `sess-${id}` } } as unknown as PageModel;
};

async function boot(): Promise<string> {
  const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), autoRepair: false });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const logPath = (id: string) => join(root, 'logs', `${id}.ndjson`);
const logOf = (id: string): EngineEvent[] => readEvents(join(root, 'logs'), id).events;
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`crash-window: ${what} no llegó`);
}
const settled = (id: string) => until(`${id} settled`, () => logOf(id).some((e) => e.type === 'settled'));
const index = (): Record<string, MessageEntry> => JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, MessageEntry>;
const closing = (e: MessageEntry | undefined) => ({ outcome: e?.outcome, commit: e?.commit, interrupted: e?.interrupted, continuable: e?.continuable, plan: e?.plan?.status });

/** La caída del comentario de end(): el índice ya tiene el desenlace y el log termina justo antes de su message.end. */
function crashBeforeMessageEnd(id: string): void {
  const lines = readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean);
  const at = lines.findLastIndex((l) => (JSON.parse(l) as { type: string }).type === 'message.end');
  expect(at).toBeGreaterThan(0);
  writeFileSync(logPath(id), `${lines.slice(0, at).join('\n')}\n`);
}

/** Cada desenlace con versión o con commit heredado, como lo dejó end(). */
async function closes(at: string): Promise<void> {
  const run = async (body: Record<string, unknown>) => { expect((await send(at, '/runs', body)).status).toBe(202); await settled(body.messageId as string); };
  await run({ prompt: 'base', messageId: 'a0' });
  await run({ prompt: 'ok', messageId: 'ok1', parentId: 'a0' });
  scripts.st1 = { write: true, hang: true };
  expect((await send(at, '/runs', { prompt: 'para', messageId: 'st1', parentId: 'ok1' })).status).toBe(202);
  await until('st1 arrancó', () => started.has('st1'));
  expect((await send(at, '/runs/st1/cancel', {})).status).toBe(202);
  await settled('st1');
  scripts.fa1 = { write: true, throws: true };
  await run({ prompt: 'cae', messageId: 'fa1', parentId: 'st1' });
  scripts.q1 = {};
  await run({ prompt: 'pregunta', messageId: 'q1', parentId: 'fa1' });
  await run({ prompt: 'plan', messageId: 'p1', parentId: 'fa1', mode: 'plan' });
}

const IDS = ['ok1', 'st1', 'fa1', 'q1', 'p1'] as const;

// end() escribe el índice antes del message.end (run-close.ts end). Si el proceso cae entre los dos, `done` (que sale del
// log, events.ts:90) es false: recover reemite el message.end con lo del índice, sin recalcular, porque endedAt es posterior
// al último message.start. Antes reescribía stopped/failed/asked → ok y el plan asked → stopped (hallazgo QA en 3870083c).
test('una caída entre el índice y el message.end no cambia el desenlace que end() ya escribió', async () => {
  await closes(await boot());
  const before = Object.fromEntries(IDS.map((id) => [id, closing(index()[id])]));
  // Línea base: lo que dejó cada cierre.
  expect(before).toMatchObject({ ok1: { outcome: 'ok' }, st1: { outcome: 'stopped' }, fa1: { outcome: 'failed' }, q1: { outcome: 'asked' }, p1: { outcome: 'asked', plan: 'pending' } });
  for (const id of IDS) crashBeforeMessageEnd(id);
  for (const s of servers) s.close();
  await boot();
  for (const id of IDS) await settled(id);
  const after = Object.fromEntries(IDS.map((id) => [id, closing(index()[id])]));
  // Lo que dice el log al final tiene que coincidir con el índice, y el commit no se pierde.
  for (const id of IDS) {
    const end = logOf(id).findLast((e) => e.type === 'message.end') as { outcome?: string } | undefined;
    expect({ id, log: end?.outcome }).toEqual({ id, log: after[id]?.outcome });
    expect({ id, commit: after[id]?.commit }).toEqual({ id, commit: before[id]?.commit });
  }
  expect(Object.fromEntries(IDS.map((id) => [id, after[id]?.outcome]))).toEqual(Object.fromEntries(IDS.map((id) => [id, before[id]?.outcome])));
  expect(after.p1?.plan).toBe('pending');
  // reemitEnd también emite el snapshot que el corte se llevó: con archivos si el commit es propio, sin archivos si es el
  // del padre (pregunta, plan).
  expect(snap('ok1')).toMatchObject({ commit: before.ok1?.commit });
  expect(snap('ok1')?.files).toContain('page.json');
  expect(snap('q1')).toMatchObject({ commit: before.q1?.commit, files: [] });
  expect(snap('p1')).toMatchObject({ commit: before.p1?.commit, files: [] });
});

const snap = (id: string) => logOf(id).findLast((e) => e.type === 'snapshot') as { commit?: string; files?: string[] } | undefined;

// QA sobre #632: materialize emite los archivos que el turno cambió (run-close.ts:336, changedFiles contra la base) y
// reemitEnd los de PAGE_PATHS del árbol (run-close.ts:135). Tras la caída, un turno ok que tocó public/ o un archivo fuera
// de src/sections pierde esos nombres: run-state.ts:345 (assets nuevos) mira snapshot.files. Rojo hasta que reemitEnd
// emita la misma lista que el cierre original.
test.failing('el snapshot reemitido de un turno ok lista los mismos archivos que el original', async () => {
  const at = await boot();
  const run = async (body: Record<string, unknown>) => { expect((await send(at, '/runs', body)).status).toBe(202); await settled(body.messageId as string); };
  await run({ prompt: 'base', messageId: 'a0' });
  await run({ prompt: 'ok', messageId: 'ok1', parentId: 'a0' });
  const original = snap('ok1')?.files;
  crashBeforeMessageEnd('ok1');
  for (const s of servers) s.close();
  await boot();
  await settled('ok1');
  expect(snap('ok1')?.files).toEqual(original as string[]);
});

// El índice de un plan que cerró asked trae el endedAt de ese turno; la fase build abre otro message.start en el mismo log.
// Si el build cae a mitad, ese endedAt es anterior y recover no lo reemite: cierra por keepStopped (commit heredado del
// padre), como una corrida viva que cayó.
test('una caída a mitad del build de un plan no reusa el desenlace del turno de plan: queda stopped interrumpida', async () => {
  const at = await boot();
  expect((await send(at, '/runs', { prompt: 'base', messageId: 'a0' })).status).toBe(202);
  await settled('a0');
  expect((await send(at, '/runs', { prompt: 'plan', messageId: 'p1', parentId: 'a0', mode: 'plan' })).status).toBe(202);
  await settled('p1');
  const callId = (logOf('p1').find((e) => e.type === 'plan.ready') as { callId?: string } | undefined)?.callId as string;
  buildHangs = true;
  scripts.p1 = { write: false };
  expect((await send(at, `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  await until('build de p1 arrancó', () => started.has('p1'));
  const planEnded = index().p1?.endedAt as number;
  const builds = logOf('p1').filter((e) => e.type === 'message.start');
  expect(builds.length).toBe(2);
  expect(planEnded).toBeLessThan(builds.at(-1)!.at);
  for (const s of servers) s.close();
  const parentTree = readFileSync(join(root, 'ws', 'a0', 'src', 'main.tsx'), 'utf8');
  await boot();
  await until('p1 cerrado tras el reinicio', () => logOf('p1').filter((e) => e.type === 'message.end').length === 2);
  const end = logOf('p1').findLast((e) => e.type === 'message.end') as { outcome?: string; interrupted?: boolean };
  expect(end).toMatchObject({ outcome: 'stopped', interrupted: true });
  expect(index().p1).toMatchObject({ outcome: 'stopped', interrupted: true, plan: { sessionId: 'sess-p1' } });
  expect(readFileSync(join(root, 'ws', 'a0', 'src', 'main.tsx'), 'utf8')).toBe(parentTree);
});

// Revisión de Arq (#632): la aprobación puede llegar en el mismo milisegundo en que end() cerró el plan, y el build abre
// su message.start con ese mismo `at`. Ese endedAt no es posterior al último message.start: recover recalcula (stopped
// interrumpida) en vez de reemitir el asked del plan y dejar el build caído como si nunca hubiera empezado.
test('una caída del build cuyo message.start cae en el mismo ms que el cierre del plan recalcula, no reemite asked', async () => {
  const at = await boot();
  expect((await send(at, '/runs', { prompt: 'base', messageId: 'a0' })).status).toBe(202);
  await settled('a0');
  expect((await send(at, '/runs', { prompt: 'plan', messageId: 'p1', parentId: 'a0', mode: 'plan' })).status).toBe(202);
  await settled('p1');
  const callId = (logOf('p1').find((e) => e.type === 'plan.ready') as { callId?: string } | undefined)?.callId as string;
  buildHangs = true;
  scripts.p1 = { write: false };
  expect((await send(at, `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  await until('build de p1 arrancó', () => started.has('p1'));
  for (const s of servers) s.close();
  const planEnded = index().p1?.endedAt as number;
  // El reloj no da dos ms distintos a la fuerza: se fija en disco el empate que la carrera produciría.
  const lines = readFileSync(logPath('p1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; at: number });
  const last = lines.findLastIndex((e) => e.type === 'message.start');
  expect(last).toBeGreaterThan(lines.findIndex((e) => e.type === 'message.end'));
  writeFileSync(logPath('p1'), `${lines.map((e, i) => JSON.stringify(i === last ? { ...e, at: planEnded } : e)).join('\n')}\n`);
  await boot();
  await until('p1 cerrado tras el reinicio', () => logOf('p1').filter((e) => e.type === 'message.end').length === 2);
  const end = logOf('p1').findLast((e) => e.type === 'message.end') as { outcome?: string; interrupted?: boolean };
  expect(end).toMatchObject({ outcome: 'stopped', interrupted: true });
  expect(index().p1).toMatchObject({ outcome: 'stopped', interrupted: true });
});
