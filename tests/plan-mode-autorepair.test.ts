// Plan mode (plan-mode.md, "Sin auto-repair después de la fase build"): la persona aprobó un plan concreto; un arreglo
// automático sería otro cambio y otro gasto que no aprobó. Si la fase build deja defectos del preview, no nace un hijo
// autoRepair y el arreglo manual sigue disponible. Sin LLM ni reloj: agente falso y esperas por reintentos sobre el log.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killChildren, liveChildren } from '../src/runtime/children';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import { INSTALLED_MARK } from '../src/runtime/preview-dist';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest } from '../src/runtime/server';

const PLAN = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');
const planPath = (id: string) => join('.wt', 'plans', `${id}.md`);
const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};

type Ev = EngineEvent & Record<string, unknown>;
let tmp: string;
let root: string;
let server: Server | undefined;
let seen: ComposeRequest[];
// Corridas que el agente falso deja abiertas hasta que el test las suelte: ocupan el cupo de maxRunning.
let held: Map<string, () => void>;
// Fases build que esperan un mensaje de la persona por el steer del turno vivo antes de escribir.
let steerGate: Set<string>;
let steered: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plan-autorepair-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  seen = [];
  held = new Map();
  steerGate = new Set();
  steered = [];
});
// El PATH de antes de prepender el bun falso: un test que vence su timeout abandona su función y su finally no corre;
// afterEach sí, y sin esto el resto de la suite lanzaba el bun falso.
const ORIGINAL_PATH = process.env.PATH;
afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  server?.close();
  await killChildren(0);
  rmSync(tmp, { recursive: true, force: true });
});

