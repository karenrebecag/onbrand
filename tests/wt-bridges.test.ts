// Puentes del preview fuera del workspace (hallazgo Q3 de QA): el vite del ws corre con el config del transport, que
// inyecta los puentes del scaffold actual y deja sin efecto los que instala un main.tsx viejo. Sin LLM ni reloj; la parte
// de vite real usa el vite del scaffold (como preview-wt-source.test.ts) sobre un ws mínimo.
import { afterAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BRIDGES_ENTRY_URL, PUBLISH_MODE, wtBridgesPlugin } from '../src/runtime/wt-bridges-plugin';
import { PREVIEW_VITE_CONFIG } from '../src/runtime/shared';

const SCAFFOLD_SRC = resolve(import.meta.dir, '..', 'templates', 'base-scaffold', 'src');
const WS = '/ws/abc';

test('el plugin inyecta los puentes antes de la página, los imports de main.tsx van a un stub y los demás al scaffold', () => {
  const p = wtBridgesPlugin(WS, SCAFFOLD_SRC);
  expect(p.transformIndexHtml.order).toBe('pre');
  expect(p.transformIndexHtml.handler()).toEqual([{ tag: 'script', attrs: { type: 'module', src: BRIDGES_ENTRY_URL }, injectTo: 'head-prepend' }]);
  expect(p.resolveId(BRIDGES_ENTRY_URL)).toBe(join(SCAFFOLD_SRC, 'wt-bridges.ts'));
  expect(p.resolveId('./wt-select-bridge', `${WS}/src/main.tsx`)).toBe('\0wt-bridge-stub:wt-select-bridge');
  expect(p.resolveId('../wt-reveal-bridge', `${WS}/src/shims/next-image.tsx`)).toBe(join(SCAFFOLD_SRC, 'wt-reveal-bridge.ts'));
  // El runtime jsx del ws importa su wt-source por ruta absoluta: va al del scaffold, el mismo que usa select-bridge.
  expect(p.resolveId(`${WS}/src/wt-source.ts`)).toBe(join(SCAFFOLD_SRC, 'wt-source.ts'));
  expect(p.resolveId('./wt-section', `${WS}/src/App.tsx`)).toBeNull();
  expect(p.resolveId('./wt-select-bridge', '/otro/src/main.tsx')).toBeNull();
  const stub = p.load('\0wt-bridge-stub:wt-select-bridge') ?? '';
  expect(stub).toContain(`export * from ${JSON.stringify(join(SCAFFOLD_SRC, 'wt-select-bridge.ts'))}`);
  expect(stub).toContain('export function installSelectBridge() { return () => {}; }');
  expect(p.config().server.fs.allow).toEqual([WS, SCAFFOLD_SRC]);
  // Build de publish: sin script inyectado, y main.tsx sigue yendo al stub.
  const pub = wtBridgesPlugin(WS, SCAFFOLD_SRC, { inject: false });
  expect(pub.transformIndexHtml.handler()).toEqual([]);
  expect(pub.resolveId('./wt-select-bridge', `${WS}/src/main.tsx`)).toBe('\0wt-bridge-stub:wt-select-bridge');
});

// --- vite real ---
const viteBin = join(SCAFFOLD_SRC, '..', 'node_modules', '.bin', 'vite');
const hasVite = existsSync(viteBin);
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Un ws como los de antes del cambio: su main.tsx importa e instala un puente propio, que no es el del scaffold. */
function oldWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'wt-bridges-ws-'));
  dirs.push(ws);
  mkdirSync(join(ws, 'src'));
  symlinkSync(join(SCAFFOLD_SRC, '..', 'node_modules'), join(ws, 'node_modules'));
  writeFileSync(join(ws, 'package.json'), '{"name":"ws","private":true,"type":"module"}\n');
  writeFileSync(join(ws, 'vite.config.ts'), 'export default {}\n');
  writeFileSync(join(ws, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n');
  writeFileSync(join(ws, 'src', 'wt-select-bridge.ts'), "export function installSelectBridge() { (window as any).oldBridge = 'VIEJO-SIN-RECT' }\n");
  writeFileSync(join(ws, 'src', 'main.tsx'), "import { installSelectBridge } from './wt-select-bridge'\ninstallSelectBridge()\ndocument.title = 'pagina'\n");
  return ws;
}

test.skipIf(!hasVite)('un ws con puente viejo: el HTML trae el script inyectado y el import de main al stub', async () => {
  const ws = oldWorkspace();
  const port = 5890 + Math.floor(Math.random() * 90);
  const child = spawn(viteBin, ['--config', PREVIEW_VITE_CONFIG, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ws, stdio: 'ignore', env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } });
  try {
    let html = '';
    for (let i = 0; i < 200 && !html; i++) {
      html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()).catch(() => '');
      if (!html) await new Promise((r) => setTimeout(r, 50));
    }
    expect(html.indexOf(`src="${BRIDGES_ENTRY_URL}"`)).toBeGreaterThan(-1);
    expect(html.indexOf(BRIDGES_ENTRY_URL)).toBeLessThan(html.indexOf('/src/main.tsx'));
    const main = await fetch(`http://127.0.0.1:${port}/src/main.tsx`).then((r) => r.text());
    expect(main).toContain('wt-bridge-stub:wt-select-bridge');
    const entry = await fetch(`http://127.0.0.1:${port}${BRIDGES_ENTRY_URL}`).then((r) => r.text());
    expect(entry).toContain('/templates/base-scaffold/src/wt-select-bridge.ts');
    // El árbol del ws no cambió.
    expect(readFileSync(join(ws, 'src', 'wt-select-bridge.ts'), 'utf8')).toContain('VIEJO-SIN-RECT');
  } finally {
    child.kill();
  }
}, 30_000);

test.skipIf(!hasVite)('el build de versión con el config del transport sale con los puentes actuales y sin el viejo', () => {
  const ws = oldWorkspace();
  const r = spawnSync(viteBin, ['build', '--config', PREVIEW_VITE_CONFIG, '--logLevel', 'error'], { cwd: ws, encoding: 'utf8', env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } });
  expect(r.status).toBe(0);
  const js = readdirSync(join(ws, 'dist', 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(ws, 'dist', 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('wt:select-rect');
  expect(js).not.toContain('VIEJO-SIN-RECT');
}, 60_000);

// P3 nota B: el sitio publicado no lleva los puentes. Sin el plugin, el main.tsx de un ws viejo empaquetaría su copia.
test.skipIf(!hasVite)('el build de publish sale sin puentes, ni los del scaffold ni el viejo del ws', () => {
  const ws = oldWorkspace();
  const r = spawnSync(viteBin, ['build', '--config', PREVIEW_VITE_CONFIG, '--mode', PUBLISH_MODE, '--logLevel', 'error'], { cwd: ws, encoding: 'utf8', env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' } });
  expect(r.status).toBe(0);
  const files = ['index.html', ...readdirSync(join(ws, 'dist', 'assets')).map((f) => join('assets', f))];
  const out = files.map((f) => readFileSync(join(ws, 'dist', f), 'utf8')).join('\n');
  expect(out).toContain('pagina');
  expect(out).not.toContain(BRIDGES_ENTRY_URL);
  expect(out).not.toContain('wt:select-rect');
  expect(out).not.toContain('VIEJO-SIN-RECT');
}, 60_000);
