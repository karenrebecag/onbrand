import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEventLog, type EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import { Runtime, type Composer, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import { agentCompose } from './helpers/agent-compose';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const PAGE: PageModel = { sections: [{ role: 'hero', children: [{ component: 'hero' }] }] };
const agentPage = (agent: Record<string, unknown>): PageModel => ({ ...PAGE, agent: { files: [], summary: '', missing: [], ...agent } } as unknown as PageModel);

let tmp: string;
let root: string;
let servers: Server[];
let compose: Composer;
let seen: ComposeRequest[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'transport-lifecycle-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  servers = [];
  seen = [];
  compose = agentCompose(PAGE);
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Un transport sobre el mismo root: el segundo hace de proceso reiniciado y corre recover en su constructor. */
async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = new Runtime({ root, allow, compose: (req, log) => { seen.push(req); return compose(req, log); }, agent: true, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), ...extra });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
const post = (at: string, body: unknown) => fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (at: string, id: string): Promise<EngineEvent[]> =>
  (await (await fetch(`${at}/runs/${id}/events?cursor=-1`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);
const endOf = (evs: EngineEvent[]) => evs.find((e) => e.type === 'message.end');
const hang = (): Promise<never> => new Promise(() => {});

describe('R2.3: desenlace explícito', () => {
  test('un result de error sin escrituras cierra failed, sin versión y sin pasar por pregunta', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'f1' });
    await events(at, 'f1');
    compose = async () => agentPage({ failed: true, summary: 'API Error: 529 overloaded' });
    await post(at, { prompt: 'b', messageId: 'f2', parentId: 'f1' });
    expect(endOf(await events(at, 'f2'))).toMatchObject({ finishReason: 'error', outcome: 'failed', continuable: false });
    const thread = (await (await fetch(`${at}/chats/f1`)).json()) as { messages: { messageId: string; commit: string | null; outcome?: string }[] };
    expect(thread.messages.find((m) => m.messageId === 'f2')).toMatchObject({ commit: null, outcome: 'failed' });
  });

  test('un result de error con escrituras queda como versión failed que se puede continuar con su sesión', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'g1' });
    await events(at, 'g1');
    compose = async () => {
      writeFileSync(join(root, 'ws', 'g1', 'src', 'nueva.tsx'), 'export {}\n');
      return agentPage({ failed: true, files: ['src/nueva.tsx'], sessionId: 'sess-g' });
    };
    await post(at, { prompt: 'b', messageId: 'g2', parentId: 'g1' });
    const evs = await events(at, 'g2');
    expect(endOf(evs)).toMatchObject({ outcome: 'failed', continuable: true });
    expect(evs.some((e) => e.type === 'snapshot' && e.commit)).toBe(true);
  });
});

