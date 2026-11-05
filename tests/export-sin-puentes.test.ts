// QA H9 en vivo (8d9568f7), hallazgo: GET /runs/:id/export?format=site|page empaqueta el dist de la VERSIÓN
// (servableDist, run-reads.ts:299/304), que el preview construye con los puentes. buildExportDist (#657,
// preview-dist.ts:207) construye el paquete sin puentes (P3) pero nada lo llama. En el chat real clonado, "Copiar
// página" trajo wt:page-size, wt:select-mode, wt:edit-text… Aquí el snapshot de la versión lleva el marcador de un
// puente, como el que deja el build de versión, y el export no puede traerlo.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Runtime } from '../src/runtime/server';

const SCAFFOLD = resolve(import.meta.dir, '..', 'templates', 'base-scaffold');
const hasVite = existsSync(join(SCAFFOLD, 'node_modules', '.bin', 'vite'));
const BRIDGE = 'wt:page-size';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (ws: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: ws, encoding: 'utf8' }).trim();

/** Estado de runtime con un chat de una versión: ws commiteado y el snapshot de su build de versión con un puente. */
function state(): { root: string; id: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-export-puentes-'));
  dirs.push(root);
  const id = 'chat-1';
  const ws = join(root, 'ws', id);
  mkdirSync(join(ws, 'src'), { recursive: true });
  symlinkSync(join(SCAFFOLD, 'node_modules'), join(ws, 'node_modules'));
  writeFileSync(join(ws, '.gitignore'), 'node_modules\n.wt\ndist\n');
  writeFileSync(join(ws, 'package.json'), '{"name":"ws","private":true,"type":"module"}\n');
  writeFileSync(join(ws, 'vite.config.ts'), 'export default {}\n');
  writeFileSync(join(ws, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
  writeFileSync(join(ws, 'src', 'main.tsx'), "document.title = 'pagina-v1'\n");
  git(ws, 'init', '-q');
  git(ws, 'add', '.');
  git(ws, 'commit', '-qm', 'v1');
  const commit = git(ws, 'rev-parse', 'HEAD');
  const snap = join(ws, '.wt', 'dist', commit);
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, 'index.html'), `<!doctype html><html><head><script>parent.postMessage({type:'${BRIDGE}'},'*');document.title='pagina-v1'</script></head><body></body></html>`);
  writeFileSync(join(snap, '.base'), '/');
  writeFileSync(join(root, 'index.json'), JSON.stringify({ [id]: { ws: id, title: 'Página uno', prompt: 'p', at: 1, commit, outcome: 'ok' } }));
  return { root, id };
}

test.skipIf(!hasVite)('export page y site: la página de la versión sin los puentes del preview (P3)', async () => {
  const { root, id } = state();
  const scaffold = join(root, 'scaffold');
  mkdirSync(scaffold);
  const s = new Runtime({ root, allow: {}, compose: async () => ({ sections: [] }), build: false, scaffoldDir: scaffold, vaultRoot: join(root, 'vault') }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const at = `http://127.0.0.1:${(s.address() as { port: number }).port}/runs/${id}/export`;
  try {
    const page = await fetch(`${at}?format=page`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('pagina-v1');
    expect(html).not.toContain(BRIDGE);
    const site = await fetch(`${at}?format=site`);
    expect(site.status).toBe(200);
    expect(Buffer.from(await site.arrayBuffer()).includes(BRIDGE)).toBe(false);
  } finally {
    s.close();
  }
}, 60_000);

test('dos exports seguidos de la misma versión comparten un solo build', async () => {
  const { RunReads } = await import('../src/runtime/run-reads');
  let builds = 0;
  let release: (dir: string) => void = () => {};
  const reads = new RunReads({
    index: () => ({ m: { ws: 'm', commit: 'c1', title: 't', prompt: 'p', at: 1 } }) as never,
    entry: (id: string) => ({ ws: 'm', commit: 'c1', title: 't', prompt: 'p', at: 1, id }) as never,
    wsDir: () => '/ws/m', logDir: '/nada', isFinished: () => true, brandOf: () => undefined, stableUrl: () => '', servableDist: () => undefined,
    exportDist: () => { builds += 1; return new Promise<string>((r) => { release = r; }); },
    atCommit: () => true, opts: {},
  } as never);
  const sink = (): import('node:http').ServerResponse => ({ writeHead: () => {}, end: () => {} }) as never;
  const a = reads.exportVersion(sink(), 'm', 'page').catch(() => {});
  const b = reads.exportVersion(sink(), 'm', 'site').catch(() => {});
  await Promise.resolve();
  expect(builds).toBe(1);
  release('/no-existe');
  await Promise.all([a, b]);
});

test('un build de export que falla es 409 no-build para el cliente, sin el stderr', async () => {
  const { RunReads } = await import('../src/runtime/run-reads');
  const { HttpError } = await import('../src/runtime/http');
  const reads = new RunReads({
    index: () => ({}) as never,
    entry: () => ({ ws: 'm', commit: 'c1', title: 't', prompt: 'p', at: 1 }) as never,
    wsDir: () => '/ws/m', logDir: '/nada', isFinished: () => true, brandOf: () => undefined, stableUrl: () => '', servableDist: () => undefined,
    exportDist: async () => { throw new Error('vite: SECRETO en el stderr'); },
    atCommit: () => true, opts: {},
  } as never);
  const err = await reads.publishable('m').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as InstanceType<typeof HttpError>).status).toBe(409);
  expect((err as InstanceType<typeof HttpError>).details).toEqual({ code: 'no-build' });
  expect((err as Error).message).not.toContain('SECRETO');
});
