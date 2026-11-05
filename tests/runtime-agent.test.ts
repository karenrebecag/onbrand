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

  // S5 variantes en paralelo (ZAP 26790): una petición, un workspace por variante, un prompt propio por variante.
  const variantsTransport = async (name: string, compose: Composer, variantsPlan: (s: string, u: string) => Promise<unknown>, maxRunning = 3, imageModels: { id: string; name: string; provider: string }[] = []) => {
    server.close();
    const t = new Runtime({ root: join(tmp, name), allow, compose, agent: true, build: false, imageModels, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), variantsPlan, maxRunning });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return join(tmp, name);
  };
  const writePage = (req: ComposeRequest, text: string): PageModel => {
    const dir = req.workspace?.dir as string;
    mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
    writeFileSync(join(dir, 'src', 'sections', '01-hero.tsx'), `export default function Hero() { return <section id="inicio">${text}</section>; }\n`);
    return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/sections/01-hero.tsx'], summary: 'ok', missing: [], suggestions: [] } };
  };

  test('variantes: N chats con su propio workspace bifurcado de la fuente, cada uno con su título y prompt, y a lo sumo maxRunning a la vez', async () => {
    const seen: { prompt: string; dir: string; parentId?: string }[] = [];
    let live = 0;
    let peak = 0;
    const compose: Composer = async (req) => {
      if (!req.parentId) return writePage(req, 'fuente');
      live += 1;
      peak = Math.max(peak, live);
      seen.push({ prompt: req.prompt, dir: req.workspace?.dir as string, parentId: req.parentId });
      await new Promise((r) => setTimeout(r, 30));
      live -= 1;
      return writePage(req, req.prompt);
    };
    const inputs: string[] = [];
    const root = await variantsTransport('variants', compose, async (_s, u) => {
      inputs.push(u);
      return { variants: [{ title: 'Variante 1: Densa', prompt: 'P1' }, { title: 'Variante 2: Mínima', prompt: 'P2' }] };
    }, 1);
    await post({ prompt: 'landing', messageId: 'm1' });
    await events('m1');
    expect((await post({ variants: { sourceId: 'm1', count: 6 } })).status).toBe(400);
    expect((await post({ variants: { sourceId: 'nope', count: 2 } })).status).toBe(404);
    const r = await post({ variants: { sourceId: 'm1', count: 2, aspects: ['layout'] } });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { groupId: string; sourceId: string; variants: { messageId: string; index: number }[] };
    expect(body.sourceId).toBe('m1');
    expect(body.variants.map((v) => v.index)).toEqual([0, 1]);
    const logs = await Promise.all(body.variants.map((v) => events(v.messageId)));
    logs.forEach((evs, i) => {
      expect(evs.find((e) => e.type === 'variant')).toMatchObject({ groupId: body.groupId, sourceId: 'm1', index: i, count: 2, title: `Variante ${i + 1}: ${i ? 'Mínima' : 'Densa'}`, prompt: `P${i + 1}` });
      expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stop' });
    });
    // El plan recibe el prompt de Stitch con la cantidad y la página fuente.
    expect(JSON.parse(inputs[0])).toMatchObject({ count: 2, basePrompt: expect.stringContaining('create 2 variants'), page: { title: 'Acme' } });
    expect(seen.map((s) => s.prompt).sort()).toEqual(['P1', 'P2']);
    expect(seen.every((s) => s.parentId === 'm1')).toBe(true);
    // Workspaces propios, ninguno el de la fuente, y la fuente no cambia.
    expect(new Set(seen.map((s) => s.dir)).size).toBe(2);
    expect(seen.some((s) => s.dir === join(root, 'ws', 'm1'))).toBe(false);
    expect(readFileSync(join(root, 'ws', 'm1', 'src', 'sections', '01-hero.tsx'), 'utf8')).toContain('fuente');
    for (const s of seen) expect(readFileSync(join(s.dir, 'src', 'sections', '01-hero.tsx'), 'utf8')).toContain(s.prompt);
    expect(peak).toBe(1);
  });

  test('variantes: si el plan falla siguen con un prompt propio, y si una variante falla la otra termina igual', async () => {
    const compose: Composer = async (req) => {
      if (!req.parentId) return writePage(req, 'fuente');
      if (req.prompt.includes('variante 1 de 2')) throw new Error('falló la variante 1');
      return writePage(req, 'v2');
    };
    await variantsTransport('variants-fail', compose, async () => { throw new Error('sin cuota'); });
    await post({ prompt: 'landing', messageId: 'm1' });
    await events('m1');
    const body = (await (await post({ variants: { sourceId: 'm1', count: 2 } })).json()) as { variants: { messageId: string }[] };
    const [v1, v2] = await Promise.all(body.variants.map((v) => events(v.messageId)));
    expect(v1.find((e) => e.type === 'variant')).toMatchObject({ title: 'Variante 1', prompt: expect.stringContaining('variante 1 de 2') });
    expect(v1.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'error' });
    expect(v2.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stop' });
  });

  // QA A8: las variantes corrían sin tools de imagen y sin el thinking del chat. Lo que trae el POST llega a cada variante.
  test('variantes: imageGeneration y thinking del POST llegan a cada variante, con endpoint de aprobación para las tools de imagen', async () => {
    const seen: ComposeRequest[] = [];
    const compose: Composer = async (req) => {
      if (!req.parentId) return writePage(req, 'fuente');
      seen.push(req);
      return writePage(req, req.prompt);
    };
    await variantsTransport('variants-img', compose, async () => ({ variants: [{ title: 'V1', prompt: 'P1' }, { title: 'V2', prompt: 'P2' }] }), 3, [{ id: 'img-1', name: 'Img', provider: 'test' }]);
    await post({ prompt: 'landing', messageId: 'm1' });
    await events('m1');
    const r = await post({ variants: { sourceId: 'm1', count: 2 }, imageGeneration: { modelId: 'img-1' }, thinking: { effort: 'high' } });
    const body = (await r.json()) as { variants: { messageId: string }[] };
    await Promise.all(body.variants.map((v) => events(v.messageId)));
    expect(seen).toHaveLength(2);
    for (const req of seen) {
      expect(req.imageGeneration).toEqual({ modelId: 'img-1' });
      expect(req.thinking).toEqual({ effort: 'high' });
      expect(req.approval?.token).toBeString();
    }
  });

  test('variantes: cancelar el grupo saca de la cola las que esperan y corta las que corren', async () => {
    let release: () => void = () => {};
    const compose: Composer = async (req) => {
      if (!req.parentId) return writePage(req, 'fuente');
      await new Promise<void>((r) => { release = r; });
      return writePage(req, 'v');
    };
    await variantsTransport('variants-cancel', compose, async () => ({ variants: [{ title: 'A', prompt: 'PA' }, { title: 'B', prompt: 'PB' }, { title: 'C', prompt: 'PC' }] }), 1);
    await post({ prompt: 'landing', messageId: 'm1' });
    await events('m1');
    const body = (await (await post({ variants: { sourceId: 'm1', count: 3 } })).json()) as { groupId: string; variants: { messageId: string }[] };
    for (let i = 0; i < 100 && !(await (await fetch(`${base}/runs/${body.variants[0].messageId}`)).json() as { events: EngineEvent[] }).events.some((e) => e.type === 'variant'); i++) await new Promise((r) => setTimeout(r, 10));
    const c = await fetch(`${base}/variants/${body.groupId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(c.status).toBe(202);
    expect(((await c.json()) as { cancelled: string[] }).cancelled.sort()).toEqual(body.variants.map((v) => v.messageId).sort());
    release();
    const logs = await Promise.all(body.variants.map((v) => events(v.messageId)));
    // Las dos en cola cierran detenidas sin haber corrido.
    for (const evs of logs.slice(1)) {
      expect(evs.some((e) => e.type === 'variant')).toBe(false);
      expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ finishReason: 'stopped' });
    }
    expect((await fetch(`${base}/variants/nope/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } })).status).toBe(404);
  });

  // S5 cambio 3: el enhancer de Stitch (usePromptPreview :44-89) por HTTP; el cliente acumula los chunks.
  test('POST /prompt-enhancements: el texto llega en chunks con el system de Stitch, y un prompt vacío o largo es 400', async () => {
    server.close();
    const inputs: string[] = [];
    const enhance = async function* (prompt: string) {
      inputs.push(prompt);
      yield 'A modern ';
      yield 'landing.';
    };
    const t = new Runtime({ root: join(tmp, 'stateE'), allow, compose: async () => PAGE_A, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), enhance });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const enh = (prompt: string) => fetch(`${base}/prompt-enhancements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
    const r = await enh('landing de Acme');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(await r.text()).toBe('A modern landing.');
    expect(inputs).toEqual([enhancerInput('landing de Acme')]);
    expect((await enh('  ')).status).toBe(400);
    expect((await enh('x'.repeat(4001))).status).toBe(400);
    expect(inputs).toHaveLength(1);
  });

  test('POST /prompt-enhancements: si el modelo no llega a tiempo o falla, 200 con el prompt original, nunca 500', async () => {
    server.close();
    // Un modelo colgado que solo suelta al abortar, como spawnCli con su señal.
    const hung = async function* (_p: string, signal: AbortSignal) {
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason), { once: true }));
      yield 'nunca';
    };
    const t = new Runtime({ root: join(tmp, 'stateE3'), allow, compose: async () => PAGE_A, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), enhance: hung, enhanceTimeoutMs: 20 });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const r = await fetch(`${base}/prompt-enhancements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing de Acme' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-enhancer')).toBe('fallback');
    expect(await r.text()).toBe('landing de Acme');
  });

  // seguridad-ronda H2: el "uno a la vez" del enhancer es del cliente; el servidor corta en 2 para no gastar sin tope.
  test('POST /prompt-enhancements: con 2 en curso el tercero es 429, y al terminar uno vuelve a aceptar', async () => {
    server.close();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const enhance = async function* () { yield 'a'; await gate; yield 'b'; };
    const t = new Runtime({ root: join(tmp, 'stateE2'), allow, compose: async () => PAGE_A, build: false, heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), enhance });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const enh = () => fetch(`${base}/prompt-enhancements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing' }) });
    const a = enh(), b = enh();
    await Promise.all([a, b]);
    expect((await enh()).status).toBe(429);
    release();
    expect(await (await a).text()).toBe('ab');
    await (await b).text();
    expect((await enh()).status).toBe(200);
  });

  // S5 regla 8: la imagen la pide el agente con generate_image; el transport ya no corre un preflight en paralelo.
  test('--agent con imágenes: no hay preflight de imagen ni productAsset, y la imagen no frena el turno', async () => {
    server.close();
    let got: ComposeRequest | undefined;
    const compose: Composer = async (req) => { got = req; return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: '', missing: [], suggestions: [] } }; };
    const scaffoldP = join(tmp, 'scaffoldP');
    mkdirSync(join(scaffoldP, 'src'), { recursive: true });
    writeFileSync(join(scaffoldP, '.gitignore'), 'node_modules\n');
    const t = new Runtime({ root: join(tmp, 'stateP'), allow, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: scaffoldP, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing de Acme', messageId: 'p1', imageGeneration: { modelId: 'img-1' } });
    const evs = await events('p1');
    expect(got?.imageGeneration).toEqual({ modelId: 'img-1' });
    expect(got && 'productAsset' in got).toBe(false);
    expect(evs.some((e) => e.type === 'step.start' && e.stepId === 'transport:parallel')).toBe(false);
  });

  // Ronda de conectores: los slugs del request se vuelven servidores MCP del agente y sus lecturas quedan en readOnlyTools.
  test('--agent con connectors: el transport arma los MCP de las apps del request, registra las tools de lectura y no filtra el token al log', async () => {
    server.close();
    let got: ComposeRequest | undefined;
    const compose: Composer = async (req) => { got = req; return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: '', missing: [], suggestions: [] } }; };
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/v1/oauth/token')) return Response.json({ access_token: 'tok-secreto', expires_in: 3600 });
      const body = JSON.parse(String(init?.body)) as { method: string };
      return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'initialize' ? {} : { tools: [{ name: 'slack-list-channels', annotations: { readOnlyHint: true } }] } });
    }) as typeof fetch;
    const connectors = new Connectors({ clientId: 'id', clientSecret: 's', projectId: 'proj', environment: 'development', externalUserId: 'u1' }, f);
    const scaffoldC = join(tmp, 'scaffoldC');
    mkdirSync(join(scaffoldC, 'src'), { recursive: true });
    writeFileSync(join(scaffoldC, '.gitignore'), 'node_modules\n');
    const t = new Runtime({ root: join(tmp, 'stateC'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffoldC, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), connectors });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing con mi slack', messageId: 'c1', connectors: ['slack'] });
    const evs = await events('c1');
    expect(got?.connectorMcp?.readOnlyTools).toEqual(['mcp__slack__slack-list-channels']);
    expect(got?.connectorMcp?.apps).toEqual(['slack']);
    expect(JSON.stringify(got)).not.toContain('tok-secreto');
    const text = JSON.stringify(evs);
    expect(text).toContain('slack: 1 tools de lectura');
    // wt y approval ya son servidores del --mcp-config; `__` es el separador de mcp__<app>__<tool>.
    for (const slug of ['wt', 'approval', 'a__b']) expect((await post({ prompt: 'x', connectors: [slug] })).status).toBe(400);
    expect(text).not.toContain('tok-secreto');
  });

  test('--agent con registry: el skill del agente sale del pin y no del checkout, antes del turno', async () => {
    server.close();
    const pinned = join(tmp, 'skill-pin');
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(pinned, 'SKILL.md'), '# del pin\n');
    let seen = '';
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      seen = readFileSync(join(dir, '.wt', 'skill', 'SKILL.md'), 'utf8');
      writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const scaffold3 = join(tmp, 'scaffold3');
    mkdirSync(join(scaffold3, 'src'), { recursive: true });
    writeFileSync(join(scaffold3, '.gitignore'), 'node_modules\n');
    const registry = async () => ({ pin: 'abcd1234', getItem: async () => { throw new Error('sin items'); }, loadIndex: async () => ({}), makeSchemaStore: () => () => null, skillPack: async () => pinned });
    const t = new Runtime({ root: join(tmp, 'state3'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold3, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing de Acme', messageId: 's1' });
    await events('s1');
    expect(seen).toBe('# del pin\n');
    expect(existsSync(join(tmp, 'state3', 'ws', 's1', '.wt', 'skill@abcd1234'))).toBe(true);
  });

  // gen 999ea0e0: el commit de la versión traía 444 archivos (el DS montado) para 19 de la página.
  test('--agent con registry: el DS montado va en su propio commit y el diff de la versión solo trae lo del agente', async () => {
    server.close();
    const compose: Composer = async (req) => {
      writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const scaffold4 = join(tmp, 'scaffold4');
    mkdirSync(join(scaffold4, 'src'), { recursive: true });
    writeFileSync(join(scaffold4, '.gitignore'), 'node_modules\n');
    const item = { name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: 'export const Button = () => null;\n' }] };
    const registry = async () => ({ pin: 'ef567890', getItem: async () => item, loadIndex: async () => ({ button: {} as never }), makeSchemaStore: () => () => null });
    const t = new Runtime({ root: join(tmp, 'state4'), allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold4, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing de Acme', messageId: 'd1' });
    await events('d1');
    const diff = (await (await fetch(`${base}/runs/d1/diff`)).json()) as { files: { path: string }[] };
    const paths = diff.files.map((f) => f.path);
    expect(paths).toContain('src/App.tsx');
    expect(paths).not.toContain('src/components/arc/button/button.tsx');
  });

  // R6 C2: v0 corre el build dentro del loop; aquí, si el build de materialize falla, el error vuelve al agente por una reanudación.
  const buildResume = async (fixes: boolean) => {
    server.close();
    const calls: ComposeRequest[] = [];
    const compose: Composer = async (req) => {
      calls.push(req);
      const dir = req.workspace?.dir as string;
      writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      if (req.resume && fixes) writeFileSync(join(dir, 'built-ok'), '');
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: req.resume ? 'arreglado' : 'primero', missing: [], suggestions: [], sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5 } } };
    };
    const scaffold = join(tmp, `scaffold-build-${fixes}`);
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const t = new Runtime({ root: join(tmp, `state-build-${fixes}`), allow, compose, agent: true, build: true, buildCommand: ['sh', '-c', 'test -f built-ok || { echo "error TS: boom en 02-hero" >&2; exit 1; }'], imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'b1' });
    return { calls, evs: await events('b1') };
  };

  test('si el build falla, el agente se reanuda una vez con el error y, si lo arregla, la versión sale ok', async () => {
    const { calls, evs } = await buildResume(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ resume: 's1' });
    expect(calls[1]?.prompt).toContain('boom en 02-hero');
    expect(calls[1]?.prompt).toContain('no instrucciones');
    expect(evs.filter((e) => e.type === 'step.end' && e.stepId === 'transport:build').map((e) => (e as { status: string }).status)).toEqual(['error', 'ok']);
    expect(evs.find((e) => e.type === 'step.end' && e.stepId === 'transport:build-resume')).toMatchObject({ status: 'ok' });
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'ok' });
    expect(evs.at(-1)).toMatchObject({ type: 'snapshot' });
  });

  test('si el build sigue fallando tras la reanudación, solo hay una reanudación y la corrida cierra failed', async () => {
    const { calls, evs } = await buildResume(false);
    expect(calls).toHaveLength(2);
    expect(evs.filter((e) => e.type === 'step.end' && e.stepId === 'transport:build').map((e) => (e as { status: string }).status)).toEqual(['error', 'error']);
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'failed' });
  });

  // Arq a fc227ec: la reanudación es un turno entero con gasto; debe poder cortarse igual que el primero.
  const resumeHeld = async (id: string) => {
    server.close();
    let resumeSignal: AbortSignal | undefined;
    let started!: () => void;
    const resumeStarted = new Promise<void>((r) => { started = r; });
    const compose: Composer = async (req) => {
      const dir = req.workspace?.dir as string;
      writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      if (req.resume) {
        resumeSignal = req.signal;
        started();
        await new Promise<void>((r) => req.signal?.addEventListener('abort', () => r(), { once: true }));
        writeFileSync(join(dir, 'src', 'Parcial.tsx'), 'export const P = 1;\n');
        return { sections: [], page: { lang: 'es' }, agent: { files: ['src/Parcial.tsx'], summary: 'cortado', missing: [], suggestions: [], sessionId: 's1', interrupted: true } };
      }
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'primero', missing: [], suggestions: [], sessionId: 's1' } };
    };
    const scaffold = join(tmp, `scaffold-held-${id}`);
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const t = new Runtime({ root: join(tmp, `state-held-${id}`), allow, compose, agent: true, build: true, buildCommand: ['sh', '-c', 'echo "error TS: boom" >&2; exit 1'], imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: id });
    await resumeStarted;
    return { t, signal: () => resumeSignal };
  };

  test('cancel durante la reanudación del build da 202 y cierra stopped, no failed', async () => {
    const { signal } = await resumeHeld('rc1');
    const cancel = await fetch(`${base}/runs/rc1/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(cancel.status).toBe(202);
    const evs = await events('rc1');
    expect(signal()?.aborted).toBe(true);
    expect(evs.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'stopped' });
    // Ya cerrada, el registro se fue: otro cancel es 409.
    expect((await fetch(`${base}/runs/rc1/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } })).status).toBe(409);
  });

  test('shutdown durante la reanudación del build aborta al CLI', async () => {
    const { t, signal } = await resumeHeld('rs1');
    expect(signal()?.aborted).toBe(false);
    await t.shutdown();
    expect(signal()?.aborted).toBe(true);
  });

  // R6 C3: el pin del chat es fijo; "actualizar DS" lo mueve al latest en una corrida tipo restore, sin modelo.
  test('applyBrand pasa la versión a otra marca sin turno: identidad, page.brand y commit nuevos', async () => {
    for (const [id, accent] of [['acme', 'orange'], ['zed', 'blue']] as const) {
      mkdirSync(join(tmp, 'brands', `brand-pack-${id}`), { recursive: true });
      writeFileSync(join(tmp, 'brands', `brand-pack-${id}`, 'brand.json'), JSON.stringify({ name: id, accent }));
    }
    await post({ prompt: 'a', messageId: 'b1', brand: 'acme' });
    await events('b1');
    const ws = join(tmp, 'state', 'ws', 'b1');

    expect((await post({ applyBrand: 'Zed!', parentId: 'b1' })).status).toBe(400);
    expect((await post({ applyBrand: 'acme', parentId: 'b1' })).status).toBe(409);
    expect((await post({ applyBrand: 'nadie', parentId: 'b1' })).status).toBe(404);
    const res = await post({ applyBrand: 'zed', parentId: 'b1', messageId: 'b2' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ messageId: 'b2', from: 'acme', to: 'zed' });
    await events('b2');

    expect(seen).toHaveLength(1);
    expect(readFileSync(join(ws, 'src', 'identity.css'), 'utf8')).toStartWith('/* brand-pack: zed */');
    expect((JSON.parse(readFileSync(join(ws, 'page.json'), 'utf8')) as PageModel).page?.brand).toBe('zed');
    const { versions } = (await (await fetch(`${base}/runs/b2/versions`)).json()) as { versions: { messageId: string; appliedBrand: unknown; head: boolean }[] };
    expect(versions.find((v) => v.messageId === 'b2')).toMatchObject({ appliedBrand: { from: 'acme', to: 'zed' }, head: true });
    expect((await post({ prompt: 'b', messageId: 'b3', parentId: 'b2' })).status).toBe(202);
    await events('b3');
    expect(seen[1].brand?.id).toBe('zed');
  });

  // QA vivo 2026-11-03 (re-sistema/onbrand/vivo/casos/apply-theme-run D1): en core una página no tiene pack; la identidad
  // es la que declaró el agente. Aplicar la fusionaba con una marca vacía y la borraba, aun sin cambios.
  test('applyTheme sobre una página sin pack conserva la identidad del agente y solo suma lo que cambia', async () => {
    const own = ':root,\n[data-theme] { --accent: #8a3b1f; --accent-foreground: #ffffff; --background: #faf6f0; }\n';
    const design = '---\nname: Cafe\n---\n## Brand & Style\n\nCafé de origen.\n';
    let release!: () => void;
    gate = new Promise((r) => { release = r; });
    await post({ prompt: 'landing de café', messageId: 'n1' });
    while (seen.length < 1) await new Promise((r) => setTimeout(r, 5));
    const ws = join(tmp, 'state', 'ws', 'n1');
    writeFileSync(join(ws, 'src', 'identity.css'), own);
    writeFileSync(join(ws, 'DESIGN.md'), design);
    release();
    await events('n1');
    gate = undefined;
    const brandFile = join(ws, 'src', 'brand.ts');
    const brandTs = existsSync(brandFile) ? readFileSync(brandFile, 'utf8') : null;

    // Lo que manda el builder al aplicar sin tocar nada: los valores del contrato.
    expect((await post({ applyTheme: { theme: { colorMode: 'light', roundness: 1, scale: 1 } }, parentId: 'n1', messageId: 'n2' })).status).toBe(202);
    await events('n2');
    expect(readFileSync(join(ws, 'src', 'identity.css'), 'utf8')).toBe(own);
    expect(readFileSync(join(ws, 'DESIGN.md'), 'utf8')).toBe(design);
    expect(existsSync(brandFile) ? readFileSync(brandFile, 'utf8') : null).toBe(brandTs);

    expect((await post({ applyTheme: { theme: { roundness: 1.5 } }, parentId: 'n2', messageId: 'n3' })).status).toBe(202);
    await events('n3');
    const css = readFileSync(join(ws, 'src', 'identity.css'), 'utf8');
    expect(css).toStartWith(own);
    expect(css).toContain('--radius-factor: 1.5');
    expect(css).not.toContain('--accent: oklch');
    expect(readFileSync(join(ws, 'DESIGN.md'), 'utf8')).toBe(design);
  });

  test('applyTheme deja la marca de la versión con el tema del panel: identidad nueva, misma marca, y el follow-up la conserva', async () => {
    mkdirSync(join(tmp, 'brands', 'brand-pack-tema'), { recursive: true });
    writeFileSync(join(tmp, 'brands', 'brand-pack-tema', 'brand.json'), JSON.stringify({ name: 'tema', accent: 'orange' }));
    // El frontmatter copia el brand.json y se valida contra él: el tema nuevo lo invalidaría si no se reescribe.
    writeFileSync(join(tmp, 'brands', 'brand-pack-tema', 'DESIGN.md'), `${packDesignFrontmatter(parseBrandPack({ name: 'tema', accent: 'orange' }))}## Brand & Style\n\nProsa de la marca.\n\n## Colors\n\nNaranja.\n\n## Typography\n\nGeist.\n`);
    await post({ prompt: 'a', messageId: 't1', brand: 'tema' });
    await events('t1');
    const ws = join(tmp, 'state', 'ws', 't1');

    expect((await post({ applyTheme: { theme: { preset: 'violet' } } })).status).toBe(400);
    expect((await post({ applyTheme: { name: 'otra' }, parentId: 't1' })).status).toBe(422);
    const illegible = { overrides: { '--accent': '#ffeb3b', '--accent-strong': '#c8b900', '--accent-subtle': 'rgb(255 235 59 / .15)', '--accent-foreground': '#ffffff' } };
    const refused = await post({ applyTheme: illegible, parentId: 't1' });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('--accent-foreground sobre --accent');

    const theme = { theme: { preset: 'violet', roundness: 1.5 }, overrides: { '--background': '#fbfaf7' }, overridesDark: { '--background': '#12130f' } };
    expect((await post({ applyTheme: theme, parentId: 't1', messageId: 't2' })).status).toBe(202);
    await events('t2');
    const css = readFileSync(join(ws, 'src', 'identity.css'), 'utf8');
    expect(css).toStartWith('/* brand-pack: tema */');
    expect(css).toContain('--radius-factor: 1.5');
    expect(css).toContain('--background: #fbfaf7');
    const design = readFileSync(join(ws, 'DESIGN.md'), 'utf8');
    expect(design).toContain("background: '#fbfaf7'");
    expect(design).toContain('Prosa de la marca.');
    expect((JSON.parse(readFileSync(join(ws, 'page.json'), 'utf8')) as PageModel).page?.brand).toBe('tema');
    const { versions } = (await (await fetch(`${base}/runs/t2/versions`)).json()) as { versions: { messageId: string; appliedTheme: unknown; head: boolean }[] };
    expect(versions.find((v) => v.messageId === 't2')).toMatchObject({ appliedTheme: theme, head: true });

    await post({ prompt: 'b', messageId: 't3', parentId: 't2' });
    await events('t3');
    expect(readFileSync(join(ws, 'src', 'identity.css'), 'utf8')).toBe(css);
  });

  test('applyBrand: si la marca no se puede aplicar, cierra con error, sin commit y el árbol vuelve al padre', async () => {
    for (const [id, extra] of [['acme', {}], ['rota', { logo: 'logo.svg' }]] as const) {
      mkdirSync(join(tmp, 'brands', `brand-pack-${id}`), { recursive: true });
      writeFileSync(join(tmp, 'brands', `brand-pack-${id}`, 'brand.json'), JSON.stringify({ name: id, accent: 'orange', ...extra }));
    }
    await post({ prompt: 'a', messageId: 'r1', brand: 'acme' });
    await events('r1');
    const ws = join(tmp, 'state', 'ws', 'r1');
    const css = readFileSync(join(ws, 'src', 'identity.css'), 'utf8');
    const head = headSha(ws);
    expect((await post({ applyBrand: 'rota', parentId: 'r1', messageId: 'r2' })).status).toBe(202);
    expect(JSON.stringify(await events('r2'))).toContain('declara logo');
    expect(headSha(ws)).toBe(head);
    expect(isClean(ws)).toBe(true);
    expect(readFileSync(join(ws, 'src', 'identity.css'), 'utf8')).toBe(css);
    expect((JSON.parse(readFileSync(join(ws, 'page.json'), 'utf8')) as PageModel).page?.brand).toBe('acme');
  });

  test('updateDs monta el DS del latest en su commit, deja el pin nuevo para los follow-ups y no se repite con el mismo pin', async () => {
    server.close();
    const compose: Composer = async (req) => {
      writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const scaffold = join(tmp, 'scaffold-ds');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    let latest = 'aaaa1111';
    const opened: (string | undefined)[] = [];
    const registry = async (pin?: string) => {
      opened.push(pin);
      const at = pin ?? latest;
      return { pin: at, getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: `export const Button = () => '${at}';\n` }] }), loadIndex: async () => ({ button: {} as never }), makeSchemaStore: () => () => null };
    };
    const root = join(tmp, 'state-ds');
    const t = new Runtime({ root, allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'u1' });
    await events('u1');
    const button = join(root, 'ws', 'u1', 'src', 'components', 'arc', 'button', 'button.tsx');
    expect(readFileSync(button, 'utf8')).toContain('aaaa1111');
    // Mismo pin: nada que actualizar.
    expect((await post({ updateDs: true, parentId: 'u1' })).status).toBe(409);
    latest = 'bbbb2222';
    const res = await post({ updateDs: true, parentId: 'u1', messageId: 'u2' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ messageId: 'u2', from: 'aaaa1111', to: 'bbbb2222' });
    const evs = await events('u2');
    expect(evs.at(-2)).toMatchObject({ type: 'message.end', finishReason: 'restore' });
    expect(evs.at(-1)).toMatchObject({ type: 'snapshot' });
    expect(readFileSync(button, 'utf8')).toContain('bbbb2222');
    const versions = (await (await fetch(`${base}/runs/u1/versions`)).json()) as { versions: { messageId: string; updatedDs: unknown }[] };
    expect(versions.versions.find((v) => v.messageId === 'u2')?.updatedDs).toEqual({ from: 'aaaa1111', to: 'bbbb2222' });
    // El follow-up siguiente hereda el pin nuevo, no el viejo.
    opened.length = 0;
    await post({ prompt: 'cambia el título', messageId: 'u3', parentId: 'u2' });
    await events('u3');
    expect(opened).toEqual(['bbbb2222']);
    // Ya en el latest: repetir es 409.
    expect((await post({ updateDs: true, parentId: 'u3' })).status).toBe(409);
  });

  // R6 C3 + nits de Arq: un DS nuevo que rompe el build, o un registry que falla, deja el pin y el árbol como estaban.
  test('updateDs: si el build con el DS nuevo falla, o el registry falla, cierra failed sin commit y el chat sigue en su pin', async () => {
    server.close();
    const compose: Composer = async (req) => {
      writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const scaffold = join(tmp, 'scaffold-ds-fail');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    let latest = 'aaaa1111';
    const registry = async (pin?: string) => {
      const at = pin ?? latest;
      return { pin: at, getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: `export const Button = () => '${at}';\n` }] }), loadIndex: async () => { if (at === 'dddd4444') throw new Error('índice caído'); return { button: {} as never }; }, makeSchemaStore: () => () => null };
    };
    const root = join(tmp, 'state-ds-fail');
    const t = new Runtime({ root, allow, compose, agent: true, build: true, buildCommand: ['sh', '-c', '! grep -q bbbb2222 src/components/arc/button/button.tsx'], imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'f1' });
    await events('f1');
    const dir = join(root, 'ws', 'f1');
    const head = () => Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
    const before = head();
    const button = join(dir, 'src', 'components', 'arc', 'button', 'button.tsx');
    const attempt = async (id: string) => {
      expect((await post({ updateDs: true, parentId: 'f1', messageId: id })).status).toBe(202);
      return events(id);
    };
    // Build roto con el DS nuevo: failed, sin commit, HEAD y árbol como estaban.
    latest = 'bbbb2222';
    const broken = await attempt('f2');
    expect(broken.find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'failed' });
    expect(head()).toBe(before);
    expect(readFileSync(button, 'utf8')).toContain('aaaa1111');
    expect(Bun.spawnSync(['git', '-C', dir, 'status', '--porcelain']).stdout.toString().trim()).toBe('');
    // Reintento con el mismo pin: vuelve a montar y vuelve a fallar (si el marcador sobreviviera, se saltaría el montaje y "pasaría").
    expect((await attempt('f3')).find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'failed' });
    // Registry que falla al montar: igual de limpio.
    latest = 'dddd4444';
    expect((await attempt('f4')).find((e) => e.type === 'message.end')).toMatchObject({ outcome: 'failed' });
    expect(head()).toBe(before);
    const versions = (await (await fetch(`${base}/runs/f1/versions`)).json()) as { versions: { messageId: string; head: boolean }[] };
    expect(versions.versions.map((v) => v.messageId)).toEqual(['f1']);
    // Un id repetido tras el await del registry es 409.
    expect((await post({ updateDs: true, parentId: 'f1', messageId: 'f1' })).status).toBe(409);
  });

  // Arq a fc227ec: el rewind del catch no puede tirar una versión que ya tiene commit en el índice.
  test('updateDs: un fallo posterior al commit conserva la versión y no hace rewind', async () => {
    server.close();
    const compose: Composer = async (req) => {
      writeFileSync(join(req.workspace?.dir as string, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es', title: 'Acme' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const scaffold = join(tmp, 'scaffold-ds-late');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    let latest = 'aaaa1111';
    const registry = async (pin?: string) => {
      const at = pin ?? latest;
      return { pin: at, getItem: async () => ({ name: 'button', files: [{ path: 'src/components/arc/button/button.tsx', content: `export const Button = () => '${at}';\n` }] }), loadIndex: async () => ({ button: {} as never }), makeSchemaStore: () => () => null };
    };
    const root = join(tmp, 'state-ds-late');
    const t = new Runtime({ root, allow, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), registry });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await post({ prompt: 'landing', messageId: 'l1' });
    await events('l1');
    // Primer cierre 'restore' (el del updateDs, ya con commit guardado) falla una vez.
    const real = (t as unknown as { end: (...a: unknown[]) => void }).end.bind(t);
    let thrown = false;
    (t as unknown as { end: (...a: unknown[]) => void }).end = (...a) => {
      if (a[2] === 'restore' && !thrown) { thrown = true; throw new Error('cierre caído'); }
      return real(...a);
    };
    latest = 'bbbb2222';
    expect((await post({ updateDs: true, parentId: 'l1', messageId: 'l2' })).status).toBe(202);
    await events('l2');
    const dir = join(root, 'ws', 'l1');
    expect(readFileSync(join(dir, 'src', 'components', 'arc', 'button', 'button.tsx'), 'utf8')).toContain('bbbb2222');
    const subject = Bun.spawnSync(['git', '-C', dir, 'log', '-1', '--format=%s']).stdout.toString();
    expect(subject).toContain('Actualizar DS');
  });

  // Imagen del rail como nodo libre (canvas-store.ts): subir, guardar el documento y servir solo lo del lienzo del chat.
  test('/chats/:chatId/canvas: sube por bytes, guarda con rev, sirve el archivo y rechaza lo grande antes de leerlo', async () => {
    await post({ prompt: 'landing', messageId: 'c1' });
    await events('c1');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
    const up = await fetch(`${base}/chats/c1/canvas/files?name=Foto.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
    expect(up.status).toBe(201);
    const { src } = (await up.json()) as { src: string };
    const file = await fetch(`${base}${src}`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    const doc = { rev: 0, nodes: [{ id: '0b6f8a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', kind: 'image', src, name: 'Foto.png', x: 0, y: 0, width: 512, height: 320 }] };
    expect((await fetch(`${base}/chats/c1/canvas`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })).status).toBe(200);
    expect(((await (await fetch(`${base}/chats/c1/canvas`)).json()) as { rev: number }).rev).toBe(1);
    const stale = await fetch(`${base}/chats/c1/canvas`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { current: { rev: number } }).current.rev).toBe(1);
    // content-length de 21 MB y solo unos bytes enviados: el server responde 413 sin esperar el resto del cuerpo.
    // Por socket crudo: el cliente HTTP de Bun no entrega la respuesta hasta terminar de mandar el cuerpo.
    const { connect } = await import('node:net');
    const { port } = new URL(base);
    const bigStatus = await new Promise<number>((resolve, reject) => {
      const sock = connect(Number(port), '127.0.0.1', () => sock.write(`POST /chats/c1/canvas/files?name=x.png HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: image/png\r\nContent-Length: ${21 * 1024 * 1024}\r\n\r\n`));
      sock.once('data', (d) => { resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(d.toString())?.[1] ?? 0)); sock.destroy(); });
      sock.on('error', reject);
    });
    expect(bigStatus).toBe(413);
    expect((await fetch(`${base}/chats/nada/canvas`)).status).toBe(404);
    expect((await fetch(`${base}/chats/c1/canvas/files/%E0%A4%A`)).status).toBe(404);
  });

  test('GET /runs/:id/shots/:file sirve la captura del workspace del hilo y nada fuera de .wt/shots', async () => {
    await post({ prompt: 'landing', messageId: 's1' });
    await events('s1');
    const shots = join(tmp, 'state', 'ws', 's1', '.wt', 'shots');
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, 'toolu_1-0.png'), 'png');
    const r = await fetch(`${base}/runs/s1/shots/toolu_1-0.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(await r.text()).toBe('png');
    expect((await fetch(`${base}/runs/s1/shots/toolu_2-0.png`)).status).toBe(404);
    expect((await fetch(`${base}/runs/s1/shots/${encodeURIComponent('../page.json')}`)).status).toBe(400);
  });

  // Revisión de Front a #280: con Bash en el workspace el agente podría enlazar una captura a un archivo de fuera.
  test('una captura que es symlink, o un .wt/shots que apunta fuera, no se sirve', async () => {
    await post({ prompt: 'landing', messageId: 's2' });
    await events('s2');
    const secret = join(tmp, 'secret.txt');
    writeFileSync(secret, 'id_rsa');
    const wt = join(tmp, 'state', 'ws', 's2', '.wt');
    mkdirSync(join(wt, 'shots'), { recursive: true });
    symlinkSync(secret, join(wt, 'shots', 'x-0.png'));
    expect((await fetch(`${base}/runs/s2/shots/x-0.png`)).status).toBe(404);
    rmSync(join(wt, 'shots'), { recursive: true });
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'y-0.png'), 'fuera');
    symlinkSync(outside, join(wt, 'shots'));
    expect((await fetch(`${base}/runs/s2/shots/y-0.png`)).status).toBe(404);
  });
});

// Review S1: existsSync sigue el enlace, así que un symlink colgante pasaba el chequeo y writeFileSync creaba su destino afuera.
test('un symlink colgante o una carpeta enlazada fuera del workspace no se escribe', () => {
  const root = mkdtempSync(join(tmpdir(), 'v0-escape-'));
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'src', 'sections'), { recursive: true });
  symlinkSync(join(root, 'no-existe'), join(ws, 'src', 'sections', '02-hero.module.css'));
  symlinkSync(root, join(ws, 'src', 'out'));
  expect(escapesWorkspace(ws, 'src/sections/02-hero.module.css')).toBe(true);
  expect(escapesWorkspace(ws, 'src/out/x.tsx')).toBe(true);
  expect(escapesWorkspace(ws, 'src/sections/03-a.tsx')).toBe(false);
  expect(escapesWorkspace(ws, 'page-plan.md')).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