const fakeAgent: Composer = async (req) => {
  seen.push(req);
  if (req.messageId.startsWith('hold')) await new Promise<void>((r) => held.set(req.messageId, r));
  const dir = req.workspace?.dir as string;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, planPath(req.messageId)), PLAN);
    await fetch(`${new URL(req.approval?.url as string).origin}/mcp/${req.messageId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: planPath(req.messageId), summary: 'Landing en una sección' } } }),
    });
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
  }
  if (req.plan?.mode === 'build' && steerGate.has(req.messageId)) {
    await new Promise<void>((r) => req.steer?.bind((text) => { steered.push(text); r(); return true; }));
  }
  // Una versión cuyo árbol trae otro lockfile (lo que deja una subida de deps del scaffold).
  // El agente sube una dependencia: package.json cambia y el lockfile ya no es consistente.
  if (req.prompt.includes('[pkg]')) writeFileSync(join(dir, 'package.json'), '{"name":"ws","private":true,"dependencies":{"zod":"^3"}}\n');
  if (req.prompt.includes('[lock]')) writeFileSync(join(dir, 'bun.lock'), '{"lockfileVersion":1,"packages":{"zod":[]}}\n');
  mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
  writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), `export default function Hero() { return <h1>Hola ${seen.length}</h1>; }\n`);
  writeFileSync(join(dir, 'src', 'App.tsx'), "import Hero from './sections/01-hero';\nexport default function App() { return <Hero />; }\n");
  return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx', 'src/sections/01-hero.tsx'], summary: 'ok', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
};

async function boot(extra: { maxRunning?: number; autoRepair?: boolean } = {}): Promise<string> {
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  // El preview sigue roto después del build: sin la regla, el server lanzaría el arreglo solo.
  const t = new Runtime({ root, allow, compose: fakeAgent, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), previews,
    previewCheck: async () => [{ field: 'preview.runtime', owner: 'L6', kind: 'pageerror', slug: '01-hero', viewport: 1440, message: 'x.map is not a function' }], ...extra });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const send = (at: string, method: string, path: string, body?: unknown) => fetch(`${at}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const logOf = (id: string): Ev[] => readEvents(join(root, 'logs'), id).events as Ev[];
async function until(id: string, ok: (evs: Ev[]) => boolean, tries = 500): Promise<Ev[]> {
  for (let i = 0; i < tries; i++) { const evs = logOf(id); if (ok(evs)) return evs; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`${id} no llegó; eventos: ${logOf(id).map((e) => e.type).join(',')}`);
}

test('un plan aprobado cuyo build deja errores del preview no lanza auto-repair; el arreglo manual sigue', async () => {
  const at = await boot();
  expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'p1', mode: 'plan' })).ok).toBe(true);
  const callId = (await until('p1', (evs) => evs.some((e) => e.type === 'plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  // El turno de plan tiene que haber cerrado para que la fase build pueda tomar el workspace.
  await until('p1', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  // El build cierra y su revisión tardía del preview encuentra el error: es el punto donde nacería el hijo.
  const evs = await until('p1', (e) => e.filter((x) => x.type === 'settled').length >= 2);
  expect(evs.some((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check' && e.status === 'error')).toBe(true);
  expect(evs.some((e) => e.type === 'step.end' && e.stepId === 'transport:autofix')).toBe(false);
  expect(seen).toHaveLength(2);
  // El puente en vivo del builder (auto:true) cae en la misma regla; el manual de abajo sigue.
  const live = await send(at, 'POST', '/runs', { repair: 'runtime', parentId: 'p1', messageId: 'a1', auto: true });
  expect(live.status).toBe(409);
  expect(((await live.json()) as { code?: string }).code).toBe('auto-repair-plan');
  expect((await send(at, 'POST', '/runs', { repair: 'runtime', parentId: 'p1', messageId: 'f1' })).status).toBe(202);
});

// plan-mode.md §3: la decisión no tiene efectos si la fase build no puede arrancar. Editar con el cupo lleno no deja el
// texto editado escrito: el plan sigue pending con el texto que la persona vio.
test('editar un plan con el cupo de corridas lleno da 429 y deja el plan intacto', async () => {
  const at = await boot({ maxRunning: 1 });
  expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'p2', mode: 'plan' })).ok).toBe(true);
  const callId = (await until('p2', (evs) => evs.some((e) => e.type === 'plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  await until('p2', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', '/runs', { prompt: 'otro chat', messageId: 'hold1' })).ok).toBe(true);
  await until('hold1', () => held.has('hold1'));
  const res = await send(at, 'POST', `/chats/p2/approvals/${callId}`, { decision: 'edit', plan: PLAN.replace('# ', '# Editado: ') });
  expect(res.status).toBe(429);
  const dir = join(root, 'ws', 'p2');
  expect(readFileSync(join(dir, planPath('p2')), 'utf8')).toBe(PLAN);
  expect(logOf('p2').some((e) => e.type === 'approval.decision')).toBe(false);
  held.get('hold1')?.();
});

// La regla es de la fase build del plan, no del hilo: un follow-up normal después del plan sigue con su arreglo automático.
test('un follow-up normal después de un plan aprobado sí lanza auto-repair', async () => {
  const at = await boot();
  expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'p3', mode: 'plan' })).ok).toBe(true);
  const callId = (await until('p3', (evs) => evs.some((e) => e.type === 'plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  await until('p3', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', `/chats/p3/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  await until('p3', (e) => e.filter((x) => x.type === 'settled').length >= 2);
  expect((await send(at, 'POST', '/runs', { prompt: 'cambia el titular', messageId: 'n3', parentId: 'p3' })).ok).toBe(true);
  const evs = await until('n3', (e) => e.some((x) => x.type === 'step.end' && x.stepId === 'transport:autofix'));
  expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:autofix')).toMatchObject({ status: 'ok' });
});

// El 409 que se resuelve esperando trae su code; uno que no cambia al reintentar (plan ya decidido) trae el suyo. Así el builder
// no pide "aprueba de nuevo" sobre un plan que otra pestaña ya cerró.
test('aprobar con el workspace ocupado da 409 workspace-busy; sobre un plan ya decidido, 409 plan-decided', async () => {
  const at = await boot({ autoRepair: false });
  expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'r1' })).ok).toBe(true);
  await until('r1', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', '/runs', { prompt: 'cambia el hero', messageId: 'r2', parentId: 'r1', mode: 'plan' })).ok).toBe(true);
  const callId = (await until('r2', (evs) => evs.some((e) => e.type === 'plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  await until('r2', (evs) => evs.some((e) => e.type === 'settled'));
  // Otro mensaje sobre la versión r1 (otra pestaña): ocupa el workspace sin cancelar el plan de r2, que no es su padre.
  expect((await send(at, 'POST', '/runs', { prompt: 'otro cambio', messageId: 'hold2', parentId: 'r1' })).ok).toBe(true);
  await until('hold2', () => held.has('hold2'));
  const busy = await send(at, 'POST', `/chats/r1/approvals/${callId}`, { decision: 'approve' });
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { code?: string }).code).toBe('workspace-busy');
  // HACK provisional (regla §3 pendiente): el reject con feedback que no puede abrir su hijo responde como approve y el
  // plan sigue pendiente, sin feedback registrado.
  const busyReject = await send(at, 'POST', `/chats/r1/approvals/${callId}`, { decision: 'reject', feedback: 'sin FAQ' });
  expect(busyReject.status).toBe(409);
  expect(((await busyReject.json()) as { code?: string }).code).toBe('workspace-busy');
  expect(logOf('r2').some((e) => e.type === 'plan.cancelled')).toBe(false);
  held.get('hold2')?.();
  await until('hold2', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', `/chats/r1/approvals/${callId}`, { decision: 'reject' })).status).toBe(200);
  const decided = await send(at, 'POST', `/chats/r1/approvals/${callId}`, { decision: 'approve' });
  expect(decided.status).toBe(409);
  expect(((await decided.json()) as { code?: string }).code).toBe('plan-decided');
});

// Un mensaje durante la fase build de un plan aprobado entra al turno vivo (steer), como cualquier turno en curso: no abre
// otra corrida ni cancela el plan, que ya no está pendiente.
test('un mensaje durante la fase build entra por steer al turno vivo y no abre corrida nueva', async () => {
  const at = await boot({ autoRepair: false });
  steerGate.add('sb1');
  expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'sb1', mode: 'plan' })).ok).toBe(true);
  const callId = (await until('sb1', (evs) => evs.some((e) => e.type === 'plan.ready'))).find((e) => e.type === 'plan.ready')?.callId as string;
  await until('sb1', (evs) => evs.some((e) => e.type === 'settled'));
  expect((await send(at, 'POST', `/chats/sb1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  await until('sb1', (evs) => evs.some((e) => e.type === 'plan.resumed'));
  for (let i = 0; i < 500 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  const res = await send(at, 'POST', '/runs', { prompt: 'añade una FAQ', messageId: 'sb2', parentId: 'sb1' });
  expect(res.ok).toBe(true);
  expect(await res.json()).toMatchObject({ messageId: 'sb1', queued: true });
  const evs = await until('sb1', (e) => e.filter((x) => x.type === 'settled').length >= 2);
  expect(steered).toEqual(['añade una FAQ']);
  expect(evs.some((e) => e.type === 'steer' && e.text === 'añade una FAQ')).toBe(true);
  expect(evs.some((e) => e.type === 'plan.cancelled')).toBe(false);
  expect(seen.map((r) => r.messageId)).toEqual(['sb1', 'sb1']);
  expect((await send(at, 'GET', '/runs/sb2')).status).toBe(404);
});

// installDeps (transport.ts, R1.3): Stop a mitad del install corta el proceso y no deja la marca de instalado; el siguiente
// turno del workspace reinstala, y el de después, sin cambios, ya no.
// En Linux quedaba 1 hijo vivo: un spawn con EBADF de bun en otro archivo (child-run) que nadie mataba (children.ts reap).
test('un Stop a mitad del install no deja la marca; el siguiente turno reinstala y el tercero lo salta', async () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const runs = join(tmp, 'installs');
  const started = join(tmp, 'install-started');
  // El segundo install se cuelga hasta que lo maten; los demás terminan. Con tope (~30 s): si el test cae antes del cancel,
  // el proceso (detached) no queda vivo para siempre.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho x >> "${runs}"\nmkdir -p node_modules\nif [ "$(wc -l < "${runs}" | tr -d ' ')" = 2 ]; then touch "${started}"; i=0; while [ $i -lt 1500 ]; do sleep 0.02; i=$((i+1)); done; exit 1; fi\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const install = (id: string) => logOf(id).find((e) => e.type === 'step.end' && e.stepId === 'transport:install');
  const settled = (id: string) => until(id, (evs) => evs.some((e) => e.type === 'settled'));
  const modules = join(root, 'ws', 'i0', 'node_modules');
  try {
    const at = await boot({ autoRepair: false });
    expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'i0' })).ok).toBe(true);
    await settled('i0');
    expect(install('i0')).toMatchObject({ status: 'ok' });
    // Se pierden las dependencias; el install del turno siguiente se corta con Stop.
    rmSync(modules, { recursive: true, force: true });
    expect((await send(at, 'POST', '/runs', { prompt: 'cambia algo', messageId: 'i1', parentId: 'i0' })).ok).toBe(true);
    for (let i = 0; !existsSync(started); i++) {
      if (i >= 500) throw new Error('el install de i1 no arrancó');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await send(at, 'POST', '/runs/i1/cancel')).status).toBe(202);
    await settled('i1');
    expect(install('i1')).toMatchObject({ status: 'error' });
    expect(existsSync(modules)).toBe(true);
    expect(existsSync(join(modules, INSTALLED_MARK))).toBe(false);
    expect(seen.map((r) => r.messageId)).toEqual(['i0']);
    expect((await send(at, 'POST', '/runs', { prompt: 'otra vez', messageId: 'i2', parentId: 'i0' })).ok).toBe(true);
    await settled('i2');
    expect(install('i2')).toMatchObject({ status: 'ok' });
    expect(existsSync(join(modules, INSTALLED_MARK))).toBe(true);
    expect((await send(at, 'POST', '/runs', { prompt: 'y otra', messageId: 'i3', parentId: 'i2' })).ok).toBe(true);
    await settled('i3');
    expect(install('i3')).toBeUndefined();
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(3);
    // El cancel mató al bun colgado: no queda ningún hijo vivo.
    expect(liveChildren()).toBe(0);
  } finally {
    process.env.PATH = path;
    await killChildren(0);
  }
});