describe('R2.2/R2.6: cierres de recover y continuar', () => {
  test('una corrida que cayó entre message.end y settled recibe settled al reiniciar', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 's1' });
    await events(at, 's1');
    // Otro mensaje con message.end y sin settled, como si el proceso hubiera muerto ahí.
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, 'index.json'), JSON.stringify({ ...index, s2: { ws: 's1', parentId: 's1', title: 'x', at: Date.now() } }));
    const log = openEventLog(join(root, 'logs'), 's2');
    log.emit({ type: 'message.start', parentId: 's1' });
    log.emit({ type: 'message.end', finishReason: 'stop' });
    const again = await boot();
    expect((await events(again, 's2')).map((e) => e.type)).toEqual(['message.start', 'message.end', 'settled']);
  });

  test('un follow-up vivo al caer queda como versión interrumpida; Continuar reanuda su sesión, una sola vez', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'k1' });
    await events(at, 'k1');
    const ws = join(root, 'ws', 'k1');
    compose = async () => {
      writeFileSync(join(ws, 'src', 'a-medias.tsx'), 'export {}\n');
      // El system.init del CLI de esta corrida, en el stream crudo de .wt.
      mkdirSync(join(ws, '.wt'), { recursive: true });
      writeFileSync(join(ws, '.wt', 'agent-stream.ndjson'), `${JSON.stringify({ wt_at: Date.now(), type: 'system', subtype: 'init', session_id: 'sess-k' })}\n`);
      return hang();
    };
    await post(at, { prompt: 'b', messageId: 'k2', parentId: 'k1' });
    while (!existsSync(join(ws, '.wt', 'agent-stream.ndjson'))) await new Promise((r) => setTimeout(r, 10));
    compose = agentCompose(PAGE);
    const again = await boot();
    const evs = await events(again, 'k2');
    expect(endOf(evs)).toMatchObject({ outcome: 'stopped', interrupted: true, continuable: true });
    expect(evs.at(-1)?.type).toBe('settled');
    expect(execFileSync('git', ['show', 'HEAD:src/a-medias.tsx'], { cwd: ws, encoding: 'utf8' })).toContain('export');
    // El sessionId no sale al builder; GET /chats dice que se puede continuar.
    const before = (await (await fetch(`${again}/chats/k1`)).json()) as { messages: Record<string, unknown>[] };
    expect(before.messages.find((m) => m.messageId === 'k2')).toMatchObject({ interrupted: true, continuable: true });
    expect(JSON.stringify(before)).not.toContain('sess-k');
    expect((await post(again, { parentId: 'k1', continue: true })).status).toBe(409);
    expect((await post(again, { parentId: 'k2', continue: true, messageId: 'k3' })).status).toBe(202);
    expect((await events(again, 'k3')).at(-1)?.type).toBe('settled');
    expect(seen.at(-1)).toMatchObject({ resume: 'sess-k', parentId: 'k2' });
    expect((await post(again, { parentId: 'k2', continue: true })).status).toBe(409);
    const after = (await (await fetch(`${again}/chats/k1`)).json()) as { messages: Record<string, unknown>[] };
    expect(after.messages.find((m) => m.messageId === 'k2')).toMatchObject({ continuable: false });
    expect(after.messages.find((m) => m.messageId === 'k3')).toMatchObject({ continueOf: 'k2' });
  });

  test('un SIGTERM al transport deja la corrida viva interrumpida y continuable, como el kill -9', async () => {
    const t = new Runtime({ root, allow, compose: (req, log) => { seen.push(req); return compose(req, log); }, agent: true, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    const s = t.listen(0);
    servers.push(s);
    await new Promise((r) => s.once('listening', r));
    const at = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    await post(at, { prompt: 'a', messageId: 'h1' });
    await events(at, 'h1');
    const ws = join(root, 'ws', 'h1');
    compose = async (req) => {
      writeFileSync(join(ws, 'src', 'a-medias.tsx'), 'export {}\n');
      mkdirSync(join(ws, '.wt'), { recursive: true });
      writeFileSync(join(ws, '.wt', 'agent-stream.ndjson'), `${JSON.stringify({ wt_at: Date.now(), type: 'system', subtype: 'init', session_id: 'sess-h' })}\n`);
      return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('abortado'))));
    };
    await post(at, { prompt: 'b', messageId: 'h2', parentId: 'h1' });
    while (!existsSync(join(ws, '.wt', 'agent-stream.ndjson'))) await new Promise((r) => setTimeout(r, 10));
    await t.shutdown(2_000);
    expect(endOf(await events(at, 'h2'))).toMatchObject({ outcome: 'stopped', interrupted: true, continuable: true });
  });

  test('un T1 que cae antes de page.json cierra sin versión y sin Continuar', async () => {
    const at = await boot();
    compose = async () => hang();
    await post(at, { prompt: 'a', messageId: 't1' });
    while (!seen.length) await new Promise((r) => setTimeout(r, 10));
    const again = await boot();
    const evs = await events(again, 't1');
    expect(endOf(evs)).toMatchObject({ outcome: 'stopped', interrupted: true, continuable: false });
    expect(evs.some((e) => e.type === 'snapshot')).toBe(false);
    expect(evs.at(-1)?.type).toBe('settled');
  });

  test('una edición directa o un restore a medio aplicar se descartan al reiniciar, failed y sin Continuar', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'e1' });
    await events(at, 'e1');
    const ws = join(root, 'ws', 'e1');
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, 'index.json'), JSON.stringify({ ...index, e2: { ws: 'e1', parentId: 'e1', title: 'Edited text', at: Date.now(), kind: 'direct-edit' } }));
    openEventLog(join(root, 'logs'), 'e2').emit({ type: 'message.start', parentId: 'e1' });
    // A medio aplicar: un archivo tocado y uno nuevo, sin commit.
    writeFileSync(join(ws, 'src', 'App.tsx'), '// a medias\n');
    writeFileSync(join(ws, 'src', 'suelto.tsx'), 'export {}\n');
    const again = await boot();
    const evs = await events(again, 'e2');
    expect(endOf(evs)).toMatchObject({ finishReason: 'error', outcome: 'failed', interrupted: true, continuable: false });
    expect(evs.at(-1)?.type).toBe('settled');
    expect(readFileSync(join(ws, 'src', 'App.tsx'), 'utf8')).not.toBe('// a medias\n');
    expect(existsSync(join(ws, 'src', 'suelto.tsx'))).toBe(false);
  });
});

