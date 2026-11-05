// Arnés de plan mode (M1/H6, docs/spec/plan-mode.md §8 QA). Sin LLM y sin reloj: un agente falso que escribe el plan y
// llama a exit_plan_mode por el MCP `wt`, y esperas acotadas por intentos sobre el log en disco. Los escenarios van como
// test.todo hasta que el código de Secondary/orq esté en la rama integrada; se pasan a `test` al correrlos ahí.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePagePlanMd } from '../src/page-plan-md';
import { foldMessage } from '../src/runtime/event-model';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';

const FIXTURES = join(import.meta.dir, 'fixtures', 'plan-mode');
const planFixture = (name: 'plan.md' | 'plan-edited.md') => readFileSync(join(FIXTURES, name), 'utf8');
// El marcador va dentro de la línea, nunca como prefijo (spec §Edición): ENTRY_RE y FIELD_RE están anclados a ^.
const PINNED = 'usuario:';
const pinnedLines = (md: string) => md.split('\n').filter((l) => l.includes(PINNED));
const planPath = (messageId: string) => join('.wt', 'plans', `${messageId}.md`);

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};

type Req = ComposeRequest;
type PlanEvent = EngineEvent & { callId?: string; path?: string; edited?: boolean; reason?: string; decision?: string };

let tmp: string;
let root: string;
let servers: Server[];
let seen: Req[];
let mcpReplies: unknown[];
/** Fase build: 'fails' termina con error sin escribir (API caída); 'hangs' no vuelve nunca (proceso muerto antes del commit). */
/** Si no es undefined, el turno de plan deja un paso tardío pendiente (como un preview-check lento) que retiene su settle. */
let lateHold: Promise<void> | undefined;
let buildMode: 'ok' | 'fails' | 'hangs' | 'gated';
/** 'gated': el build espera a que el test abra la compuerta, para leer el estado a mitad de la fase. */
let openGate: () => void;
let buildGate: Promise<void>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plan-mode-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  seen = [];
  mcpReplies = [];
  buildMode = 'ok';
  lateHold = undefined;
  buildGate = new Promise<void>((r) => { openGate = r; });
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Agente falso. Plan: escribe .wt/plans/<id>.md y llama a exit_plan_mode. Build: escribe un archivo de src y cierra. */
const fakeAgent: Composer = async (req: Req) => {
  seen.push(req);
  const dir = req.workspace?.dir as string;
  const session = `sess-${req.messageId}`;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, planPath(req.messageId)), planFixture('plan.md'));
    const origin = new URL(req.approval?.url as string).origin;
    const r = await fetch(`${origin}/mcp/${req.messageId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: planPath(req.messageId), summary: 'Landing de pagos en tres secciones' } } }),
    });
    mcpReplies.push(((await r.json()) as { result?: unknown }).result);
    if (lateHold) (lastTransport as unknown as { late: Map<string, Promise<unknown>> }).late.set(req.messageId, lateHold);
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: session } } as unknown as PageModel;
  }
  if (buildMode === 'fails') return { sections: [], agent: { files: [], summary: 'API Error: 529 overloaded', missing: [], failed: true, sessionId: session } } as unknown as PageModel;
  if (buildMode === 'hangs') return new Promise<never>(() => {});
  if (buildMode === 'gated') await buildGate;
  writeFileSync(join(dir, 'src', 'hero.tsx'), 'export {}\n');
  return { sections: [{ role: 'hero', children: [{ component: 'hero' }] }], agent: { files: ['src/hero.tsx'], summary: 'Listo', missing: [], sessionId: session } } as unknown as PageModel;
};

let lastTransport: Runtime;
async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = (lastTransport = new Runtime({ root, allow, agent: true, compose: fakeAgent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), ...extra }));
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (at: string, body: unknown) => send(at, '/runs', body);
const decide = (at: string, chat: string, callId: string, body: Record<string, unknown>) => send(at, `/chats/${chat}/approvals/${callId}`, body);

// GET /runs/:id/events no cierra hasta que el job termina; un plan pendiente lo deja abierto. Se lee el log del disco.
const logOf = (id: string): PlanEvent[] => readEvents(join(root, 'logs'), id).events as PlanEvent[];

/** Espera acotada por intentos, no por tiempo de pared. */
async function until(id: string, ok: (evs: PlanEvent[]) => boolean, tries = 1000): Promise<PlanEvent[]> {
  for (let i = 0; i < tries; i++) {
    const evs = logOf(id);
    if (ok(evs)) return evs;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`plan-mode: ${id} no llegó; eventos: ${logOf(id).map((e) => e.type).join(',')}`);
}

const find = (evs: PlanEvent[], type: string) => evs.find((e) => e.type === type);
const has = (type: string) => (evs: PlanEvent[]) => !!find(evs, type);
const settled = has('settled');
/** El turno de plan ya cierra con su settled; la fase build trae otro después de plan.resumed. */
const builtAfterResume = (evs: PlanEvent[]) => {
  const at = evs.findIndex((e) => e.type === 'plan.resumed');
  return at >= 0 && evs.slice(at).some((e) => e.type === 'settled');
};
const versions = (evs: PlanEvent[]) => evs.filter((e) => e.type === 'snapshot' && (e as { commit?: string }).commit);
const callsFor = (id: string) => seen.filter((r) => r.messageId === id);
const changedOutsidePlans = (ws: string) =>
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ws, encoding: 'utf8' }).split('\n').filter((l) => l && !l.includes('.wt/'));

/** Arranca un turno en plan y devuelve el callId de plan.ready. */
async function startPlan(at: string, messageId: string, extra: Record<string, unknown> = {}): Promise<string> {
  expect((await post(at, { prompt: 'landing de pagos', messageId, mode: 'plan', ...extra })).ok).toBe(true);
  const callId = find(await until(messageId, has('plan.ready')), 'plan.ready')?.callId;
  expect(callId).toBeString();
  return callId as string;
}

describe('plan mode: fixtures', () => {
  test('solo el plan editado trae líneas fijadas, y ambos pasan la validación de exit_plan_mode', () => {
    expect(pinnedLines(planFixture('plan.md'))).toEqual([]);
    expect(pinnedLines(planFixture('plan-edited.md'))).toHaveLength(3);
    // exit_plan_mode exige al menos una entrada en ## Cambios; el marcador en el valor no rompe el parseo de campos.
    expect(parsePagePlanMd(planFixture('plan.md')).sections.map((s) => s.role)).toEqual(['hero', 'features']);
    const edited = parsePagePlanMd(planFixture('plan-edited.md')).sections;
    expect(edited.map((s) => s.role)).toEqual(['hero', 'features']);
    expect(edited[0]?.fields.titular).toBe('usuario: Cobra en minutos, no en días');
  });
});

describe('plan mode (M1/H6)', () => {
  test('(a) turno de plan: plan.start, approval.request kind plan, plan.ready, nada fuera de .wt/plans', async () => {
    const at = await boot();
    await startPlan(at, 'p1');
    const evs = logOf('p1');
    const types = evs.map((e) => e.type);
    expect(find(evs, 'plan.start')).toMatchObject({ path: planPath('p1') });
    expect(evs.find((e) => e.type === 'approval.request')).toMatchObject({ kind: 'plan', input: { planPath: planPath('p1'), summary: 'Landing de pagos en tres secciones', plan: planFixture('plan.md') } });
    expect(types.indexOf('approval.request')).toBeLessThan(types.indexOf('plan.ready'));
    expect(find(evs, 'plan.ready')).toMatchObject({ path: planPath('p1') });
    expect(mcpReplies[0]).not.toHaveProperty('isError');
    const ws = join(root, 'ws', 'p1');
    expect(existsSync(join(ws, planPath('p1')))).toBe(true);
    // Secondary congela el original del agente al validar: es la base del diff de ec.
    expect(readFileSync(join(ws, '.wt', 'plans', 'p1.agent.md'), 'utf8')).toBe(planFixture('plan.md'));
    expect(changedOutsidePlans(ws)).toEqual([]);
  });

  test('(b) sin versión: el turno de plan no tiene commit y el picker no lo lista', async () => {
    const at = await boot();
    await startPlan(at, 'p2');
    expect(versions(logOf('p2'))).toEqual([]);
    const thread = (await (await fetch(`${at}/chats/p2`)).json()) as { messages: { messageId: string; commit: string | null }[] };
    expect(thread.messages.find((m) => m.messageId === 'p2')?.commit ?? null).toBeNull();
  });

  test('(c) approve: fase build en el mismo messageId con resume, y esta sí crea versión', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p3');
    expect((await decide(at, 'p3', callId, { decision: 'approve' })).status).toBe(200);
    const evs = await until('p3', builtAfterResume);
    expect(evs.find((e) => e.type === 'approval.decision' && e.callId === callId)).toMatchObject({ decision: 'allow' });
    expect(find(evs, 'plan.resumed')).toMatchObject({ callId, edited: false });
    const [plan, build] = callsFor('p3');
    expect(plan?.plan).toEqual({ mode: 'plan' });
    expect(build?.plan).toEqual({ mode: 'build', path: planPath('p3'), edited: false });
    expect(build?.resume).toBe('sess-p3');
    expect(versions(evs)).toHaveLength(1);
  });

  test('(c2) reject: approval.decision skip, plan.cancelled rejected, sin fase build ni versión', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p4');
    expect((await decide(at, 'p4', callId, { decision: 'reject' })).status).toBe(200);
    const evs = await until('p4', has('plan.cancelled'));
    expect(evs.find((e) => e.type === 'approval.decision' && e.callId === callId)).toMatchObject({ decision: 'skip' });
    expect(find(evs, 'plan.cancelled')).toMatchObject({ callId, reason: 'rejected' });
    expect(callsFor('p4')).toHaveLength(1);
    expect(versions(evs)).toEqual([]);
  });

  // El feedback viaja dos veces: en plan.cancelled (la tarjeta lo muestra tras recargar, vía el fold) y como prompt del hijo,
  // que itera el plan sobre la misma sesión del CLI en vez de empezar uno de cero.
  test('reject con feedback: rejected con el texto y un mensaje hijo en plan que reanuda la sesión', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'rf1');
    await until('rf1', settled);
    const res = await decide(at, 'rf1', callId, { decision: 'reject', feedback: '  sin FAQ  ' });
    expect(res.status).toBe(200);
    const { ok, messageId } = (await res.json()) as { ok: boolean; messageId: string };
    expect(ok).toBe(true);
    expect(messageId).not.toBe('rf1');
    const evs = await until('rf1', has('plan.cancelled'));
    expect(evs.filter((e) => e.type === 'plan.cancelled')).toEqual([expect.objectContaining({ callId, reason: 'rejected', feedback: 'sin FAQ' })]);
    expect(evs.find((e) => e.type === 'approval.decision' && e.callId === callId)).not.toHaveProperty('reason');
    expect(foldMessage(evs).plan).toMatchObject({ status: 'rejected', feedback: 'sin FAQ' });
    await until(messageId, has('plan.ready'));
    const [child] = callsFor(messageId);
    expect(child?.resume).toBe('sess-rf1');
    expect(child?.plan).toEqual({ mode: 'plan' });
    expect(child?.prompt).toEndWith('sin FAQ');
    await until(messageId, settled);
  });

  // El plan ya se envió (plan.ready) pero el turno sigue vivo cuando la persona corta: keepStopped lo deja cancelado.
  test('cancel con el turno de plan aún vivo: el plan pendiente queda cancelled stopped', async () => {
    const hanging: Composer = async (req: Req) => {
      await fakeAgent(req, undefined as never);
      await new Promise<void>((r) => req.signal ? req.signal.addEventListener('abort', () => r(), { once: true }) : r());
      return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
    };
    const at = await boot({ compose: hanging });
    const callId = await startPlan(at, 'p11');
    expect((await send(at, '/runs/p11/cancel', {})).ok).toBe(true);
    const evs = await until('p11', has('plan.cancelled'));
    expect(find(evs, 'plan.cancelled')).toMatchObject({ callId, reason: 'stopped' });
    expect((await decide(at, 'p11', callId, { decision: 'approve' })).status).toBe(409);
  });

  // El apagado del transport no cancela el plan, pero la aprobación necesita la sesión del turno que cayó antes de keepPlan.
  describe('apagado con el plan ya enviado', () => {
    const hangAfterPlan = (session: boolean): Composer => async (req: Req) => {
      await fakeAgent(req, undefined as never);
      const dir = req.workspace?.dir as string;
      if (session) writeFileSync(join(dir, '.wt', 'agent-stream.ndjson'), `${JSON.stringify({ wt_at: Date.now(), type: 'system', subtype: 'init', session_id: 'sess-caida' })}\n`);
      await new Promise<void>((r) => req.signal ? req.signal.addEventListener('abort', () => r(), { once: true }) : r());
      return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: '' } } as unknown as PageModel;
    };
    const planOf = (id: string) => (JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, { plan?: { status: string; sessionId?: string } }>)[id]?.plan;

    test('con sesión recuperable el plan sigue pendiente y queda con ella para reanudar', async () => {
      const at = await boot({ compose: hangAfterPlan(true) });
      await startPlan(at, 'p12');
      await lastTransport.shutdown(2_000);
      await until('p12', has('settled'));
      expect(planOf('p12')).toMatchObject({ status: 'pending', sessionId: 'sess-caida' });
    }, 15_000);

    test('sin sesión recuperable el plan se cancela, porque aprobarlo daría 409 para siempre', async () => {
      const at = await boot({ compose: hangAfterPlan(false) });
      const callId = await startPlan(at, 'p13');
      await lastTransport.shutdown(2_000);
      const evs = await until('p13', has('plan.cancelled'));
      expect(find(evs, 'plan.cancelled')).toMatchObject({ callId, reason: 'stopped' });
      expect(planOf('p13')?.status).toBe('cancelled');
    }, 15_000);
  });

  test('cancel sobre un plan pendiente: plan.cancelled stopped y decidir después es 409', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p10');
    expect((await send(at, '/runs/p10/cancel', {})).ok).toBe(true);
    const evs = await until('p10', has('plan.cancelled'));
    expect(evs.find((e) => e.type === 'approval.decision' && e.callId === callId)).toMatchObject({ decision: 'skip', reason: 'stopped' });
    expect(find(evs, 'plan.cancelled')).toMatchObject({ callId, reason: 'stopped' });
    expect((await decide(at, 'p10', callId, { decision: 'approve' })).status).toBe(409);
    expect(callsFor('p10')).toHaveLength(1);
  });

  // El cliente que ya vio el message.end del turno de plan no sale mientras el plan espera: la decisión ajena le llega por el stream.
  test('con el plan pendiente el SSE sigue abierto tras el cierre del turno y recibe la cancelación por mensaje nuevo', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p14');
    await until('p14', settled);
    const stream = await fetch(`${at}/runs/p14/events`);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: PlanEvent[] = [];
    let buf = '';
    let posted = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() as string;
      for (const l of lines.filter(Boolean)) seen.push(JSON.parse(l) as PlanEvent);
      // Con todo el replay (hasta settled) ya leído, otra pestaña manda un mensaje que cancela el plan.
      if (!posted && seen.some((e) => e.type === 'settled')) { posted = true; expect((await post(at, { prompt: 'mejor reservas', messageId: 'p15', parentId: 'p14' })).ok).toBe(true); }
    }
    expect(posted).toBe(true);
    expect(seen.find((e) => e.type === 'plan.cancelled')).toMatchObject({ callId, reason: 'user-message' });
  }, 15_000);

  test('(d) mensaje nuevo con el plan pendiente: cancelled user-message y el nuevo corre en plan con resume', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p5');
    expect((await post(at, { prompt: 'mejor una de reservas', messageId: 'p6', parentId: 'p5' })).ok).toBe(true);
    const old = await until('p5', has('plan.cancelled'));
    expect(old.find((e) => e.type === 'approval.decision' && e.callId === callId)).toMatchObject({ decision: 'skip', reason: 'user-message' });
    expect(find(old, 'plan.cancelled')).toMatchObject({ callId, reason: 'user-message' });
    await until('p6', has('plan.ready'));
    const next = callsFor('p6')[0];
    expect(next?.plan).toEqual({ mode: 'plan' });
    expect(next?.resume).toBe('sess-p5');
    expect(versions(old)).toEqual([]);
    // Ya no espera: decidirla tarde es 409.
    expect((await decide(at, 'p5', callId, { decision: 'approve' })).status).toBe(409);
  });

  test('(e) permissionMode auto no autoaprueba el plan', async () => {
    const at = await boot();
    await startPlan(at, 'p7', { permissionMode: 'auto' });
    const evs = logOf('p7');
    expect(evs.some((e) => e.type === 'approval.decision')).toBe(false);
    expect(evs.some((e) => e.type === 'plan.resumed')).toBe(false);
    expect(callsFor('p7')).toHaveLength(1);
  });

  test('(f) reinicio con el plan pendiente: la decisión sigue funcionando', async () => {
    const first = await boot();
    const callId = await startPlan(first, 'p8');
    await until('p8', settled);
    const again = await boot();
    expect((await decide(again, 'p8', callId, { decision: 'approve' })).status).toBe(200);
    const evs = await until('p8', builtAfterResume);
    expect(versions(evs)).toHaveLength(1);
    expect(callsFor('p8').at(-1)?.resume).toBe('sess-p8');
  });

  test('(g) edit: el plan editado queda en disco con sus líneas usuario: y el build lo recibe como editado', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'p9');
    const edited = planFixture('plan-edited.md');
    expect((await decide(at, 'p9', callId, { decision: 'edit', plan: edited })).status).toBe(200);
    const evs = await until('p9', builtAfterResume);
    expect(evs.find((e) => e.type === 'approval.decision' && e.callId === callId)).toMatchObject({ decision: 'allow' });
    expect(find(evs, 'plan.resumed')).toMatchObject({ callId, edited: true });
    // preserve.pinned no existe en ninguna rama: hasta entonces se mide que las líneas fijadas lleguen al plan que lee
    // el build y que el build las reciba como plan editado.
    const onDisk = readFileSync(join(root, 'ws', 'p9', planPath('p9')), 'utf8');
    for (const line of pinnedLines(edited)) expect(onDisk).toContain(line);
    expect(callsFor('p9').at(-1)?.plan).toEqual({ mode: 'build', path: planPath('p9'), edited: true });
  });

  // Hallazgo #3 de Arq: keepPlan copia el commit del padre a la entrada del plan sin `asked`, y el picker filtraba solo por
  // asked: un plan sin aprobar salía como versión duplicada del padre.
  test('un plan pendiente, rechazado o cancelado no aparece en GET versions; el aprobado sí, con su propio commit', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'v1' });
    await until('v1', settled);
    const listed = async () => ((await (await fetch(`${at}/runs/v1/versions`)).json()) as { versions: { messageId: string; commit: string }[] }).versions;
    const pending = await startPlan(at, 'v2', { parentId: 'v1' });
    await until('v2', settled);
    expect((await listed()).map((v) => v.messageId)).toEqual(['v1']);
    await decide(at, 'v2', pending, { decision: 'reject' });
    await until('v2', has('plan.cancelled'));
    expect((await listed()).map((v) => v.messageId)).toEqual(['v1']);
    const ok = await startPlan(at, 'v3', { parentId: 'v1' });
    await decide(at, 'v3', ok, { decision: 'approve' });
    await until('v3', builtAfterResume);
    const after = await listed();
    expect(after.map((v) => v.messageId)).toEqual(['v1', 'v3']);
    expect(after[1]?.commit).not.toBe(after[0]?.commit);
  });

  const versionIds = async (at: string, id: string) => ((await (await fetch(`${at}/runs/${id}/versions`)).json()) as { versions: { messageId: string }[] }).versions.map((v) => v.messageId);

  // BUG 2 (QA de UI): el build reusa mensaje y log, y el message.end del tramo de plan no puede dar el mensaje por terminado.
  test('a mitad del build el hilo no está done, el replay da streaming y el SSE sigue abierto hasta el message.end del build', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'g0' });
    await until('g0', settled);
    buildMode = 'gated';
    const callId = await startPlan(at, 'g1', { parentId: 'g0' });
    await until('g1', settled);
    await decide(at, 'g1', callId, { decision: 'approve' });
    await until('g1', has('plan.resumed'));
    const thread = (await (await fetch(`${at}/chats/g0`)).json()) as { messages: { messageId: string; done: boolean }[] };
    expect(thread.messages.find((m) => m.messageId === 'g1')?.done).toBe(false);
    const replay = (await (await fetch(`${at}/runs/g1`)).json()) as { state: { status: string; outcome?: string; usage?: unknown; plan?: { status: string } } };
    expect(replay.state).toMatchObject({ status: 'streaming', plan: { status: 'approved' } });
    expect(replay.state.outcome).toBeUndefined();
    expect(replay.state.usage).toBeUndefined();
    // El SSE se lee desde 0: si el transport lo diera por terminado, cerraría tras el replay sin esperar el build.
    const stream = await fetch(`${at}/runs/g1/events`);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: PlanEvent[] = [];
    let buf = '';
    let opened = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() as string;
      for (const l of lines.filter(Boolean)) seen.push(JSON.parse(l) as PlanEvent);
      // Con el replay ya leído (llegó plan.resumed) se abre la compuerta: lo que falta del build solo llega si el stream sigue abierto.
      if (!opened && seen.some((e) => e.type === 'plan.resumed')) { opened = true; openGate(); }
    }
    const resumedAt = seen.findIndex((e) => e.type === 'plan.resumed');
    expect(seen.slice(resumedAt).some((e) => e.type === 'message.end')).toBe(true);
    expect(seen.at(-1)?.type).toBe('settled');
    const after = (await (await fetch(`${at}/chats/g0`)).json()) as { messages: { messageId: string; done: boolean }[] };
    expect(after.messages.find((m) => m.messageId === 'g1')?.done).toBe(true);
  });

  // Carrera de #557: settle() del turno de plan espera sus pasos tardíos; si la persona aprueba mientras espera, ese cierre viejo
  // no puede marcar el mensaje terminado ni emitir settled cuando el build ya corre.
  test('un cierre tardío del turno de plan no corta el SSE del build aprobado mientras esperaba', async () => {
    let releaseLate!: () => void;
    lateHold = new Promise<void>((r) => { releaseLate = r; });
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'r0' });
    await until('r0', settled);
    buildMode = 'gated';
    const callId = await startPlan(at, 'r1', { parentId: 'r0' });
    await until('r1', has('message.end'));
    expect(find(logOf('r1'), 'settled')).toBeUndefined();
    // El turno de plan puede tardar un tick en soltar el workspace tras su message.end.
    for (let i = 0; i < 200; i++) {
      if ((await decide(at, 'r1', callId, { decision: 'approve' })).ok) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await until('r1', has('plan.resumed'));
    releaseLate();
    const late = (lastTransport as unknown as { late: Map<string, unknown> }).late;
    for (let i = 0; i < 500 && late.has('r1'); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect(logOf('r1').some((e) => e.type === 'settled')).toBe(false);
    const stream = await fetch(`${at}/runs/r1/events`);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: PlanEvent[] = [];
    let buf = '';
    let opened = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() as string;
      for (const l of lines.filter(Boolean)) seen.push(JSON.parse(l) as PlanEvent);
      if (!opened && seen.some((e) => e.type === 'plan.resumed')) { opened = true; openGate(); }
    }
    const resumedAt = seen.findIndex((e) => e.type === 'plan.resumed');
    expect(seen.slice(resumedAt).some((e) => e.type === 'message.end')).toBe(true);
    expect(seen.filter((e) => e.type === 'settled')).toHaveLength(1);
    expect(seen.at(-1)?.type).toBe('settled');
  }, 15_000);

  // R2.3 en la fase build: un error sin escrituras del agente cierra sin versión, como en cualquier follow-up.
  test('un plan aprobado cuya fase build falla sin escribir no deja versión', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'w1' });
    await until('w1', settled);
    buildMode = 'fails';
    const callId = await startPlan(at, 'w2', { parentId: 'w1' });
    await decide(at, 'w2', callId, { decision: 'approve' });
    await until('w2', builtAfterResume);
    expect(await versionIds(at, 'w1')).toEqual(['w1']);
  });

  // Hueco de #3 (Arq): keepPlan deja commit = el del padre; si el proceso cae en la fase build antes del commit, recover
  // ve un commit y lo cerraba como versión completa.
  test('un plan aprobado que cae antes del commit de la fase build no es versión tras recover', async () => {
    const first = await boot();
    await post(first, { prompt: 'base', messageId: 'k1' });
    await until('k1', settled);
    buildMode = 'hangs';
    const callId = await startPlan(first, 'k2', { parentId: 'k1' });
    await decide(first, 'k2', callId, { decision: 'approve' });
    await until('k2', has('plan.resumed'));
    const again = await boot();
    await until('k2', (evs) => evs.filter((e) => e.type === 'settled').length >= 2);
    expect(await versionIds(again, 'k1')).toEqual(['k1']);
    const end = logOf('k2').filter((e) => e.type === 'message.end').at(-1) as { outcome?: string } | undefined;
    expect(end?.outcome).not.toBe('ok');
  });

  // QA en vivo de UI (BITACORA §5): B rechazado y C cancelado por mensaje nuevo salían como versiones con el commit del padre.
  test('B rechazado y C cancelado por mensaje nuevo no aparecen en GET versions', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'q1' });
    await until('q1', settled);
    const b = await startPlan(at, 'q2', { parentId: 'q1' });
    await decide(at, 'q2', b, { decision: 'reject' });
    await until('q2', has('plan.cancelled'));
    await startPlan(at, 'q3', { parentId: 'q1' });
    expect((await post(at, { prompt: 'mejor otra cosa', messageId: 'q4', parentId: 'q3' })).ok).toBe(true);
    await until('q3', has('plan.cancelled'));
    await until('q4', has('plan.ready'));
    expect(await versionIds(at, 'q1')).toEqual(['q1']);
  });

  // #570 tras un reinicio: el proceso nuevo marca el mensaje terminado al recuperar, pero el plan sigue pendiente y su SSE
  // no puede cerrar en el settled del plan. Si cerrara ahí, la cancelación que llega después nunca se leería.
  test('tras reiniciar con el plan pendiente, el SSE sigue abierto y recibe el rechazo', async () => {
    const first = await boot();
    const callId = await startPlan(first, 's1');
    await until('s1', settled);
    const again = await boot();
    const res = await fetch(`${again}/runs/s1/events?cursor=-1`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"type":"settled"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('"type":"settled"');
    expect((await decide(again, 's1', callId, { decision: 'reject' })).status).toBe(200);
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('"type":"plan.cancelled"');
  });

  test('el restore que sigue a un plan rechazado cuelga del padre real, no del plan', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'r1' });
    await until('r1', settled);
    await post(at, { prompt: 'cambio', messageId: 'r2', parentId: 'r1' });
    await until('r2', settled);
    const callId = await startPlan(at, 'r3', { parentId: 'r2' });
    await decide(at, 'r3', callId, { decision: 'reject' });
    await until('r3', has('plan.cancelled'));
    expect((await post(at, { restoreFrom: 'r1', messageId: 'r4' })).ok).toBe(true);
    await until('r4', settled);
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, { parentId?: string }>;
    expect(index.r4?.parentId).toBe('r2');
  });

  test('mode plan combinado con continue, variants, restoreFrom, elements o repair responde 400', async () => {
    const at = await boot();
    await post(at, { prompt: 'base', messageId: 'b1' });
    await until('b1', settled);
    const combos: Record<string, unknown>[] = [
      { parentId: 'b1', continue: true },
      { variants: { sourceId: 'b1', count: 2 } },
      { parentId: 'b1', restoreFrom: 'b1' },
      { parentId: 'b1', prompt: 'x', elements: [{ selector: 'h1' }] },
      { parentId: 'b1', repair: 'runtime' },
    ];
    for (const combo of combos) expect((await post(at, { mode: 'plan', ...combo })).status).toBe(400);
  });
});
