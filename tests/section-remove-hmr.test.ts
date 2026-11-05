// QA u3 (b) sobre main a352af5d (#723), en vivo con el builder: quitar una sección ya no renumera, pero el preview sigue
// pidiendo el módulo borrado ("[vite] Failed to reload /src/sections/08-faq-2.tsx", 404) y el builder lo recibe como
// wt:runtime-error: aparece "1 error · Arreglar" sobre una página sana. Causa: applyEdits escribe App y borra en el
// mismo tick; vite ve el borrado cuando App todavía importa el módulo en su grafo (el cliente no volvió a pedir App) y
// manda un update para el archivo que ya no existe. Diferir el borrado no basta (vite manda ese update aun después del
// prune): el plugin wt-hmr-delete del config del runtime lo suprime si ningún importador lo sigue importando en disco.
// El server sale del config del runtime (preview-vite.config.ts), el mismo que usa el preview.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type InlineConfig, type ViteDevServer } from '../templates/base-scaffold/node_modules/vite/dist/node/index.js';
import { applyEdits } from '../src/runtime/direct-edit';
import { PREVIEW_VITE_CONFIG } from '../src/runtime/shared';

const scaffoldModules = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'node_modules');
let server: ViteDevServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const section = 'export const faq = 1;\nif (import.meta.hot) import.meta.hot.accept();\n';
const app = (withCopy: boolean): string => `import { faq } from './sections/08-faq';\n${withCopy ? "import { faq as faq2 } from './sections/08-faq-2';\n" : ''}export const page = [faq${withCopy ? ', faq2' : ''}];\nif (import.meta.hot) import.meta.hot.accept();\n`;

type Sent = { type: string; paths: string[] };

/** Un ws con App y sus secciones, servido con el config del runtime y con el grafo como lo deja una página abierta. */
async function serve(withCopy: boolean): Promise<{ ws: string; sent: Sent[]; client: (url: string) => Promise<void> }> {
  dir = mkdtempSync(join(tmpdir(), 'section-remove-hmr-'));
  const ws = dir;
  mkdirSync(join(ws, 'src', 'sections'), { recursive: true });
  symlinkSync(scaffoldModules, join(ws, 'node_modules'));
  writeFileSync(join(ws, 'vite.config.ts'), 'export default {}\n');
  writeFileSync(join(ws, 'index.html'), '<script type="module" src="/src/App.ts"></script>\n');
  writeFileSync(join(ws, 'src', 'App.ts'), app(withCopy));
  writeFileSync(join(ws, 'src', 'sections', '08-faq.ts'), section);
  if (withCopy) writeFileSync(join(ws, 'src', 'sections', '08-faq-2.ts'), section);
  // El config del runtime toma el ws de process.cwd(), como cuando el preview lanza vite dentro del ws.
  const cwd = process.cwd();
  process.chdir(ws);
  let config: InlineConfig;
  try { config = await (await import(PREVIEW_VITE_CONFIG)).default({ command: 'serve', mode: 'development' }); } finally { process.chdir(cwd); }
  server = await createServer({ ...config, configFile: false, logLevel: 'silent', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } });
  const hot = server.environments.client.hot;
  const sent: Sent[] = [];
  const send = hot.send.bind(hot);
  hot.send = ((payload: { type: string; updates?: { path: string }[] }) => {
    sent.push({ type: payload.type, paths: (payload.updates ?? []).map((u) => u.path) });
    return send(payload as never);
  }) as typeof hot.send;
  const client = async (url: string): Promise<void> => { await server!.environments.client.transformRequest(url).catch(() => undefined); };
  for (const url of ['/src/App.ts', '/src/sections/08-faq.ts', ...(withCopy ? ['/src/sections/08-faq-2.ts'] : [])]) await client(url);
  // El watcher tarda en asentarse: sin esto, sus primeros eventos de los archivos iniciales se cuelan como updates.
  await new Promise((r) => setTimeout(r, 1500));
  sent.length = 0;
  return { ws, sent, client };
}

const settle = async (sent: Sent[], path: string): Promise<void> => {
  for (let i = 0; i < 40 && !sent.some((s) => s.paths.includes(path)); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
};
const copyUpdates = (sent: Sent[]): Sent[] => sent.filter((s) => s.paths.includes('/src/sections/08-faq-2.ts') || s.type === 'full-reload');

test('quitar una sección no hace que vite mande un update del módulo que se acaba de borrar', async () => {
  const { ws, sent } = await serve(true);
  applyEdits(ws, { 'src/App.ts': app(false) }, ['src/sections/08-faq-2.ts']);
  await settle(sent, '/src/App.ts');
  expect(sent.some((s) => s.paths.includes('/src/App.ts'))).toBe(true);
  expect(copyUpdates(sent)).toEqual([]);
}, 15_000);

test('duplicar → quitar → duplicar el mismo slug: el segundo duplicado manda solo el update de App, como el primero', async () => {
  const { ws, sent, client } = await serve(false);
  const copy = { 'src/App.ts': app(true), 'src/sections/08-faq-2.ts': section };
  applyEdits(ws, copy, []);
  await settle(sent, '/src/App.ts');
  await client('/src/App.ts');
  await client('/src/sections/08-faq-2.ts');
  applyEdits(ws, { 'src/App.ts': app(false) }, ['src/sections/08-faq-2.ts']);
  await settle(sent, '/src/App.ts');
  await client('/src/App.ts');
  sent.length = 0;
  applyEdits(ws, copy, []);
  await settle(sent, '/src/App.ts');
  expect(sent.map((s) => s.paths)).toEqual([['/src/App.ts']]);
}, 20_000);

test('borrar un módulo que App todavía importa sí manda su update: el error es real', async () => {
  const { ws, sent } = await serve(true);
  applyEdits(ws, {}, ['src/sections/08-faq-2.ts']);
  await settle(sent, '/src/sections/08-faq-2.ts');
  expect(copyUpdates(sent).length).toBeGreaterThan(0);
}, 15_000);
