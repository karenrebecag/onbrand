// buildExportDist (P3): el paquete exportado (H9) se construye sin puentes, sobre el árbol del ws, y solo si ese árbol es la
// versión. Vite real del scaffold sobre un ws mínimo con git, como tests/wt-bridges.test.ts. Sin LLM ni reloj.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HttpError } from '../src/runtime/http';
import { buildExportDist } from '../src/runtime/preview-dist';

const SCAFFOLD = resolve(import.meta.dir, '..', 'templates', 'base-scaffold');
const hasVite = existsSync(join(SCAFFOLD, 'node_modules', '.bin', 'vite'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (ws: string, ...args: string[]): string => execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();

/** Un ws commiteado cuyo main.tsx instala un puente propio, como los de antes de #641. */
function workspace(): { ws: string; commit: string } {
  const ws = mkdtempSync(join(tmpdir(), 'wt-export-ws-'));
  dirs.push(ws);
  mkdirSync(join(ws, 'src'));
  symlinkSync(join(SCAFFOLD, 'node_modules'), join(ws, 'node_modules'));
  writeFileSync(join(ws, '.gitignore'), 'node_modules\n.wt\ndist\n');
  writeFileSync(join(ws, 'package.json'), '{"name":"ws","private":true,"type":"module"}\n');
  writeFileSync(join(ws, 'vite.config.ts'), 'export default {}\n');
  writeFileSync(join(ws, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
  writeFileSync(join(ws, 'src', 'wt-select-bridge.ts'), "export function installSelectBridge() { (window as any).oldBridge = 'VIEJO-SIN-RECT' }\n");
  writeFileSync(join(ws, 'src', 'main.tsx'), "import { installSelectBridge } from './wt-select-bridge'\ninstallSelectBridge()\ndocument.title = 'pagina-v1'\n");
  git(ws, 'init', '-q');
  git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v1');
  return { ws, commit: git(ws, 'rev-parse', 'HEAD') };
}

const siteText = (dir: string): string => ['index.html', ...readdirSync(join(dir, 'assets')).map((f) => join('assets', f))].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

test.skipIf(!hasVite)('con el ws en el commit: .wt/export/<commit> con la página y sin puentes', async () => {
  const { ws, commit } = workspace();
  const dir = await buildExportDist(ws, commit);
  expect(dir).toBe(join(ws, '.wt', 'export', commit));
  const out = siteText(dir);
  expect(out).toContain('pagina-v1');
  expect(out).not.toContain('/@wt-bridges');
  expect(out).not.toContain('wt:select-rect');
  expect(out).not.toContain('VIEJO-SIN-RECT');
  // El build a medias no queda junto al resultado.
  expect(readdirSync(join(ws, '.wt', 'export'))).toEqual([commit]);
}, 60_000);

test('HEAD en otro commit o árbol con cambios: 409 not-at-commit sin construir', async () => {
  const { ws, commit } = workspace();
  writeFileSync(join(ws, 'src', 'main.tsx'), "document.title = 'sin-commitear'\n");
  const dirty = await buildExportDist(ws, commit).catch((e: unknown) => e);
  expect(dirty).toBeInstanceOf(HttpError);
  expect((dirty as HttpError).status).toBe(409);
  expect((dirty as HttpError).details).toEqual({ code: 'not-at-commit' });
  git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'v2');
  const moved = await buildExportDist(ws, commit).catch((e: unknown) => e);
  expect((moved as HttpError).details).toEqual({ code: 'not-at-commit' });
  expect(existsSync(join(ws, '.wt', 'export'))).toBe(false);
});

test('.wt/export como symlink: no construye', async () => {
  const { ws, commit } = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'wt-export-out-'));
  dirs.push(outside);
  mkdirSync(join(ws, '.wt'));
  symlinkSync(outside, join(ws, '.wt', 'export'));
  await expect(buildExportDist(ws, commit)).rejects.toThrow('.wt o .wt/export es un symlink');
  expect(readdirSync(outside)).toEqual([]);
});

// Arq sobre #688 (A6): vite lee el árbol durante el build; un turno que mueve HEAD (o deja archivos a medias) en ese lapso
// no puede dejar su resultado como el paquete de la versión, porque la caché lo serviría para siempre.
test('si HEAD se mueve o el árbol se ensucia durante el build: 409 not-at-commit y no queda dest', async () => {
  for (const change of ['commit', 'dirty'] as const) {
    const { ws, commit } = workspace();
    const fakeBuild = async (_cmd: string, args: readonly string[]) => {
      const out = args[args.indexOf('--outDir') + 1] as string;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'index.html'), 'a medias');
      writeFileSync(join(ws, 'src', 'main.tsx'), "document.title = 'turno'\n");
      if (change === 'commit') git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'turno');
      return { code: 0, stderr: '', timedOut: false, aborted: false };
    };
    const err = await buildExportDist(ws, commit, undefined, fakeBuild).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).details).toEqual({ code: 'not-at-commit' });
    expect(readdirSync(join(ws, '.wt', 'export'))).toEqual([]);
  }
});