// La marca guarda el hash de package.json + lockfile: una versión con otro lockfile reinstala una vez al volver a correr
// sobre ella; sin cambio, no. Antes la marca era un archivo vacío y el workspace se quedaba con el node_modules viejo.
test('cambiar el lockfile entre turnos fuerza la reinstalación; sin cambio no', async () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const runs = join(tmp, 'installs');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho x >> "${runs}"\nmkdir -p node_modules\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
  writeFileSync(join(tmp, 'scaffold', 'bun.lock'), '{"lockfileVersion":1}\n');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const installs = () => readFileSync(runs, 'utf8').trim().split('\n').length;
  const turn = async (at: string, messageId: string, prompt: string, parentId?: string) => {
    expect((await send(at, 'POST', '/runs', { prompt, messageId, ...(parentId ? { parentId } : {}) })).ok).toBe(true);
    await until(messageId, (evs) => evs.some((e) => e.type === 'settled'));
    return installs();
  };
  try {
    const at = await boot({ autoRepair: false });
    expect(await turn(at, 'k1', 'landing')).toBe(1);
    expect(await turn(at, 'k2', 'sin cambio', 'k1')).toBe(1);
    // k3 escribe otro bun.lock durante el turno: el install de su arranque lo salta (lockfile igual) y el del cierre, antes
    // del commit, ya ve el nuevo y reinstala.
    expect(await turn(at, 'k3', 'sube deps [lock]', 'k2')).toBe(2);
    expect(readFileSync(join(root, 'ws', 'k1', 'bun.lock'), 'utf8')).toContain('zod');
    // Sobre esa versión la marca ya coincide: no más installs.
    expect(await turn(at, 'k4', 'otro', 'k3')).toBe(2);
    expect(await turn(at, 'k5', 'otro más', 'k4')).toBe(2);
  } finally {
    process.env.PATH = path;
  }
});

