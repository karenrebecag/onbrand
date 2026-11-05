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

describe('export de una versión (H9)', () => {
  test('source: el zip trae lo commiteado bajo <slug>/, sin .wt, y el nombre va en kebab ASCII', async () => {
    await post({ prompt: 'Landing de Panadería Ñandú', messageId: 'm1' });
    const snap = (await events('m1')).at(-1) as Extract<EngineEvent, { type: 'snapshot' }>;
    const r = await fetch(`${base}/runs/m1/export?format=source`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="landing-de-panaderia-nandu-${(snap.commit as string).slice(0, 7)}-codigo.zip"`);
    const names = unzip(await r.arrayBuffer(), '-Z1').trim().split('\n');
    expect(names).toContain('landing-de-panaderia-nandu/src/App.tsx');
    expect(names).toContain('landing-de-panaderia-nandu/page.json');
    expect(names.some((n) => n.includes('/.wt/'))).toBe(false);
  });

  test('site: 409 not-at-commit con el árbol sucio; con el paquete de export, zip con sus archivos sin .base ni symlinks', async () => {
    await post({ prompt: 'landing', messageId: 'm1' });
    const commit = ((await events('m1')).at(-1) as Extract<EngineEvent, { type: 'snapshot' }>).commit as string;
    const ws = join(tmp, 'state', 'ws', 'm1');
    // P3: site/page salen de .wt/export/<commit> (buildExportDist), no del dist del preview; sembrado = caché, sin vite.
    writeFileSync(join(ws, 'sucio.txt'), 'x');
    const dirty = await fetch(`${base}/runs/m1/export?format=site`);
    expect(dirty.status).toBe(409);
    expect(((await dirty.json()) as { code?: string }).code).toBe('not-at-commit');
    expect(((await (await fetch(`${base}/runs/m1/export`)).json()) as { formats: Record<string, boolean> }).formats.site).toBe(false);
    rmSync(join(ws, 'sucio.txt'));
    const dist = join(ws, '.wt', 'export', commit);
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<h1>hola</h1>');
    writeFileSync(join(dist, 'assets', 'a.js'), 'x()');
    writeFileSync(join(dist, '.base'), '/');
    symlinkSync('/etc/hosts', join(dist, 'leak'));
    const avail = (await (await fetch(`${base}/runs/m1/export`)).json()) as { formats: Record<string, boolean> };
    expect(avail.formats).toEqual({ source: true, site: true, page: true, 'design-md': false, brief: false });
    const r = await fetch(`${base}/runs/m1/export?format=site`);
    expect(r.status).toBe(200);
    const zip = await r.arrayBuffer();
    expect(unzip(zip, '-Z1').trim().split('\n').sort()).toEqual(['landing/assets/a.js', 'landing/index.html']);
    expect(unzip(zip, '-p')).toContain('<h1>hola</h1>');
    expect(execFileSync('unzip', ['-tq', join(tmp, readdirSync(tmp).filter((f) => f.endsWith('.zip')).at(-1) as string)], { encoding: 'utf8' })).toContain('No errors');
  });

  test('site: omite nombres con \ o : (zip-slip en Windows) y da 413 por tamaño sin leer el archivo', async () => {
    await post({ prompt: 'landing', messageId: 'm1' });
    const commit = ((await events('m1')).at(-1) as Extract<EngineEvent, { type: 'snapshot' }>).commit as string;
    const dist = join(tmp, 'state', 'ws', 'm1', '.wt', 'export', commit);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), 'ok');
    writeFileSync(join(dist, '..\\..\\evil.bat'), 'x');
    writeFileSync(join(dist, 'C:x'), 'x');
    writeFileSync(join(dist, '.base'), '/');
    const r = await fetch(`${base}/runs/m1/export?format=site`);
    expect(unzip(await r.arrayBuffer(), '-Z1').trim().split('\n')).toEqual(['landing/index.html']);
    execFileSync('truncate', ['-s', '60M', join(dist, 'big.bin')]);
    expect((await fetch(`${base}/runs/m1/export?format=site`)).status).toBe(413);
  });

  test('source: una versión con un symlink commiteado no se exporta', () => {
    const ws = join(tmp, 'repo');
    mkdirSync(ws);
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: ws, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(ws, 'a.txt'), 'a');
    symlinkSync('../../..', join(ws, 'up'));
    g('add', '-A');
    g('commit', '-qm', 'x');
    expect(() => sourceZip(ws, g('rev-parse', 'HEAD').trim(), 'p')).toThrow(ExportRefused);
  });

  test('source (P1): el zip excluye request.json e instructions.json pero conserva la página', () => {
    const ws = join(tmp, 'repo-p1');
    mkdirSync(join(ws, 'src'), { recursive: true });
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: ws, encoding: 'utf8' });
    g('init', '-q');
    for (const [rel, body] of [['src/App.tsx', 'x'], ['request.json', '{}'], ['instructions.json', '{}']] as const) writeFileSync(join(ws, rel), body);
    g('add', '-A');
    g('commit', '-qm', 'x');
    const f = join(tmp, 'p1.zip');
    writeFileSync(f, sourceZip(ws, g('rev-parse', 'HEAD').trim(), 'p'));
    const names = execFileSync('unzip', ['-Z1', f], { encoding: 'utf8' }).trim().split('\n');
    expect(names).toContain('p/src/App.tsx');
    expect(names).not.toContain('p/request.json');
    expect(names).not.toContain('p/instructions.json');
  });

  test('MCP lectura (H9, P2): GET /tree lista el commit sin P1 ni .wt; GET /file da texto, 404 ruta ausente/excluida, 400 sin path', async () => {
    await post({ prompt: 'landing', messageId: 'm1' });
    await events('m1');
    const tree = (await (await fetch(`${base}/runs/m1/tree`)).json()) as { commit: string; files: { path: string; size: number }[] };
    const paths = tree.files.map((f) => f.path);
    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('page.json');
    expect(paths).not.toContain('request.json');
    expect(paths).not.toContain('instructions.json');
    expect(paths.some((p) => p.includes('.wt/'))).toBe(false);
    expect(tree.files.find((f) => f.path === 'page.json')!.size).toBeGreaterThan(0);
    const file = (await (await fetch(`${base}/runs/m1/file?path=page.json`)).json()) as { path: string; content: string };
    expect(file.content.length).toBeGreaterThan(0);
    expect((await fetch(`${base}/runs/m1/file?path=request.json`)).status).toBe(404);
    expect((await fetch(`${base}/runs/m1/file?path=nope.txt`)).status).toBe(404);
    expect((await fetch(`${base}/runs/m1/file`)).status).toBe(400);
  });

  test('MCP lectura (H9): tree/file rechazan symlinks y binarios por el árbol git, no por el disco', () => {
    const ws = join(tmp, 'repo-tree');
    mkdirSync(ws);
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: ws, encoding: 'utf8' });
    g('init', '-q');
    writeFileSync(join(ws, 'a.txt'), 'hola');
    writeFileSync(join(ws, 'bin'), Buffer.from([0x50, 0x00, 0x4b]));
    symlinkSync('/etc/hosts', join(ws, 'leak'));
    g('add', '-A');
    g('commit', '-qm', 'x');
    const sha = g('rev-parse', 'HEAD').trim();
    const entries = treeEntries(ws, sha);
    expect(entries.find((e) => e.path === 'leak')!.mode).toBe('120000'); // base del 422 symlink
    expect(entries.find((e) => e.path === 'a.txt')!.size).toBe(4);
    expect(showFileBytes(ws, sha, 'bin').includes(0)).toBe(true); // base del 422 binario
    expect(showFileBytes(ws, sha, 'a.txt').toString('utf8')).toBe('hola');
  });

  test('design-md/brief: 404 si la versión no los tiene; formato desconocido 400; mensaje sin versión 409', async () => {
    gate = new Promise(() => {});
    await post({ prompt: 'landing', messageId: 'm1' });
    expect((await fetch(`${base}/runs/m1/export?format=source`)).status).toBe(409);
    gate = undefined;
    await post({ prompt: 'otra', messageId: 'm2' });
    await events('m2');
    expect((await fetch(`${base}/runs/m2/export?format=design-md`)).status).toBe(404);
    expect((await fetch(`${base}/runs/m2/export?format=brief`)).status).toBe(404);
    expect((await fetch(`${base}/runs/m2/export?format=figma`)).status).toBe(400);
  });
});

describe('publicable (H1): el gate sin publicar', () => {
  // Deja el paquete de export de la versión de m1 (P3: se publica lo que se exporta); sembrado = caché, sin vite.
  const putDist = async (extra: Record<string, string> = {}): Promise<void> => {
    await post({ prompt: 'landing', messageId: 'm1' });
    const commit = ((await events('m1')).at(-1) as Extract<EngineEvent, { type: 'snapshot' }>).commit as string;
    const dist = join(tmp, 'state', 'ws', 'm1', '.wt', 'export', commit);
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<h1>hola</h1>');
    for (const [rel, body] of Object.entries(extra)) writeFileSync(join(dist, rel), body);
  };

  // El transport de prueba no tiene provider de publish (POST /publish daría 501); el veredicto no depende de él.
  test('dist limpio: 200 ok:true con files/bytes, sin provider configurado', async () => {
    await putDist();
    const r = await fetch(`${base}/runs/m1/publishable`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, externalOrigins: [], files: 1, bytes: 13 });
  });

  test('dist con sourcemap: 200 ok:false con los errors (el veredicto es el dato, no un 409)', async () => {
    await putDist({ 'app.js.map': '{}' });
    const r = await fetch(`${base}/runs/m1/publishable`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; errors: { code: string }[]; files: number };
    expect(body.ok).toBe(false);
    expect(body.errors.some((e) => e.code === 'forbidden-file')).toBe(true);
    expect(body.files).toBe(2);
  });

  test('sin paquete y sin vite instalado: 409 no-build; con el árbol sucio: 409 not-at-commit', async () => {
    await post({ prompt: 'sin build', messageId: 'm1' });
    await events('m1');
    const r = await fetch(`${base}/runs/m1/publishable`);
    expect(r.status).toBe(409);
    expect((await r.json() as { code: string }).code).toBe('no-build');
    writeFileSync(join(tmp, 'state', 'ws', 'm1', 'sucio.txt'), 'x');
    const dirty = await fetch(`${base}/runs/m1/publishable`);
    expect(dirty.status).toBe(409);
    expect((await dirty.json() as { code: string }).code).toBe('not-at-commit');
  });

  test('mensaje sin versión: 409; mensaje inexistente: 404', async () => {
    gate = new Promise(() => {});
    await post({ prompt: 'landing', messageId: 'm1' });
    expect((await fetch(`${base}/runs/m1/publishable`)).status).toBe(409);
    expect((await fetch(`${base}/runs/nope/publishable`)).status).toBe(404);
  });
});
