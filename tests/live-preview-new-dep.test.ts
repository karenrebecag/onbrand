// QA HACK #7 (run-checks.ts:91, "el dev server ya vivo del ws no se reinicia tras un reinstall"), medido en vivo sobre main
// ee3b8ed7: con el preview abierto, un follow-up agrega lodash.debounce al package.json y lo importa en el hero. El
// agente escribe antes del install, vite intenta resolver el import y falla; installDeps (run-close.ts:269) instala bien,
// pero el dev server sigue respondiendo "Failed to resolve import" 60 s después y tras recargar la página. Matar ese vite
// y dejar que el latido lo levante lo arregla ("QA-DEP function", 0 errores). Arreglado con wt-deps-restart-plugin: la
// marca de install nueva reinicia el server vivo (server.restart(); invalidar el módulo o packageCache no bastan).
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from '../templates/base-scaffold/node_modules/vite/dist/node/index.js';
import { INSTALLED_MARK, wtDepsRestartPlugin } from '../src/runtime/wt-deps-restart-plugin';

let server: ViteDevServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('un vite vivo resuelve una dependencia instalada después de que su import falló', async () => {
  dir = mkdtempSync(join(tmpdir(), 'live-preview-new-dep-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), '{"name":"ws","type":"module"}\n');
  writeFileSync(join(dir, 'index.html'), '<script type="module" src="/src/hero.ts"></script>\n');
  writeFileSync(join(dir, 'src', 'hero.ts'), "import qaDep from 'qa-new-dep';\nexport const kind = typeof qaDep;\n");
  server = await createServer({ root: dir, configFile: false, logLevel: 'silent', server: { middlewareMode: true }, plugins: [wtDepsRestartPlugin(20) as never] });
  const env = server.environments.client;
  // El agente escribió el import antes del install: el primer pedido del preview falla.
  await expect(env.transformRequest('/src/hero.ts')).rejects.toThrow(/qa-new-dep/);
  // installDeps deja el paquete en node_modules.
  mkdirSync(join(dir, 'node_modules', 'qa-new-dep'));
  writeFileSync(join(dir, 'node_modules', 'qa-new-dep', 'package.json'), '{"name":"qa-new-dep","version":"1.0.0","main":"index.js"}\n');
  writeFileSync(join(dir, 'node_modules', 'qa-new-dep', 'index.js'), 'module.exports = function qaNewDep() {};\n');
  // Y al terminar bien escribe la marca con el hash nuevo de las deps.
  writeFileSync(join(dir, 'node_modules', INSTALLED_MARK), 'hash-con-qa-new-dep');
  // La persona recarga: el módulo se pide de nuevo. El reinicio corre en segundo plano; se espera a que llegue, sin plazo.
  const resolved = async (): Promise<string | undefined> => {
    try { return (await server!.environments.client.transformRequest('/src/hero.ts'))?.code; } catch { return undefined; }
  };
  let code = await resolved();
  while (!code) { await new Promise((r) => setTimeout(r, 20)); code = await resolved(); }
  expect(code).toContain('qa-new-dep');
  expect(env).not.toBe(server.environments.client);
}, 20_000);
