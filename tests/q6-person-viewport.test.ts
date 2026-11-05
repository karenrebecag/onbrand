// Q6: el viewport de la persona es viewport de verificación (v0 previewViewport por mensaje, RI/v0.md:166-172; Lovable
// current_viewport, lovable.md §1). El camino directo ya lo cumple (agent-context.test.ts: POST /runs con viewport llega al
// preview-check). El hueco es el plan: el viewport viaja en el turno de plan, que no escribe, y la fase build, que sí crea la
// versión, se lanza desde la aprobación con un RunInput sin viewport (transport.ts:889, resumePlanBuild). Sin LLM ni reloj.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PreviewChecker } from '../src/runtime/preview-check';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest } from '../src/runtime/server';

const PLAN_MD = readFileSync(join(import.meta.dir, 'fixtures', 'plan-mode', 'plan.md'), 'utf8');
const PERSON = { width: 1280, height: 800 };

let tmp: string;
let root: string;
let server: Server | undefined;
let checked: unknown[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'q6-viewport-'));
  root = join(tmp, 'state');
  mkdirSync(join(tmp, 'scaffold', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'scaffold', '.gitignore'), 'node_modules\n');
  writeFileSync(join(tmp, 'scaffold', 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  checked = [];
});
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

async function agent(req: ComposeRequest): Promise<PageModel> {
  const dir = req.workspace?.dir as string;
  if (req.plan?.mode === 'plan') {
    mkdirSync(join(dir, '.wt', 'plans'), { recursive: true });
    writeFileSync(join(dir, '.wt', 'plans', `${req.messageId}.md`), PLAN_MD);
    await fetch(`${new URL(req.approval?.url as string).origin}/mcp/${req.messageId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exit_plan_mode', arguments: { planPath: `.wt/plans/${req.messageId}.md`, summary: 'Plan' } } }),
    });
    return { sections: [], agent: { files: [], summary: '', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
  }
  writeFileSync(join(dir, 'src', `${req.messageId}.tsx`), 'export {}\n');
  return { sections: [], agent: { files: [`src/${req.messageId}.tsx`], summary: 'Listo', missing: [], sessionId: `sess-${req.messageId}` } } as unknown as PageModel;
}

async function boot(): Promise<string> {
  const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
  const previewCheck: PreviewChecker = async (_url, _dir, opts) => { checked.push(opts?.viewport); return []; };
  const t = new Runtime({ root, allow: {}, agent: true, compose: agent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), previews, previewCheck, autoRepair: false });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const send = (at: string, path: string, body: unknown) => fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const logOf = (id: string): (EngineEvent & { callId?: string; stepId?: string })[] => readEvents(join(root, 'logs'), id).events as (EngineEvent & { callId?: string; stepId?: string })[];
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`q6: ${what} no llegó`);
}
const checkDone = (id: string) => logOf(id).some((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check');

test('sin plan, el viewport del mensaje llega al preview-check (camino directo, ya en verde)', async () => {
  const at = await boot();
  expect((await send(at, '/runs', { prompt: 'landing', messageId: 'd1', viewport: PERSON })).status).toBe(202);
  await until('preview-check de d1', () => checkDone('d1'));
  expect(checked).toEqual([PERSON]);
});

// El viewport del turno de plan se guarda en el índice y resumePlanBuild lo pone en el RunInput del build.
test('el build de un plan aprobado verifica también al ancho que la persona miraba al pedir el plan', async () => {
  const at = await boot();
  expect((await send(at, '/runs', { prompt: 'plan', messageId: 'p1', mode: 'plan', viewport: PERSON })).status).toBe(202);
  await until('plan.ready de p1', () => logOf('p1').some((e) => e.type === 'plan.ready'));
  await until('cierre del turno de plan', () => logOf('p1').some((e) => e.type === 'settled'));
  const callId = logOf('p1').find((e) => e.type === 'plan.ready')?.callId as string;
  expect((await send(at, `/chats/p1/approvals/${callId}`, { decision: 'approve' })).status).toBe(200);
  await until('preview-check del build', () => checkDone('p1'));
  // El turno de plan no crea versión ni corre preview-check: el único check es el del build.
  expect(checked).toEqual([PERSON]);
});

// La persona puede cambiar de ancho mientras lee el plan: el viewport que trae la aprobación gana al guardado.
test('el viewport de la aprobación gana al del turno de plan', async () => {
  const at = await boot();
  const MOBILE = { width: 390, height: 844 };
  expect((await send(at, '/runs', { prompt: 'plan', messageId: 'p2', mode: 'plan', viewport: PERSON })).status).toBe(202);
  await until('plan.ready de p2', () => logOf('p2').some((e) => e.type === 'plan.ready'));
  await until('cierre del turno de plan', () => logOf('p2').some((e) => e.type === 'settled'));
  const callId = logOf('p2').find((e) => e.type === 'plan.ready')?.callId as string;
  expect((await send(at, `/chats/p2/approvals/${callId}`, { decision: 'approve', viewport: { width: 0, height: 1 } })).status).toBe(400);
  expect((await send(at, `/chats/p2/approvals/${callId}`, { decision: 'approve', viewport: MOBILE })).status).toBe(200);
  await until('preview-check del build', () => checkDone('p2'));
  expect(checked).toEqual([MOBILE]);
});