describe('R3: estado de corrida durable', () => {
  const writePage = (req: ComposeRequest): PageModel => {
    const dir = req.workspace?.dir as string;
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), `export default function Hero() { return <section>${req.prompt}</section>; }\n`);
    return agentPage({ files: ['src/sections/01-hero.tsx'], summary: 'ok' });
  };
  const plan = async () => ({ variants: [{ title: 'A', prompt: 'PA' }, { title: 'B', prompt: 'PB' }, { title: 'C', prompt: 'PC' }] });
  const variantOpts = { agent: true, imageModels: [], variantsPlan: plan, maxRunning: 1 } as Partial<RuntimeOptions>;
  // GET /runs/:id y no el stream: el stream de una corrida viva no termina.
  const has = async (at: string, id: string, type: string) => {
    const r = await fetch(`${at}/runs/${id}`);
    return r.ok && ((await r.json()) as { events: EngineEvent[] }).events.some((e) => e.type === type);
  };
  const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 300 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10)); };
  /** Fuente m1 y un grupo de 3 variantes con maxRunning 1: la primera queda colgada y las otras dos en cola, y cae el proceso. */
  async function crashWithQueue(): Promise<{ groupId: string; ids: string[] }> {
    compose = async (req) => (req.parentId ? hang() : writePage(req));
    const at = await boot(variantOpts);
    await post(at, { prompt: 'landing', messageId: 'm1' });
    await events(at, 'm1');
    const body = (await (await post(at, { variants: { sourceId: 'm1', count: 3 } })).json()) as { groupId: string; variants: { messageId: string }[] };
    const ids = body.variants.map((v) => v.messageId);
    await until(async () => (await has(at, ids[0], 'variant')) && (await has(at, ids[2], 'run.queued')));
    return { groupId: body.groupId, ids };
  }

  test('al reiniciar, la variante que corría cierra interrumpida y la cola se reanuda bajo maxRunning; GET /chats las lista', async () => {
    const { ids } = await crashWithQueue();
    const again = await boot(variantOpts);
    expect(endOf(await events(again, ids[0]))).toMatchObject({ outcome: 'stopped', interrupted: true });
    await until(() => has(again, ids[1], 'run.started'));
    expect(await has(again, ids[1], 'variant')).toBe(true);
    // maxRunning 1: la tercera sigue esperando.
    expect(await has(again, ids[2], 'run.started')).toBe(false);
    const thread = (await (await fetch(`${again}/chats/m1`)).json()) as { variants: { messageId: string; index: number; queued: boolean; done: boolean }[] };
    expect(thread.variants.map((v) => [v.index, v.done, v.queued])).toEqual([[0, true, false], [1, false, false], [2, false, true]]);
  });

  test('la variante reanudada tras reiniciar lleva su ruta de aprobación, como la que arrancó antes de caer', async () => {
    const { ids } = await crashWithQueue();
    const again = await boot(variantOpts);
    await until(() => has(again, ids[1], 'variant'));
    await until(async () => seen.some((r) => r.prompt === 'PB'));
    expect(seen.find((r) => r.prompt === 'PB')?.approval).toBeDefined();
  });

  test('el cancel por grupo sigue andando después de reiniciar', async () => {
    const { groupId, ids } = await crashWithQueue();
    const again = await boot(variantOpts);
    await until(() => has(again, ids[1], 'run.started'));
    const c = await fetch(`${again}/variants/${groupId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(c.status).toBe(202);
    expect(((await c.json()) as { cancelled: string[] }).cancelled.sort()).toEqual([ids[1], ids[2]].sort());
    const third = await events(again, ids[2]);
    expect(endOf(third)).toMatchObject({ finishReason: 'stopped' });
    expect(third.some((e) => e.type === 'variant')).toBe(false);
  });

  test('una variante que cayó antes de entrar a la cola cierra failed al reiniciar', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'p1' });
    await events(at, 'p1');
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, 'index.json'), JSON.stringify({ ...index, v9: { ws: 'v9', parentId: 'p1', title: 'Variante 1', at: Date.now(), variantOf: { groupId: 'g9', index: 0, count: 1 } } }));
    const again = await boot();
    const evs = await events(again, 'v9');
    expect(endOf(evs)).toMatchObject({ finishReason: 'error', outcome: 'failed' });
    expect(evs.at(-1)?.type).toBe('settled');
  });

  test('una corrida que cayó entre el commit y message.end cierra ok e interrumpida: la versión está completa', async () => {
    const at = await boot();
    await post(at, { prompt: 'a', messageId: 'c1' });
    await events(at, 'c1');
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')) as Record<string, { commit?: string }>;
    writeFileSync(join(root, 'index.json'), JSON.stringify({ ...index, c2: { ws: 'c1', parentId: 'c1', title: 'x', at: Date.now(), commit: index.c1.commit } }));
    openEventLog(join(root, 'logs'), 'c2').emit({ type: 'message.start', parentId: 'c1' });
    const again = await boot();
    expect(endOf(await events(again, 'c2'))).toMatchObject({ finishReason: 'stop', outcome: 'ok', interrupted: true, continuable: false });
  });
});
