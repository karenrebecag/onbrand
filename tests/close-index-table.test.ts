// ADR 0014 Enmienda 1: red para pasar los 15 writes directos del índice (12 en el cierre, 3 en el ciclo) a updateEntry. Cada
// desenlace de cierre deja una entrada de index.json conocida; aquí se compara la entrada ENTERA, no un campo, para que un
// write perdido o uno de más al mover run/materialize/settle salga rojo. Sin LLM ni reloj: agente falso por mensaje y
// esperas acotadas por intentos sobre el log en disco.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';
import type { MessageEntry } from '../src/runtime/shared';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');

/** Qué hace el agente falso en cada mensaje. `hang` escribe (o manda el plan) y espera el abort (Stop o apagado). */
interface Script { write?: boolean; failed?: boolean; hang?: boolean; throws?: boolean }

let tmp: string;
let root: string;
let server: Server | undefined;
let t: Runtime;
let scripts: Record<string, Script>;
const started = new Set<string>();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'close-index-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  scripts = {};
  started.clear();
});
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

const agent: Composer = async (req: ComposeRequest) => {
  const dir = req.workspace?.dir as string;
  const id = req.messageId;
  const sessionId = `sess-${id}`;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, '.wt', 'plans', `${id}.md`), PLAN_MD);
    const origin = new URL(req.approval?.url as string).origin;
    await fetch(`${origin}/mcp/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: `.wt/plans/${id}.md`, summary: 'Plan' } } }),
    });
    if (scripts[id]?.hang) {
      started.add(id);
      await new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId } } as unknown as PageModel;
  }
  const s = scripts[id] ?? { write: true };
  if (s.write) writeFileSync(join(dir, 'src', `${id}.tsx`), 'export {}\n');
  started.add(id);
  if (s.throws) throw new Error('el CLI murió sin result');
  if (s.hang) {
    await new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }
  const files = s.write ? [`src/${id}.tsx`] : [];
  return { sections: [], agent: { files, summary: s.write ? 'Listo' : '¿Qué color?', missing: [], sessionId, ...(s.failed ? { failed: true } : {}) } } as unknown as PageModel;
};

async function boot(): Promise<string> {
  t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const logOf = (id: string): (EngineEvent & { callId?: string })[] => readEvents(join(root, 'logs'), id).events as (EngineEvent & { callId?: string })[];
async function until(what: string, ok: () => boolean, tries = 1000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`close-index: ${what} no llegó`);
}
const settled = (id: string) => until(`${id} settled`, () => logOf(id).some((e) => e.type === 'settled'));
const commits = (ws: string): number => Number(execFileSync('git', ['rev-list', '--all', '--count'], { cwd: join(root, 'ws', ws), encoding: 'utf8' }).trim());
const inTree = (ws: string, file: string): boolean => existsSync(join(root, 'ws', ws, file));
const index = (): Record<string, MessageEntry> => JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, MessageEntry>;

async function run(at: string, body: Record<string, unknown>): Promise<void> {
  const r = await send(at, '/runs', body);
  expect(r.status).toBe(202);
  await settled(body.messageId as string);
}

/** Corre hasta que el agente empezó, corta con POST /cancel y espera el cierre. */
async function stopped(at: string, body: Record<string, unknown>): Promise<void> {
  const id = body.messageId as string;
  expect((await send(at, "/runs", body)).status).toBe(202);
  await until(`${id} arrancó`, () => started.has(id));
  expect((await send(at, `/runs/${id}/cancel`, {})).status).toBe(202);
  await settled(id);
}

async function plan(at: string, id: string, parentId: string): Promise<string> {
  expect((await send(at, '/runs', { prompt: `plan ${id}`, messageId: id, parentId, mode: 'plan' })).status).toBe(202);
  await settled(id);
  return logOf(id).find((e) => e.type === 'plan.ready')?.callId as string;
}

const decide = (at: string, id: string, callId: string, decision: string) => send(at, `/chats/${id}/approvals/${callId}`, { decision });

/** La entrada sin lo que cambia en cada corrida: `at` y los callId salen como marca, y cada commit como el id del primer
 * mensaje que lo tuvo, así "cuelga del padre" se lee como el id del padre. */
function normalized(): Record<string, unknown> {
  const ix = index();
  const owner = new Map<string, string>();
  for (const [id, e] of Object.entries(ix)) if (e.commit && !owner.has(e.commit)) owner.set(e.commit, id);
  return Object.fromEntries(Object.entries(ix).map(([id, e]) => {
    // endedAt es reloj de pared (el cierre lo escribe para recover); su uso lo cubre run-close-crash-window.
    const { at, commit, plan, endedAt: _endedAt, ...rest } = e;
    return [id, { ...rest, ...(typeof at === 'number' ? { at: 'n' } : {}), ...(commit ? { commit: `@${owner.get(commit)}` } : {}), ...(plan ? { plan: { ...plan, callId: 'c' } } : {}) }];
  }));
}

const turn = (prompt: string, parentId?: string) => ({ ws: 'a0', ...(parentId ? { parentId } : {}), title: prompt, prompt, permissionMode: 'ask', at: 'n' });
const planOf = (id: string, status: string) => ({ callId: 'c', path: `.wt/plans/${id}.md`, summary: 'Plan', status, sessionId: `sess-${id}` });
const planTurn = (id: string, parentId: string) => ({ ...turn(`plan ${id}`, parentId), mode: 'plan' });

test('cada desenlace de cierre deja su entrada de index.json completa', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  // Aquí los cierres sin escrituras corren con HEAD en el padre; el caso con un padre que no es HEAD va en su propio test.
  scripts.a1 = {};
  await run(at, { prompt: 'pregunta', messageId: 'a1', parentId: 'a0' });
  scripts.a2 = { failed: true };
  await run(at, { prompt: 'falla sin escribir', messageId: 'a2', parentId: 'a0' });
  scripts.a3 = { hang: true };
  await stopped(at, { prompt: 'stop sin escribir', messageId: 'a3', parentId: 'a0' });
  scripts.a4 = { failed: true, write: true };
  await run(at, { prompt: 'falla con escrituras', messageId: 'a4', parentId: 'a0' });
  scripts.a5 = { hang: true, write: true };
  await stopped(at, { prompt: 'stop con escrituras', messageId: 'a5', parentId: 'a4' });
  await run(at, { prompt: 'follow-up', messageId: 'a6', parentId: 'a5' });
  await plan(at, 'p1', 'a6');
  const p2 = await plan(at, 'p2', 'a6');
  expect((await decide(at, 'p2', p2, 'approve')).status).toBe(200);
  await until('p2 build', () => logOf('p2').filter((e) => e.type === 'settled').length === 2);
  const p3 = await plan(at, 'p3', 'p2');
  expect((await decide(at, 'p3', p3, 'reject')).status).toBe(200);
  await plan(at, 'p4', 'p2');
  expect((await send(at, '/runs/p4/cancel', {})).status).toBe(202);
  await plan(at, 'p5', 'p2');
  await plan(at, 'p6', 'p5');
  await run(at, { restoreFrom: 'a0', messageId: 'r1' });
  expect(normalized()).toEqual({
    a0: { ...turn('base'), sessionId: 'sess-a0', outcome: 'ok', commit: '@a0' },
    a1: { ...turn('pregunta', 'a0'), asked: '¿Qué color?', outcome: 'asked', commit: '@a0' },
    a2: { ...turn('falla sin escribir', 'a0'), outcome: 'failed', continuable: false },
    a3: { ...turn('stop sin escribir', 'a0'), outcome: 'stopped' },
    a4: { ...turn('falla con escrituras', 'a0'), sessionId: 'sess-a4', outcome: 'failed', continuable: true, commit: '@a4' },
    // Un Stop de la persona no es una caída: sin continuable, como el Stop de Lovable.
    a5: { ...turn('stop con escrituras', 'a4'), outcome: 'stopped', commit: '@a5' },
    a6: { ...turn('follow-up', 'a5'), sessionId: 'sess-a6', outcome: 'ok', commit: '@a6' },
    // El plan cuelga del commit del padre hasta que su fase build tenga uno propio.
    p1: { ...planTurn('p1', 'a6'), outcome: 'asked', commit: '@a6', plan: planOf('p1', 'pending') },
    p2: { ...planTurn('p2', 'a6'), outcome: 'ok', sessionId: 'sess-p2', commit: '@p2', plan: planOf('p2', 'approved') },
    p3: { ...planTurn('p3', 'p2'), outcome: 'asked', commit: '@p2', plan: planOf('p3', 'rejected') },
    p4: { ...planTurn('p4', 'p2'), outcome: 'asked', commit: '@p2', plan: planOf('p4', 'cancelled') },
    // Mensaje nuevo sobre un plan pendiente: lo cancela y el turno nuevo sale también en plan, colgando del mismo commit.
    p5: { ...planTurn('p5', 'p2'), outcome: 'asked', commit: '@p2', plan: planOf('p5', 'cancelled') },
    p6: { ...planTurn('p6', 'p5'), outcome: 'asked', commit: '@p2', plan: planOf('p6', 'pending') },
    r1: { ws: 'a0', parentId: 'p2', restoreFrom: 'a0', title: 'Restored base', kind: 'restore', outcome: 'ok', at: 'n', commit: '@r1' },
  });
}, 30_000);

// Condición 7 (#586): "sin escrituras" se mide contra el commit del padre, no contra HEAD. Sobre una versión vieja, run()
// restaura el árbol del padre sin mover HEAD; medido contra HEAD, un Stop o un fallo sin escrituras guardaba una versión con
// el árbol idéntico al del padre (hallazgo QA, #583).
test('Stop y fallo sin escrituras sobre una versión que no es HEAD no dejan versión', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  await run(at, { prompt: 'mueve HEAD', messageId: 'b1', parentId: 'a0' });
  const afterB1 = commits('a0');
  scripts.b2 = { hang: true };
  await stopped(at, { prompt: 'stop sin escribir', messageId: 'b2', parentId: 'a0' });
  // El descarte vuelve al árbol del padre, no a HEAD (b1): si no, el preview vivo mostraba la versión de otra rama.
  expect(inTree('a0', 'src/a0.tsx')).toBe(true);
  expect(inTree('a0', 'src/b1.tsx')).toBe(false);
  scripts.b3 = { throws: true };
  await run(at, { prompt: 'cae sin escribir', messageId: 'b3', parentId: 'a0' });
  scripts.b4 = { failed: true };
  await run(at, { prompt: 'falla sin escribir', messageId: 'b4', parentId: 'a0' });
  const n = normalized();
  expect({ b2: n.b2, b3: n.b3, b4: n.b4 }).toEqual({
    b2: { ...turn('stop sin escribir', 'a0'), outcome: 'stopped' },
    b3: { ...turn('cae sin escribir', 'a0'), outcome: 'failed', continuable: false },
    b4: { ...turn('falla sin escribir', 'a0'), outcome: 'failed', continuable: false },
  });
  expect(inTree('a0', 'src/b1.tsx')).toBe(false);
  // Ninguna de las tres dejó un commit: el repo tiene los mismos que tras b1, y b5 suma exactamente el suyo.
  expect(commits('a0')).toBe(afterB1);
  await run(at, { prompt: 'sigue', messageId: 'b5', parentId: 'a0' });
  expect(normalized().b5).toEqual({ ...turn('sigue', 'a0'), sessionId: 'sess-b5', outcome: 'ok', commit: '@b5' });
  expect(commits('a0')).toBe(afterB1 + 1);
});

// keepPlan mide y descarta contra el padre: un plan pendiente sobre una versión que no es HEAD deja el ws en el árbol de esa
// versión (lo que la persona está planeando), no en el de HEAD.
test('un plan pendiente sobre una versión que no es HEAD conserva el árbol del padre', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  await run(at, { prompt: 'mueve HEAD', messageId: 'b1', parentId: 'a0' });
  const afterB1 = commits('a0');
  const callId = await plan(at, 'p1', 'a0');
  expect(callId).toBeTruthy();
  expect(index().p1?.plan?.status).toBe('pending');
  expect(inTree('a0', 'src/a0.tsx')).toBe(true);
  expect(inTree('a0', 'src/b1.tsx')).toBe(false);
  expect(commits('a0')).toBe(afterB1);
});

test('un apagado a mitad de turno deja la entrada interrumpida, con lo escrito como versión', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  scripts.s1 = { hang: true, write: true };
  expect((await send(at, '/runs', { prompt: 'apagado', messageId: 's1', parentId: 'a0' })).status).toBe(202);
  await until('s1 arrancó', () => started.has('s1'));
  await t.shutdown();
  await settled('s1');
  // Sin sesión del CLI en disco (agente falso) no hay con qué continuar: continuable false aunque haya versión.
  expect(normalized().s1).toEqual({ ...turn('apagado', 'a0'), outcome: 'stopped', interrupted: true, continuable: false, commit: '@s1' });
});

// Regla 5 de la Enmienda 1: tras cada updateEntry se relee la entrada. Estos cierres mezclan una escritura de un colaborador
// (cancelPlan → updateEntry, que reemplaza el objeto del índice) con las del dueño (commit, desenlace): si alguna se hace
// sobre la copia de antes del updateEntry, se pierde. Hoy pasan; tienen que seguir pasando sin cambios tras el corte.
describe('regla 5: dos escrituras del mismo cierre sobreviven las dos', () => {
  test('Stop con el plan ya enviado: el plan queda cancelado Y el turno detenido', async () => {
    const at = await boot();
    await run(at, { prompt: 'base', messageId: 'a0' });
    scripts.q1 = { hang: true };
    expect((await send(at, '/runs', { prompt: 'plan q1', messageId: 'q1', parentId: 'a0', mode: 'plan' })).status).toBe(202);
    await until('q1 plan enviado', () => started.has('q1'));
    expect((await send(at, '/runs/q1/cancel', {})).status).toBe(202);
    await settled('q1');
    const { sessionId: _s, ...plan } = planOf('q1', 'cancelled');
    expect(normalized().q1).toEqual({ ...planTurn('q1', 'a0'), outcome: 'stopped', plan });
  });

  test('apagado con el plan enviado y sin sesión que reanudar: plan cancelado Y turno interrumpido', async () => {
    const at = await boot();
    await run(at, { prompt: 'base', messageId: 'a0' });
    scripts.q2 = { hang: true };
    expect((await send(at, '/runs', { prompt: 'plan q2', messageId: 'q2', parentId: 'a0', mode: 'plan' })).status).toBe(202);
    await until('q2 plan enviado', () => started.has('q2'));
    await t.shutdown();
    await settled('q2');
    const { sessionId: _s, ...plan } = planOf('q2', 'cancelled');
    expect(normalized().q2).toEqual({ ...planTurn('q2', 'a0'), outcome: 'stopped', interrupted: true, continuable: false, plan });
  });

});

// Condición 5 (runId por corrida). El caso dentro del compose está en verde en plan-mode.test.ts ("un cierre tardío del turno
// de plan no corta el SSE del build aprobado mientras esperaba"). Fuera del compose `cancels` ya no existe (se borra al salir
// del compose), así que la guarda vieja no veía el build: el cierre viejo que esperaba sus pasos tardíos emitía settled y
// marcaba el mensaje terminado con el build todavía en build/commit/preview. El token de launch lo cubre sin mirar `cancels`.
// El build fuera del compose se simula con lo único que lo distingue para settle: un launch nuevo (token nuevo) con `cancels`
// vacío mientras el settle viejo espera.
interface CycleInternals { cycle: { settle(id: string): Promise<void>; launch: unknown; runSeq: Map<string, number> }; late: Map<string, Promise<unknown>>; finished: Set<string>; cancels: Map<string, unknown> }
const settledCount = (id: string): number => logOf(id).filter((e) => e.type === 'settled').length;

test('un settle tardío de una corrida vieja no cierra la corrida nueva del mismo mensaje, aunque ya no haya compose', async () => {
  const at = await boot();
  await run(at, { prompt: 'base', messageId: 'a0' });
  const inner = t as unknown as CycleInternals;
  expect(settledCount('a0')).toBe(1);
  inner.finished.delete('a0');
  let release!: () => void;
  inner.late.set('a0', new Promise<void>((r) => { release = r; }));
  inner.cycle.runSeq.set('a0', 1_000_001);
  const old = inner.cycle.settle('a0');
  // Corrida nueva del mismo mensaje: otro token, y cancels vacío porque el build ya salió del compose.
  inner.cycle.runSeq.set('a0', 1_000_002);
  expect(inner.cancels.has('a0')).toBe(false);
  release();
  await old;
  expect(settledCount('a0')).toBe(1);
  expect(inner.finished.has('a0')).toBe(false);
  expect(inner.cycle.runSeq.get('a0')).toBe(1_000_002);
  // El cierre de la corrida nueva sí cierra y limpia su token.
  await inner.cycle.settle('a0');
  expect(settledCount('a0')).toBe(2);
  expect(inner.finished.has('a0')).toBe(true);
  expect(inner.cycle.runSeq.has('a0')).toBe(false);
});

test('dos launch del mismo mensaje reciben tokens distintos y crecientes', async () => {
  const at = await boot();
  const seen: number[] = [];
  await run(at, { prompt: 'uno', messageId: 'k0' });
  const inner = t as unknown as CycleInternals;
  const orig = inner.cycle.runSeq.set.bind(inner.cycle.runSeq);
  inner.cycle.runSeq.set = (id, n) => { if (id === 'k1' || id === 'k2') seen.push(n); return orig(id, n); };
  await run(at, { prompt: 'dos', messageId: 'k1', parentId: 'k0' });
  await run(at, { prompt: 'tres', messageId: 'k2', parentId: 'k1' });
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBeGreaterThan(seen[0] as number);
  expect(inner.cycle.runSeq.size).toBe(0);
});
