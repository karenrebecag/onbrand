// Decisión del plan (H6) por la ruta de aprobaciones: el builder manda el PRIMER messageId del hilo como :id, no el del
// plan (#1); la decisión se registra solo si la fase build arranca (#2); y GET del plan devuelve el texto vivo con `edited`
// si hubo un borrador (PUT). Sin LLM ni reloj: agente falso que escribe el plan y llama a exit_plan_mode por el MCP `wt`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';

const FIXTURES = join(import.meta.dir, 'fixtures', 'plan-mode');
const planFixture = (name: 'plan.md' | 'plan-edited.md') => readFileSync(join(FIXTURES, name), 'utf8');
const planPath = (messageId: string) => join('.wt', 'plans', `${messageId}.md`);
const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};

type Ev = EngineEvent & Record<string, unknown>;
let tmp: string;
let root: string;
let servers: Server[];
let seen: ComposeRequest[];
let noSession: Set<string>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plan-decide-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  seen = [];
  noSession = new Set();
});
afterEach(() => { for (const s of servers) s.close(); rmSync(tmp, { recursive: true, force: true }); });

const fakeAgent: Composer = async (req: ComposeRequest) => {
  seen.push(req);
  const dir = req.workspace?.dir as string;
  const sessionId = noSession.has(req.messageId) ? undefined : `sess-${req.messageId}`;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, planPath(req.messageId)), planFixture('plan.md'));
    const origin = new URL(req.approval?.url as string).origin;
    await fetch(`${origin}/mcp/${req.messageId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: planPath(req.messageId), summary: 'Landing de pagos en tres secciones' } } }),
    });
    return { sections: [], agent: { files: [], summary: '', missing: [], ...(sessionId ? { sessionId } : {}) } } as unknown as PageModel;
  }
  writeFileSync(join(dir, 'src', 'hero.tsx'), 'export {}\n');
  return { sections: [{ role: 'hero', children: [{ component: 'hero' }] }], agent: { files: ['src/hero.tsx'], summary: 'Listo', missing: [], ...(sessionId ? { sessionId } : {}) } } as unknown as PageModel;
};

async function boot(): Promise<string> {
  const t = new Runtime({ root, allow, agent: true, compose: fakeAgent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, method: string, path: string, body?: unknown) => fetch(`${at}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (at: string, body: unknown) => send(at, 'POST', '/runs', body);
const logOf = (id: string): Ev[] => readEvents(join(root, 'logs'), id).events as Ev[];
async function until(id: string, ok: (evs: Ev[]) => boolean, tries = 500): Promise<Ev[]> {
  for (let i = 0; i < tries; i++) { const evs = logOf(id); if (ok(evs)) return evs; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`${id} no llegó; eventos: ${logOf(id).map((e) => e.type).join(',')}`);
}
const has = (type: string) => (evs: Ev[]) => evs.some((e) => e.type === type);
const allows = (evs: Ev[]) => evs.filter((e) => e.type === 'approval.decision' && e.decision === 'allow');
const decide = (at: string, chat: string, callId: string, body: Record<string, unknown>) => send(at, 'POST', `/chats/${chat}/approvals/${callId}`, body);
const planOnDisk = (ws: string, id: string) => readFileSync(join(root, 'ws', ws, planPath(id)), 'utf8');
/** Un chat r1 con versión y un plan pendiente r2 colgando de él: el caso del builder (decide por el id raíz). */
async function followUpPlan(at: string, r1: string, r2: string): Promise<string> {
  expect((await post(at, { prompt: 'landing', messageId: r1 })).ok).toBe(true);
  await until(r1, has('message.end'));
  return startPlan(at, r2, { parentId: r1 });
}

async function startPlan(at: string, messageId: string, extra: Record<string, unknown> = {}): Promise<string> {
  expect((await post(at, { prompt: 'landing de pagos', messageId, mode: 'plan', ...extra })).ok).toBe(true);
  const callId = (await until(messageId, has('plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  expect(callId).toBeString();
  return callId;
}

describe('#1 la decisión entra por el primer messageId del hilo', () => {
  test('un plan en un follow-up se aprueba decidiendo contra el mensaje raíz del chat', async () => {
    const at = await boot();
    expect((await post(at, { prompt: 'landing', messageId: 'r1' })).ok).toBe(true);
    await until('r1', has('message.end'));
    const callId = await startPlan(at, 'r2', { parentId: 'r1' });
    // El builder manda chatId = r1 (primer mensaje), no r2 (donde vive el plan).
    expect((await send(at, 'POST', `/chats/r1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
    const evs = await until('r2', has('plan.resumed'));
    expect(evs.find((e) => e.type === 'plan.resumed')).toMatchObject({ callId, edited: false });
    expect(allows(evs)).toHaveLength(1);
  });

  test('reject por el id raíz cierra el plan del follow-up', async () => {
    const at = await boot();
    const callId = await followUpPlan(at, 'j1', 'j2');
    expect((await decide(at, 'j1', callId, { decision: 'reject' })).status).toBe(200);
    const evs = await until('j2', has('plan.cancelled'));
    expect(evs.find((e) => e.type === 'plan.cancelled')).toMatchObject({ callId, reason: 'rejected' });
    expect(evs.find((e) => e.type === 'approval.decision')).toMatchObject({ callId, decision: 'skip' });
  });

  test('edit por el id raíz escribe el plan del follow-up (no el del raíz) y reanuda editado', async () => {
    const at = await boot();
    const callId = await followUpPlan(at, 'e1', 'e2');
    expect((await decide(at, 'e1', callId, { decision: 'edit', plan: planFixture('plan-edited.md') })).status).toBe(200);
    const evs = await until('e2', has('plan.resumed'));
    expect(evs.find((e) => e.type === 'plan.resumed')).toMatchObject({ callId, edited: true });
    expect(planOnDisk('e1', 'e2')).toContain('usuario:');
  });

  test('un callId de otro chat no se decide desde este: error y nada en el log del plan', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'x1');
    expect((await post(at, { prompt: 'otra', messageId: 'y1' })).ok).toBe(true);
    await until('y1', has('message.end'));
    const before = logOf('x1').length;
    const planBefore = planOnDisk('x1', 'x1');
    // El plan de x1 no está en el ws de y1 y tampoco hay una tarjeta con ese callId en el chat de y1: 404 explícito para
    // cualquier decisión, en vez de un 400 "decision debe ser allow|always|skip" engañoso (item 4).
    const statuses = [];
    for (const decision of ['approve', 'reject', 'allow']) statuses.push((await decide(at, 'y1', callId, { decision })).status);
    expect(statuses).toEqual([404, 404, 404]);
    expect(logOf('x1')).toHaveLength(before);
    expect(planOnDisk('x1', 'x1')).toBe(planBefore);
    // El plan sigue pendiente en su chat.
    expect((await decide(at, 'x1', callId, { decision: 'approve' })).status).toBe(200);
  });
});

describe('#2 la decisión se registra solo si la fase build arranca', () => {
  test('approve con un plan sin sesión da 409 y no deja un allow en el log', async () => {
    const at = await boot();
    noSession.add('p1');
    const callId = await startPlan(at, 'p1');
    expect((await send(at, 'POST', `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(409);
    expect(allows(logOf('p1'))).toHaveLength(0);
    // El plan sigue pendiente: un segundo intento vuelve a dar 409 por la sesión, no 409 por "ya se approved".
    expect((await send(at, 'POST', `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(409);
    // Y se puede rechazar: el 409 no lo dejó en un estado sin salida.
    expect((await decide(at, 'p1', callId, { decision: 'reject' })).status).toBe(200);
    expect((await until('p1', has('plan.cancelled'))).find((e) => e.type === 'plan.cancelled')).toMatchObject({ reason: 'rejected' });
  });

  // ec mueve assertCanBuildPlan antes de writePlanEdit: un edit que no puede construir no toca el plan en disco.
  test('edit con un plan sin sesión da 409 y deja el .md intacto', async () => {
    const at = await boot();
    noSession.add('p2');
    const callId = await startPlan(at, 'p2');
    const before = planOnDisk('p2', 'p2');
    expect((await decide(at, 'p2', callId, { decision: 'edit', plan: planFixture('plan-edited.md') })).status).toBe(409);
    expect(planOnDisk('p2', 'p2')).toBe(before);
    expect(allows(logOf('p2'))).toHaveLength(0);
  });
});

describe('GET /chats/:chat/plans/:messageId', () => {
  test('devuelve el plan vivo; con un PUT de borrador marca edited', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'g1');
    const before = (await (await send(at, 'GET', `/chats/g1/plans/g1`)).json()) as { plan: string; edited?: boolean };
    expect(before.plan).toContain('#');
    expect(before.edited).toBeUndefined();
    expect((await send(at, 'PUT', `/chats/g1/plans/g1`, { plan: planFixture('plan-edited.md') })).status).toBe(200);
    const after = (await (await send(at, 'GET', `/chats/g1/plans/g1`)).json()) as { plan: string; edited?: boolean };
    expect(after.edited).toBe(true);
    // 404 para un mensaje sin plan.
    expect((await send(at, 'GET', `/chats/g1/plans/nope`)).status).toBe(404);
    // Decidido, el plan sigue legible (historial del turno): aprobado con el texto que se construyó.
    expect((await decide(at, 'g1', callId, { decision: 'approve' })).status).toBe(200);
    await until('g1', has('plan.resumed'));
    const approved = await send(at, 'GET', `/chats/g1/plans/g1`);
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { plan: string }).plan).toBe(planFixture('plan-edited.md'));
  });

  test('un plan rechazado sigue legible', async () => {
    const at = await boot();
    const callId = await startPlan(at, 'g2');
    await decide(at, 'g2', callId, { decision: 'reject' });
    await until('g2', has('plan.cancelled'));
    const res = await send(at, 'GET', `/chats/g2/plans/g2`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: string }).plan).toBe(planFixture('plan.md'));
  });

  // GET/PUT validan :chat (Secondary): un :chat de otro ws no ve el plan.
  test('GET con un :chat que no es el del plan da 404', async () => {
    const at = await boot();
    await startPlan(at, 'g3');
    expect((await post(at, { prompt: 'otra', messageId: 'h1' })).ok).toBe(true);
    await until('h1', has('message.end'));
    expect((await send(at, 'GET', `/chats/h1/plans/g3`)).status).toBe(404);
  });

  test('un segmento de ruta con % malformado da 400, no 500', async () => {
    const at = await boot();
    expect((await send(at, 'GET', `/chats/%ZZ/plans/g1`)).status).toBe(400);
  });

  // #596 dejó seg() solo en approvals y plans; el resto decodificaba suelto y daba 500 "URI error" (QA).
  test('toda ruta con un segmento % malformado da 400, no 500', async () => {
    const at = await boot();
    const routes: [string, string][] = [
      ['POST', '/variants/%ZZ/cancel'], ['DELETE', '/approvals/always/%ZZ'], ['GET', '/chats/%ZZ'],
      ['POST', '/runs/%ZZ/cancel'], ['POST', '/runs/%ZZ/publish'], ['POST', '/runs/x/sections/%ZZ/suggestions'],
      ['GET', '/runs/%ZZ'], ['GET', '/runs/%ZZ/files'], ['GET', '/runs/x/shots/%ZZ'],
    ];
    for (const [method, path] of routes) expect([method, path, (await send(at, method, path)).status]).toEqual([method, path, 400]);
  });
});