// La marca vieja se borra ANTES de reinstalar: preview-dist.installed() (marca presente) tiene que dar false mientras el
// install corre, o vite arranca sobre un node_modules a medias.
// En Linux quedaba 1 hijo vivo: un spawn con EBADF de bun en otro archivo (child-run) que nadie mataba (children.ts reap).
test('con la marca de otro hash, durante el reinstall no hay marca (installed() false)', async () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const runs = join(tmp, 'installs');
  const started = join(tmp, 'install-started');
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho x >> "${runs}"\nmkdir -p node_modules\nif [ "$(wc -l < "${runs}" | tr -d ' ')" = 2 ]; then touch "${started}"; i=0; while [ $i -lt 1500 ]; do sleep 0.02; i=$((i+1)); done; exit 1; fi\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const mark = join(root, 'ws', 'v0', 'node_modules', INSTALLED_MARK);
  try {
    const at = await boot({ autoRepair: false });
    expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'v0' })).ok).toBe(true);
    await until('v0', (evs) => evs.some((e) => e.type === 'settled'));
    writeFileSync(mark, 'hash-viejo');
    expect((await send(at, 'POST', '/runs', { prompt: 'otra', messageId: 'v1', parentId: 'v0' })).ok).toBe(true);
    for (let i = 0; !existsSync(started); i++) {
      if (i >= 500) throw new Error('el install de v1 no arrancó');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(mark)).toBe(false);
    expect((await send(at, 'POST', '/runs/v1/cancel')).status).toBe(202);
    await until('v1', (evs) => evs.some((e) => e.type === 'settled'));
    // Cortado: sigue sin marca, el próximo turno reinstala.
    expect(existsSync(mark)).toBe(false);
    expect(liveChildren()).toBe(0);
  } finally {
    process.env.PATH = path;
    await killChildren(0);
  }
});

