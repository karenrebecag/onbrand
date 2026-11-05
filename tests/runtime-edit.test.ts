import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '../src/runtime/events';
import type { Allowlist, PageModel } from '../src/runtime/runner';
import type { PreviewPool } from '../src/runtime/preview';
import { escapesWorkspace, lockRoot, Runtime, type Composer, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import { writeAgentPage } from './helpers/agent-compose';
import { enhancerInput } from '../src/runtime/prompt-enhancer';
import { ExportRefused, sourceZip } from '../src/runtime/export';
import { openEventLog } from '../src/runtime/events';
import { filesSinceBase, headSha, isClean, showFileBytes, treeEntries } from '../src/runtime/git-workspace';
import { checkIdentity, packDesignFrontmatter } from '../src/identity-ephemeral';
import { parseBrandPack } from '../src/brand';
import type { AssetRule, FactsSource } from '../src/brand-facts-source';

const CDN: readonly AssetRule[] = [{ host: 'cdn.prod.website-files.com', prefixes: ['/68add96c398c867ed988e62d/'] }];
import { Connectors } from '../src/runtime/connectors';
import ts from 'typescript';

const allow: Allowlist = {
  'hero': { export: 'Hero', importPath: '@/components/blocks/hero', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
  'faq': { export: 'Faq', importPath: '@/components/blocks/faq', kind: 'block', schema: null, provides: [], propless: false, accepts: [] },
};
const block = (role: string, component: string) => ({ role, children: [{ component }] });
const PAGE_A: PageModel = { sections: [block('hero', 'hero'), block('faq', 'faq')] };
const PAGE_B: PageModel = { sections: [block('hero', 'hero')] };

let tmp: string;
let server: Server;
let base: string;
let pages: PageModel[];
let seen: ComposeRequest[];
let gate: Promise<void> | undefined;
let tscOut: string | ((dir: string) => string);
let patchPlanOut: unknown;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'v0-transport-'));
  // Scaffold mínimo: sin package.json no hay install, y sin vault no se trae ninguna fuente.
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  pages = [PAGE_A, PAGE_B, PAGE_A];
  seen = [];
  gate = undefined;
  tscOut = '';
  patchPlanOut = { route: 'full', reason: 'test' };
  const compose: Composer = async (req) => {
    seen.push(req);
    if (gate) await gate;
    return writeAgentPage(req, pages.shift() as PageModel);
  };
  const t = new Runtime({ root: join(tmp, 'state'), allow, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], fetchAsset: async () => ({ contentType: 'image/png', body: Buffer.from('png') }), heartbeatMs: 50, tsc: (dir) => (typeof tscOut === 'function' ? tscOut(dir) : tscOut), patchPlan: async () => patchPlanOut, typescript: ts, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
  server = t.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const post = (body: unknown) => fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// El stream cierra en settled (terminal único, ola 1); los tests miran lo que había antes de él.
const streamAt = async (at: string, id: string, cursor = -1): Promise<EngineEvent[]> => {
  const evs = (await (await fetch(`${at}/runs/${id}/events?cursor=${cursor}`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent);
  return evs.at(-1)?.type === 'settled' ? evs.slice(0, -1) : evs;
};
const events = (id: string, cursor = -1): Promise<EngineEvent[]> => streamAt(base, id, cursor);

const unzip = (buf: ArrayBuffer, ...args: string[]): string => {
  const f = join(tmp, `x-${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(f, Buffer.from(buf));
  return execFileSync('unzip', [...args, f], { encoding: 'utf8' });
};

describe('transport v0', () => {

  // Una página que el agente dejó con un error no bloquea las ediciones; cambiar ese error por otro sí cuenta como romper.
  test('textEdit se compara contra los errores que el archivo ya tenía, por código y mensaje', async () => {
    pages = [{ sections: [{ role: 'hero', children: [{ component: 'hero', props: { title: 'Hola' } }] }] } as PageModel];
    await post({ prompt: 'a', messageId: 'm1' });
    await events('m1');
    const old = "src/sections/01-hero.tsx(3,5): error TS2322: Type 'number' is not assignable to type 'string'.";
    tscOut = (dir) => (readFileSync(join(dir, 'src/sections/01-hero.tsx'), 'utf8').includes('Hola otro') ? "src/sections/01-hero.tsx(3,5): error TS2304: Cannot find name 'x'." : old);
    expect((await post({ parentId: 'm1', messageId: 't1', textEdit: { before: 'Hola', after: 'Hola igual' } })).status).toBe(202);
    expect((await events('t1')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'patch' });
    expect((await post({ parentId: 't1', messageId: 't2', textEdit: { before: 'Hola igual', after: 'Hola otro' } })).status).toBe(202);
    expect((await events('t2')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'error' });
  });

  // Un texto que llega por props no está como texto JSX: borrarlo a ciegas rompería el componente; va a Editar con IA.
  test('deleteElement de un texto que no está escrito en el JSX da 409 y uno mal formado 400, sin registrar nada', async () => {
    pages = [{ sections: [{ role: 'hero', children: [{ component: 'hero', props: { title: 'Hola' } }] }] } as PageModel];
    await post({ prompt: 'a', messageId: 'm1' });
    await events('m1');
    expect((await post({ parentId: 'm1', messageId: 'd1', deleteElement: { kind: 'text', text: 'Hola' } })).status).toBe(409);
    expect((await post({ parentId: 'm1', messageId: 'd2', deleteElement: { kind: 'video', src: 'x' } })).status).toBe(400);
    expect((await fetch(`${base}/runs/d1`)).status).toBe(404);
  });

  // B3 (#844) borró la rama {patch} sin rechazo: con prompt caía a un turno con modelo que gastaba e ignoraba el parche; sin
  // prompt daba "falta prompt". El cliente viejo tiene que enterarse de que la ruta se retiró, igual que repair:'render'.
  test('{patch} retirado da 400 explícito y no abre un turno con modelo', async () => {
    pages = [{ sections: [{ role: 'hero', children: [{ component: 'hero', props: { title: 'Hola' } }] }] } as PageModel];
    await post({ prompt: 'a', messageId: 'm1' });
    await events('m1');
    const calls = seen.length;
    const patch = [{ section: 0, path: 'children[0].props.title', value: 'x' }];
    const withPrompt = await post({ parentId: 'm1', messageId: 'p1', prompt: 'cambia el título', patch });
    expect(withPrompt.status).toBe(400);
    expect(seen.length).toBe(calls);
    const bare = await post({ parentId: 'm1', messageId: 'p2', patch });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { error?: string }).error ?? '').toMatch(/patch|parche/i);
  });

  // La página del runner envuelve cada sección en <WtSection> en una sola línea, que sectionOp ya reconoce (S1); un move
  // imposible (la primera hacia arriba) se rechaza igual antes de escribir.
  test('sectionOp mal formado da 400 y un move imposible 422, sin registrar nada', async () => {
    pages = [{ sections: [{ role: 'hero', children: [{ component: 'hero', props: { title: 'Hola' } }] }, { role: 'faq', children: [{ component: 'hero', props: { title: 'FAQ' } }] }] } as PageModel];
    await post({ prompt: 'a', messageId: 'm1' });
    await events('m1');
    expect((await post({ parentId: 'm1', messageId: 's1', sectionOp: { op: 'move', slug: '02-faq', to: 'left' } })).status).toBe(400);
    expect((await post({ parentId: 'm1', messageId: 's2', sectionOp: { op: 'move', slug: '01-hero', to: 'up' } })).status).toBe(422);
    expect((await fetch(`${base}/runs/s2`)).status).toBe(404);
  });

  // Mover solo reordena líneas de App.tsx: no hay import ni tipo que romper, así que no paga los 5 s del tsc del workspace.
  test('sectionOp move se guarda sin tsc y conserva los slugs de los archivos', async () => {
    const section = (slug: string, id: string) => `export default function S() { return <section id="${id}" data-wt-slug="${slug}">${id}</section>; }\n`;
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), section('01-hero', 'inicio'));
      writeFileSync(join(dir, 'src', 'sections', '02-faq.tsx'), section('02-faq', 'faq'));
      writeFileSync(join(dir, 'src', 'App.tsx'), "import Hero from './sections/01-hero';\nimport Faq from './sections/02-faq';\n\nexport default function App() {\n  return (\n    <main>\n      <Hero />\n      <Faq />\n    </main>\n  );\n}\n");
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx', 'src/sections/01-hero.tsx', 'src/sections/02-faq.tsx'], summary: 'ok', missing: [], suggestions: [] } };
    };
    let tscCalls = 0;
    server.close();
    const t = new Runtime({ root: join(tmp, 'move'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, tsc: () => { tscCalls++; return ''; }, typescript: ts, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'a', messageId: 'm1' });
    await events('m1');
    expect((await post({ parentId: 'm1', messageId: 'mv', sectionOp: { op: 'move', slug: '02-faq', to: 'up' } })).status).toBe(202);
    const evs = await events('mv');
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'patch' });
    expect(tscCalls).toBe(0);
    const files = (await (await fetch(`${base}/runs/mv/files`)).json()) as { files: { path: string; content?: string }[] };
    expect(files.files.map((f) => f.path)).toEqual(expect.arrayContaining(['src/sections/01-hero.tsx', 'src/sections/02-faq.tsx']));
    expect(files.files.find((f) => f.path === 'src/App.tsx')?.content).toMatch(/<Faq \/>\n\s+<Hero \/>/);
  });

  test('thinking y tools llegan al composer tal cual; un effort desconocido se rechaza', async () => {
    await post({ prompt: 'a', messageId: 'm1', thinking: { effort: 'high' }, tools: { webSearch: false } });
    await events('m1');
    expect(seen[0]).toMatchObject({ thinking: { effort: 'high' }, tools: { webSearch: false } });
    expect((await post({ prompt: 'x', thinking: { effort: 'ultra' } })).status).toBe(400);
  });

  test('con registry, el código sale del item; si el store no responde la corrida falla sin caer al vault', async () => {
    const item = { name: 'hero', files: [{ path: 'src/components/arc/blocks/hero/hero.tsx', content: 'export const Hero = () => null;\n' }] };
    // En la ruta del agente los items a traer salen del índice publicado (allowAt → loadIndex), no del allow estático.
    const make = (ok: boolean) => new Runtime({ root: join(tmp, ok ? 'ok' : 'down'), allow, compose: async (req) => writeAgentPage(req, PAGE_B), agent: true, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'),
      registry: async () => ({ pin: 'sha1', loadIndex: async () => ({ 'hero': allow['hero'] }), getItem: async () => { if (!ok) throw new Error('timeout'); return item; } }) });
    for (const ok of [true, false]) {
      const srv = make(ok).listen(0);
      await new Promise((r) => srv.once('listening', r));
      const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a', messageId: 'm1' }) });
      const evs = await streamAt(at, 'm1');
      srv.close();
      const reg = evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:ds');
      if (ok) {
        expect(reg).toMatchObject({ status: 'ok' });
        expect(evs.at(-1)?.type).toBe('snapshot');
      } else {
        expect(reg).toMatchObject({ status: 'error' });
        expect(evs.map((e) => e.type).slice(-2)).toEqual(['error', 'message.end']);
      }
    }
  });

  // Un bloque que solo conoce el índice publicado se monta desde el item (allowAt → loadIndex) y la versión se guarda.
  // El rechazo contra el skill local (unknownComponents del runner) se retiró con el runner (C5): el agente escribe el TSX
  // y un bloque sin código sale como error de tsc de su propio turno, no como rechazo del transport.
  test('un bloque que solo el índice publicado conoce se monta desde el item y la versión se guarda', async () => {
    const entry = { export: 'Layout253', importPath: '@/components/relume/layout253', kind: 'block' as const, schema: null, provides: [], propless: false, accepts: [] };
    const item = { name: 'layout253_block', files: [{ path: 'src/components/relume/layout253.tsx', content: 'export const Layout253 = () => null;\n' }] };
    const page: PageModel = { sections: [block('features', 'layout253_block')] };
    const t = new Runtime({ root: join(tmp, 'idx'), allow, compose: async (req) => writeAgentPage(req, page), agent: true, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'),
      registry: async () => ({ pin: 'sha1', getItem: async () => item, loadIndex: async () => ({ layout253_block: entry }) }) });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a', messageId: 'm1' }) });
    const evs = await streamAt(at, 'm1');
    srv.close();
    expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:ds')).toMatchObject({ status: 'ok' });
    expect(evs.at(-1)?.type).toBe('snapshot');
  });

  test('tras levantar el preview, sus defectos de runtime y los errores de vite quedan en un paso rojo, sin repair', async () => {
    const seenUrl: string[] = [];
    // Primera lectura: lo que quedó del turno; segunda: lo de la carga del check.
    const drains = [['[vite] Pre-transform error: Unexpected token (turno)'], ['[vite] Internal server error: Failed to resolve import']];
    const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => drains.shift() ?? [] } as unknown as PreviewPool;
    const t = new Runtime({ root: join(tmp, 'pc'), allow, compose: async (req) => writeAgentPage(req, PAGE_B), agent: true, autoRepair: false, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), previews,
      previewCheck: async (url) => { seenUrl.push(url); return [{ field: 'preview.runtime', owner: 'L6', kind: 'pageerror', slug: '01-hero', viewport: 1440, message: 'x.map is not a function' }]; } });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a', messageId: 'm1' }) });
    const evs = await streamAt(at, 'm1');
    srv.close();
    expect(seenUrl).toEqual(['http://127.0.0.1:5399/']);
    expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:preview-check')).toMatchObject({ status: 'error', label: 'Found 2 preview issues', error: { message: 'pageerror 01-hero: x.map is not a function\n[vite] Internal server error: Failed to resolve import' }, detail: { output: { turn: ['[vite] Pre-transform error: Unexpected token (turno)'] } } });
    expect(evs.some((e) => e.type === 'step.end' && e.stepId === 'transport:repair')).toBe(false);
    // Ola 1 A: el check es tardío, después de que la versión ya cerró.
    expect(evs.map((e) => e.type).slice(-4)).toEqual(['message.end', 'snapshot', 'step.start', 'step.end']);
  });

  // Karen 2026-11-03 (revoca la decisión del 2026-11-02): los errores del preview lanzan el arreglo solos, estilo figma-make.
  const autofixRig = async (root: string, extra: Partial<RuntimeOptions> = {}) => {
    const reqs: ComposeRequest[] = [];
    const compose: Composer = async (req) => {
      reqs.push(req);
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), `export default function Hero() { return <h1>Hola ${reqs.length}</h1>; }\n`);
      writeFileSync(join(dir, 'src', 'App.tsx'), "import Hero from './sections/01-hero';\nexport default function App() { return <Hero />; }\n");
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx', 'src/sections/01-hero.tsx'], summary: 'ok', missing: [], suggestions: [] } };
    };
    const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
    // El preview sigue roto también después del arreglo: es lo que pone a prueba el tope.
    const t = new Runtime({ root: join(tmp, root), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), previews,
      previewCheck: async () => [{ field: 'preview.runtime', owner: 'L6', kind: 'pageerror', slug: '01-hero', viewport: 1440, message: 'x.map is not a function' }], ...extra });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const post = (body: unknown) => fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post({ prompt: 'a', messageId: 'm1' });
    const parent = await streamAt(at, 'm1');
    const step = parent.find((e) => e.type === 'step.end' && e.stepId === 'transport:autofix') as { detail?: { childId?: string; autoRepair?: string } } | undefined;
    const childId = step?.detail?.childId;
    if (childId) await streamAt(at, childId);
    return { reqs, srv, at, post, parent, step, childId };
  };

  test('una versión con errores del preview lanza sola el arreglo como hijo marcado autoRepair, anunciado antes de settled', async () => {
    const { reqs, srv, at, parent, step, childId } = await autofixRig('af');
    const chat = (await (await fetch(`${at}/chats/m1`)).json()) as { messages: { messageId: string; parentId: string | null; autoRepair?: string }[] };
    srv.close();
    expect(step).toMatchObject({ status: 'ok', detail: { name: 'auto-repair', autoRepair: 'runtime' } });
    // streamAt quita el settled final: el anuncio es lo último antes de él.
    expect(parent.at(-1)).toBe(step as EngineEvent);
    expect(reqs).toHaveLength(2);
    expect(reqs[1]?.prompt).toContain('x.map is not a function');
    expect(chat.messages.find((m) => m.messageId === childId)).toMatchObject({ parentId: 'm1', autoRepair: 'runtime' });
  });

  test('el auto-repair es uno por versión y no se encadena; el arreglo manual queda de fallback', async () => {
    const { reqs, srv, post, childId } = await autofixRig('af-tope');
    await new Promise((r) => setTimeout(r, 150));
    // El hijo también cerró con el preview roto y no lanzó un tercer turno.
    expect(reqs).toHaveLength(2);
    const used = await post({ repair: 'runtime', parentId: 'm1', auto: true });
    const chained = await post({ repair: 'runtime', parentId: childId, auto: true });
    expect([used.status, ((await used.json()) as { code?: string }).code]).toEqual([409, 'auto-repair-used']);
    expect([chained.status, ((await chained.json()) as { code?: string }).code]).toEqual([409, 'auto-repair-of-repair']);
    expect((await post({ repair: 'runtime', parentId: 'm1', messageId: 'f1' })).status).toBe(202);
    srv.close();
  });

  test('con autoRepair: false el POST auto:true del puente vivo se rechaza y solo queda el arreglo manual', async () => {
    const { reqs, srv, post, childId } = await autofixRig('af-off', { autoRepair: false });
    const auto = await post({ repair: 'runtime', parentId: 'm1', auto: true });
    expect(childId).toBeUndefined();
    expect([auto.status, ((await auto.json()) as { code?: string }).code]).toEqual([409, 'auto-repair-off']);
    expect(reqs).toHaveLength(1);
    expect((await post({ repair: 'runtime', parentId: 'm1', messageId: 'f1' })).status).toBe(202);
    srv.close();
  });

  // Ola 2 E: el historial del follow-up sale de la cadena de padres (pedidos + resumen de cada versión) y del log del padre.
  test('el follow-up recibe la cadena de pedidos con sus resúmenes y los pasos del agente del padre', async () => {
    const tools: ComposeRequest[] = [];
    const compose: Composer = async (req, log) => {
      tools.push(req);
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${req.messageId}</main>; }\n`);
      log.emit({ type: 'step.start', stepId: `t-${req.messageId}`, kind: 'tool', label: 'Revisando tipos', parentStepId: 'agent:write' });
      log.emit({ type: 'step.end', stepId: `t-${req.messageId}`, label: 'Tipos revisados', status: 'ok', detail: { kind: 'tool', name: 'typecheck', output: `ok ${req.messageId}` } });
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: `resumen ${req.messageId}`, missing: [], suggestions: [] } };
    };
    server.close();
    const t = new Runtime({ root: join(tmp, 'hist'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing para Acme', messageId: 't1' });
    await events('t1');
    await post({ prompt: 'acento azul', messageId: 't2', parentId: 't1' });
    await events('t2');
    await post({ prompt: 'cambia el título', messageId: 't3', parentId: 't2' });
    await events('t3');
    expect(tools[0]).not.toHaveProperty('history');
    expect(tools[2]?.history).toEqual({
      thread: [{ messageId: 't1', prompt: 'landing para Acme', summary: 'resumen t1' }, { messageId: 't2', prompt: 'acento azul', summary: 'resumen t2' }],
      tools: [{ label: 'Tipos revisados', status: 'ok', output: 'ok t2' }],
      toolHistory: [
        { messageId: 't1', prompt: 'landing para Acme', tools: [{ label: 'Tipos revisados', status: 'ok', output: 'ok t1' }] },
        { messageId: 't2', prompt: 'acento azul', tools: [{ label: 'Tipos revisados', status: 'ok', output: 'ok t2' }] },
      ],
      lastSummary: 'resumen t2',
      lastFiles: ['src/App.tsx'],
    });
  });

  // R6 C1: lo que midió el preview-check del padre y el viewport que la persona mira viajan al follow-up como contexto.
  test('el follow-up recibe los defectos del preview-check del padre y el viewport del request; un viewport inválido es 400', async () => {
    const seen: ComposeRequest[] = [];
    const compose: Composer = async (req, log) => {
      seen.push(req);
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${req.messageId}</main>; }\n`);
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: `resumen ${req.messageId}`, missing: [], suggestions: [] } };
    };
    server.close();
    const t = new Runtime({ root: join(tmp, 'ctx'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'c1' });
    await events('c1');
    openEventLog(join(tmp, 'ctx', 'logs'), 'c1').emit({ type: 'step.end', stepId: 'transport:preview-check', label: 'Found 1 preview issue', status: 'error', detail: { kind: 'tool', name: 'preview-runtime', output: { url: 'http://p', defects: [{ field: 'preview.runtime', owner: 'L6', kind: 'console-error', slug: '02-hero', viewport: 1440, message: 'Cannot read properties of null' }], server: [] } } });
    const bad = await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', parentId: 'c1', viewport: { width: 0, height: 800 } }) });
    expect(bad.status).toBe(400);
    await post({ prompt: 'cambia el título', messageId: 'c2', parentId: 'c1', viewport: { width: 1280, height: 800, colorScheme: 'dark' } });
    await events('c2');
    expect(seen[0]).not.toHaveProperty('history');
    expect(seen[1]?.history?.viewport).toEqual({ width: 1280, height: 800, colorScheme: 'dark' });
    expect(seen[1]?.history?.previewCheck?.defects).toMatchObject([{ kind: 'console-error', slug: '02-hero', viewport: 1440 }]);
  });

  test('rechaza un Host ajeno (DNS rebinding) y un Origin ajeno (CSRF); acepta loopback', async () => {
    const port = (server.address() as { port: number }).port;
    const raw = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port, path: '/image-models', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.end();
    });
    expect(await raw({ host: 'evil.example:80' })).toBe(403);
    expect(await raw({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).toBe(403);
    expect(await raw({ host: `localhost:${port}`, origin: 'http://localhost:5173' })).toBe(200);
  });

  test('un .html disfrazado de text/plain no entra: el tipo efectivo sale del nombre y se rechaza', async () => {
    const form = new FormData();
    form.append('file', new File(['<script>1</script>'], 'x.html', { type: 'text/plain' }));
    expect((await fetch(`${base}/uploads`, { method: 'POST', headers: { 'x-wt-request': '1' }, body: form })).status).toBe(415);
  });

  test('el estado de página del primer mensaje sobrevive al follow-up y llega a index.html', async () => {
    const scaffold = join(tmp, 'doc-scaffold');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    writeFileSync(join(scaffold, 'index.html'), '<!doctype html>\n<html lang="es" data-theme="light">\n  <head>\n    <title>Acme Pulse</title>\n  </head>\n</html>\n');
    const doc = { lang: 'en' as const, title: 'Nimbus — PM for remote teams', description: 'Async standups', facts: { brand: 'Nimbus' } };
    const queue: PageModel[] = [{ page: doc, sections: PAGE_A.sections }];
    const t = new Runtime({ root: join(tmp, 'doc'), allow, compose: async (req) => writeAgentPage(req, queue.shift() ?? PAGE_A), agent: true, build: false, autoRepair: false, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault') });
    const srv = t.listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const evsOf = (id: string) => streamAt(at, id);
    const commitOf = (evs: EngineEvent[]) => (evs.at(-1) as { commit: string }).commit;
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Nimbus landing', messageId: 'm1' }) });
    const first = await evsOf('m1');
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'cambia el titular', messageId: 'm2', parentId: 'm1' }) });
    const followed = await evsOf('m2');
    srv.close();
    const dir = join(tmp, 'doc', 'ws', 'm1');
    for (const evs of [first, followed]) {
      const html = execFileSync('git', ['show', `${commitOf(evs)}:index.html`], { cwd: dir, encoding: 'utf8' });
      expect(html).toContain('<html lang="en" data-theme="light">');
      expect(html).toContain('<title>Nimbus — PM for remote teams</title>');
      expect(html).toContain('<meta name="description" content="Async standups" />');
      const page = JSON.parse(execFileSync('git', ['show', `${commitOf(evs)}:page.json`], { cwd: dir, encoding: 'utf8' })) as PageModel;
      expect(page.page).toEqual(doc);
    }
  });

  test('un follow-up usa el índice del registry de su versión padre, no el último pin', async () => {
    const entry = { export: 'Layout253', importPath: '@/components/relume/layout253', kind: 'block' as const, schema: null, provides: [], propless: false, accepts: [] };
    const item = { name: 'layout253_block', files: [{ path: 'src/components/relume/layout253.tsx', content: 'export const Layout253 = () => null;\n' }] };
    const page: PageModel = { sections: [{ role: 'features', children: [{ component: 'layout253_block', props: { title: 'x' } }] }] };
    let latest = 'pin-1';
    const opened: (string | undefined)[] = [];
    const make = () => new Runtime({ root: join(tmp, 'pin'), allow, compose: async (req) => writeAgentPage(req, page), agent: true, build: false, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'),
      registry: async (pin) => {
        opened.push(pin);
        return { pin: pin ?? latest, getItem: async () => item, loadIndex: async () => ({ layout253_block: entry }) };
      } });
    const srv = make().listen(0);
    await new Promise((r) => srv.once('listening', r));
    const at = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a', messageId: 'm1' }) });
    await (await fetch(`${at}/runs/m1/events`)).text();
    latest = 'pin-2';
    await fetch(`${at}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'b', messageId: 'm2', parentId: 'm1' }) });
    await (await fetch(`${at}/runs/m2/events`)).text();
    srv.close();
    // m1 abre el registry con el último pin (undefined → pin-1); el follow-up m2 reabre con el pin del padre, no pin-2.
    expect(opened).toEqual([undefined, 'pin-1']);
  });

  test('si el composer falla, el log cierra con error y message.end error, sin snapshot', async () => {
    pages = [];
    await post({ prompt: 'x', messageId: 'm1' });
    const evs = await events('m1');
    expect(evs.map((e) => e.type).slice(-2)).toEqual(['error', 'message.end']);
    expect((await fetch(`${base}/runs/m1/files`)).status).toBe(409);
  });

  test('GET /chats/:chatId devuelve el hilo para rehidratar: prompt completo, modelo, versión y si el log sigue abierto', async () => {
    await post({ prompt: 'Landing de Nimbus\ncon waitlist', messageId: 'h1', model: 'opus' });
    await events('h1');
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    await post({ prompt: 'Cambia el título', messageId: 'h2', parentId: 'h1' });
    while (seen.length < 2) await new Promise((r) => setTimeout(r, 5));
    const res = await fetch(`${base}/chats/h1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chatId: string; messages: { messageId: string; parentId: string | null; prompt: string; model?: string; commit: string | null; done: boolean }[]; preview: string | null };
    expect(body.chatId).toBe('h1');
    expect(body.messages.map((m) => [m.messageId, m.parentId, m.prompt, m.model ?? null, Boolean(m.commit), m.done])).toEqual([
      ['h1', null, 'Landing de Nimbus\ncon waitlist', 'opus', true, true],
      ['h2', 'h1', 'Cambia el título', null, false, false],
    ]);
    expect(body.preview).toBeNull();
    // Solo el mensaje raíz es un chat; un id desconocido o mal formado no lee nada.
    expect((await fetch(`${base}/chats/h2`)).status).toBe(404);
    expect((await fetch(`${base}/chats/nadie`)).status).toBe(404);
    expect((await fetch(`${base}/chats/..%2Fx`)).status).toBe(400);
    release();
    await events('h2');
  });

  test('steer: un mensaje con el turno del agente en curso entra a ese turno (202 queued) y queda en su log', async () => {
    server.close();
    const got: string[] = [];
    let started = false;
    let finish: (() => void) | undefined;
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      req.steer?.bind((text) => { got.push(text); return true; });
      started = true;
      await new Promise<void>((r) => { finish = r; });
      req.steer?.bind(undefined);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${got.join(' ')}</main>; }\n`);
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'ok', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'steer'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await post({ prompt: 'landing', messageId: 's1' });
    while (!started) await new Promise((r) => setTimeout(r, 5));
    const res = await post({ prompt: 'y el subtítulo', messageId: 's2', parentId: 's1', selectedSections: ['02-hero'] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId: 's1', queued: true });
    expect((await post({ prompt: 'x'.repeat(4001), parentId: 's1' })).status).toBe(400);
    for (let i = 1; i < 20; i++) expect((await post({ prompt: `m${i}`, parentId: 's1' })).status).toBe(202);
    expect((await post({ prompt: 'uno más', parentId: 's1' })).status).toBe(429);
    expect((await post({ prompt: 'con foto', parentId: 's1', attachments: [{ url: 'x', name: 'a.png', contentType: 'image/png', size: 1 }] })).status).toBe(400);
    finish?.();
    const evs = await events('s1');
    expect(evs.filter((e) => e.type === 'steer')).toHaveLength(20);
    expect(got[0]).toBe('y el subtítulo');
    // La sección del mensaje en vuelo queda en su evento: request.json es del pedido original (review de ec, #375).
    expect(evs.find((e) => e.type === 'steer')).toMatchObject({ text: 'y el subtítulo', selectedSections: ['02-hero'] });
    // El steer no abre mensaje: s2 no existe y la versión es la de s1.
    expect((await fetch(`${base}/runs/s2`)).status).toBe(404);
    expect(evs.at(-1)).toMatchObject({ type: 'snapshot' });
  });

  test('steer sin turno que lo lea (composer que no es el agente) da 409 con el motivo, no "padre sin versión"', async () => {
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    await post({ prompt: 'a', messageId: 'g1' });
    while (!seen.length) await new Promise((r) => setTimeout(r, 5));
    const res = await post({ prompt: 'b', messageId: 'g2', parentId: 'g1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('ya no recibe mensajes');
    release();
    await events('g1');
    // Con el turno ya cerrado, el mensaje marcado como steer no abre una corrida que el builder no seguiría.
    expect((await post({ prompt: 'c', messageId: 'g3', parentId: 'g1', steer: true })).status).toBe(409);
    expect((await fetch(`${base}/runs/g3`)).status).toBe(404);
  });

  test('un root lo usa un solo proceso: el lock de otro pid vivo no deja arrancar y el de un pid muerto se toma', () => {
    const root = join(tmp, 'locked');
    mkdirSync(root, { recursive: true });
    // El padre de bun test está vivo y no es este proceso: es "otro transport" sobre el mismo root.
    writeFileSync(join(root, '.lock'), String(process.ppid));
    expect(() => lockRoot(root)).toThrow(/ya lo usa otro transport/);
    const dead = Bun.spawnSync(['true']).pid;
    writeFileSync(join(root, '.lock'), String(dead));
    expect(() => lockRoot(root)).not.toThrow();
    expect(readFileSync(join(root, '.lock'), 'utf8')).toBe(String(process.pid));
  });

  test('un agente que murió por una señal ajena deja su versión como detenida, no un error que la descarta', async () => {
    server.close();
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main>a medias</main>; }\n');
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: '', missing: [], suggestions: [], interrupted: true } };
    };
    const t = new Runtime({ root: join(tmp, 'hup'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'u1' });
    const evs = await events('u1');
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stopped' });
    expect(evs.at(-1)).toMatchObject({ type: 'snapshot' });
  });

  test('cancel: el follow-up detenido guarda lo escrito como versión stopped; el primer mensaje detenido no deja versión', async () => {
    server.close();
    let started = false;
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      if (req.prompt !== 'quieto') {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${req.prompt}</main>; }\n`);
      }
      if (req.prompt === 'listo') return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'ok', missing: [], suggestions: [] } };
      // Como el agente real: corta al abortarse y deja lo escrito en el árbol.
      await new Promise<void>((_r, reject) => { req.signal?.addEventListener('abort', () => reject(new Error('cortado')), { once: true }); started = true; });
      throw new Error('inalcanzable');
    };
    const t = new Runtime({ root: join(tmp, 'cancel'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cancel = (id: string) => fetch(`${base}/runs/${id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const waitStarted = async () => { while (!started) await new Promise((r) => setTimeout(r, 5)); started = false; };

    expect((await cancel('nadie')).status).toBe(404);
    await post({ prompt: 'listo', messageId: 'c1' });
    await events('c1');
    expect((await cancel('c1')).status).toBe(409);

    await post({ prompt: 'a medias', messageId: 'c2', parentId: 'c1' });
    await waitStarted();
    expect((await cancel('c2')).status).toBe(202);
    const evs = await events('c2');
    expect(evs.slice(-2).map((e) => e.type)).toEqual(['message.end', 'snapshot']);
    // Quién cortó queda en el log de la corrida (QA a67a41ed/d0b82343 cerraron 'stopped' sin decir por qué).
    expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:stop')).toMatchObject({ detail: { summary: expect.stringContaining('POST /runs/c2/cancel') } });
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stopped' });
    const ws = join(tmp, 'cancel', 'ws', 'c1');
    expect(execFileSync('git', ['show', 'HEAD:src/App.tsx'], { cwd: ws, encoding: 'utf8' })).toContain('a medias');
    // Un follow-up cuelga de la versión detenida.
    await post({ prompt: 'listo', messageId: 'c3', parentId: 'c2' });
    expect((await events('c3')).some((e) => e.type === 'snapshot')).toBe(true);
    // Detenido antes de escribir: no hay versión nueva (sería idéntica a c3) y el siguiente cuelga de c3.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' });
    await post({ prompt: 'quieto', messageId: 'c4', parentId: 'c3' });
    await waitStarted();
    await cancel('c4');
    const idle = await events('c4');
    expect(idle.at(-1)).toMatchObject({ type: 'message.end', finishReason: 'stopped' });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' })).toBe(head);
    expect((await post({ prompt: 'listo', messageId: 'c5', parentId: 'c4' })).status).toBe(409);

    await post({ prompt: 'nuevo', messageId: 'd1' });
    await waitStarted();
    await cancel('d1');
    const first = await events('d1');
    expect(first.at(-1)).toMatchObject({ type: 'message.end', finishReason: 'stopped' });
    expect(first.some((e) => e.type === 'snapshot')).toBe(false);
    expect(existsSync(join(tmp, 'cancel', 'ws', 'd1', 'src', 'App.tsx'))).toBe(false);
  });

  test('shutdown corta la corrida en curso antes de salir y no acepta corridas nuevas', async () => {
    server.close();
    let started = false;
    let aborted = false;
    const compose: Composer = async (req) => {
      // Como el CLI del agente: sigue corriendo hasta que lo abortan.
      await new Promise<void>((_r, reject) => { req.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('cortado')); }, { once: true }); started = true; });
      throw new Error('inalcanzable');
    };
    const t = new Runtime({ root: join(tmp, 'shutdown'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'larga', messageId: 's1' });
    while (!started) await new Promise((r) => setTimeout(r, 5));
    await t.shutdown(2_000);
    expect(aborted).toBe(true);
    expect((await events('s1')).find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stopped' });
    expect((await post({ prompt: 'otra', messageId: 's2' })).status).toBe(503);
  });

  // QA A8 (c7c7ec26): un turno que solo cambió fotos (generate_image/edit_image, sin Write/Edit) quedaba como pregunta,
  // con la versión del padre, y snapshot.files no listaba las imágenes.
  test('un follow-up que solo escribe una imagen es versión propia y snapshot.files sale del diff del commit', async () => {
    server.close();
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      if (req.prompt === 'base') {
        mkdirSync(join(dir, 'src'), { recursive: true });
        writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
        return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'ok', missing: [], suggestions: [] } };
      }
      if (req.prompt === 'foto') {
        mkdirSync(join(dir, 'public', 'images'), { recursive: true });
        writeFileSync(join(dir, 'public', 'images', 'hero.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      }
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: req.prompt === 'foto' ? 'Cambié la foto' : '¿Qué color?', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'imgonly'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'base', messageId: 'b1' });
    const first = (await events('b1')).find((e) => e.type === 'snapshot') as { commit: string } | undefined;
    await post({ prompt: 'foto', messageId: 'b2', parentId: 'b1' });
    const snap = (await events('b2')).find((e) => e.type === 'snapshot') as { commit: string; files: string[] } | undefined;
    expect(snap?.commit).not.toBe(first?.commit);
    expect(snap?.files).toContain('public/images/hero.jpg');
    expect(snap?.files).not.toContain('src/App.tsx');
    // Sin cambios en el árbol sigue siendo una pregunta: la versión es la del padre.
    await post({ prompt: 'pregunta', messageId: 'b3', parentId: 'b2' });
    const asked = (await events('b3')).find((e) => e.type === 'snapshot') as { commit: string; files: string[] } | undefined;
    expect(asked).toMatchObject({ commit: snap?.commit, files: [] });
  });

  test('--agent (ADR 0011): el composer recibe workspace.dir, el transport no emite TSX, guarda lo que el agente escribió y request.json dice agent', async () => {
    server.close();
    let got: ComposeRequest | undefined;
    const compose: Composer = async (req) => {
      got = req;
      const dir = req.workspace?.dir as string;
      mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), 'export default function Hero() { return <section id="inicio" data-wt-role="hero" />; }\n');
      writeFileSync(join(dir, 'src', 'App.tsx'), 'import Hero from "./sections/01-hero";\nexport default function App() { return <main><Hero /></main>; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/sections/01-hero.tsx', 'src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    // Un package.json sin deps: basta para ver que el install corre antes del turno (node_modules no aparece, bun no crea nada).
    const scaffold2 = join(tmp, 'scaffold2');
    mkdirSync(join(scaffold2, 'src'), { recursive: true });
    writeFileSync(join(scaffold2, '.gitignore'), 'node_modules\n');
    writeFileSync(join(scaffold2, 'package.json'), '{"name":"ws","private":true}\n');
    const t = new Runtime({ root: join(tmp, 'state2'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold2, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing de Acme', messageId: 'a1' });
    const evs = await events('a1');
    expect(evs.map((e) => e.type).slice(-2)).toEqual(['message.end', 'snapshot']);
    expect(got?.workspace?.dir).toBe(join(tmp, 'state2', 'ws', 'a1'));
    // Sin preview no hay URL para la tool browser.
    expect(got?.workspace?.previewUrl).toBeUndefined();
    // Las dependencias se instalan antes del turno (el agente compila durante su turno), no en materialize.
    const order = evs.filter((e) => e.type === 'step.start').map((e) => e.type === 'step.start' && e.stepId);
    expect(order.indexOf('transport:install')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('transport:install')).toBeLessThan(order.indexOf('transport:commit'));
    // Nada de buildWorkspace: ni 'Reading registry' ni archivos de sección generados por el runner.
    expect(evs.some((e) => e.type === 'step.start' && e.stepId === 'transport:registry')).toBe(false);
    expect(evs.some((e) => e.type === 'step.start' && e.stepId === 'transport:render')).toBe(false);
    const files = (await (await fetch(`${base}/runs/a1/files`)).json()) as { files: { path: string }[] };
    expect(files.files.map((f) => f.path)).toEqual(['page.json', 'src/App.tsx', 'src/sections/01-hero.tsx']);
    const ws = join(tmp, 'state2', 'ws', 'a1');
    const page = JSON.parse(readFileSync(join(ws, 'page.json'), 'utf8'));
    expect(page).toEqual({ sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/sections/01-hero.tsx', 'src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } });
    const req = JSON.parse(readFileSync(join(ws, 'request.json'), 'utf8'));
    expect(req.agent).toBe(true);
    expect(req.workspace).toBeUndefined();
  });
});