// Si el agente mueve deps, el install de cierre va sin --frozen-lockfile (frozen fallaría y cada follow-up caería en install
// para siempre) y la marca queda con el hash posterior: el follow-up no reinstala.
test('el agente cambia package.json: el turno cierra ok, la marca toma el hash nuevo y el follow-up no reinstala', async () => {
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  const runs = join(tmp, 'installs');
  // Como bun real: con --frozen-lockfile y un package.json que el lockfile no fija, falla.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$*" >> "${runs}"\nmkdir -p node_modules\nif [ "$2" = "--frozen-lockfile" ] && grep -q zod package.json; then exit 1; fi\n`);
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(tmp, 'scaffold', 'package.json'), '{"name":"ws","private":true}\n');
  writeFileSync(join(tmp, 'scaffold', 'bun.lock'), '{"lockfileVersion":1}\n');
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const lines = () => readFileSync(runs, 'utf8').trim().split('\n');
  const mark = join(root, 'ws', 'q1', 'node_modules', INSTALLED_MARK);
  try {
    const at = await boot({ autoRepair: false });
    expect((await send(at, 'POST', '/runs', { prompt: 'landing', messageId: 'q1' })).ok).toBe(true);
    await until('q1', (evs) => evs.some((e) => e.type === 'settled'));
    const before = readFileSync(mark, 'utf8');
    expect((await send(at, 'POST', '/runs', { prompt: 'añade zod [pkg]', messageId: 'q2', parentId: 'q1' })).ok).toBe(true);
    const evs = await until('q2', (e) => e.some((x) => x.type === 'settled'));
    expect(evs.filter((e) => e.type === 'step.end' && e.stepId === 'transport:install').map((e) => e.status)).toEqual(['ok']);
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stop' });
    expect(lines()).toEqual(['install --frozen-lockfile', 'install']);
    expect(readFileSync(mark, 'utf8')).not.toBe(before);
    expect((await send(at, 'POST', '/runs', { prompt: 'otro cambio', messageId: 'q3', parentId: 'q2' })).ok).toBe(true);
    await until('q3', (e) => e.some((x) => x.type === 'settled'));
    expect(lines()).toHaveLength(2);
  } finally {
    process.env.PATH = path;
  }
});
