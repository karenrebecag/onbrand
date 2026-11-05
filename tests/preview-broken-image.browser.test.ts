// QA C5 B2 sobre main 108104fd, en vivo: con --fixture una sección con <img src="/qa-b2-no-existe.png"> se guarda como versión ok
// y nada la marca. El render-gate (que contaba imágenes rotas, render-check.ts:16) solo corre sin agente (run-close.ts:292,
// `!raw.agent`) y desde B2 todo turno es de agente, así que ya no corre nunca. El preview-check tampoco la ve: vite responde a
// una ruta inexistente con index.html y 200 (fallback de SPA), y el sensor de `request` solo anota status >= 400
// (preview-viewport.ts:53). Resultado medido: preview-check con solo defectos de contraste, sin auto-repair de runtime.
// Este server imita ese fallback: cualquier ruta que no sea .svg devuelve la página con 200. Un 2º server imita un origen
// externo que no entrega una imagen (devuelve HTML), para el caso de imagen rota que el agente no puede arreglar.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { checkViewport, type ViewportContext } from '../src/preview-viewport';
import { RUNTIME_KINDS } from '../src/runtime/runtime-kinds';

// SVG solo con viewBox (sin width/height): Chromium le da tamaño intrínseco por defecto, así que carga con naturalWidth>0
// y no debe contar como rota. Se sirve como archivo real, no como data URI.
const VB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let ext: ReturnType<typeof Bun.serve>;
let ext404: ReturnType<typeof Bun.serve>;
let pageHtml = '';
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = Bun.serve({
    port: 0,
    fetch: (req) => new URL(req.url).pathname.endsWith('.svg')
      ? new Response(VB_SVG, { headers: { 'content-type': 'image/svg+xml' } })
      : new Response(pageHtml, { headers: { 'content-type': 'text/html' } }),
  });
  ext = Bun.serve({ port: 0, fetch: () => new Response('<!doctype html><html><body>no soy imagen</body></html>', { headers: { 'content-type': 'text/html' } }) });
  ext404 = Bun.serve({ port: 0, fetch: () => new Response('no hay', { status: 404 }) });
});
afterAll(async () => {
  await browser.close();
  server.stop(true);
  ext.stop(true);
  ext404.stop(true);
});

const checkOf = async (body: string): Promise<string> => {
  pageHtml = `<!doctype html><html><body><section data-wt-slug="01-features">${body}</section></body></html>`;
  const ctx: ViewportContext = { url: `http://127.0.0.1:${server.port}/`, ws: '.', changed: ['01-features'], headShots: null, scope: null, prev: null, head: null, prevTexts: null };
  return JSON.stringify(await checkViewport(browser, 1440, ctx));
};

test('una imagen que no carga (fallback de SPA con 200) sale como defecto broken-image', async () => {
  const all = await checkOf('<img src="/qa-b2-no-existe.png" alt="foto" width="320" height="200"><p>Texto</p>');
  expect(all).toContain('qa-b2-no-existe.png');
  expect(all).toContain('broken-image');
}, 60000);

test('un <img> sin src o con src="" es placeholder vacío, no defecto: no dispara broken-image', async () => {
  const all = await checkOf('<img alt="sin src" width="320" height="200"><img src="" alt="vacio" width="320" height="200"><p>Texto</p>');
  expect(all).not.toContain('broken-image');
  expect(all).not.toContain('imagen rota');
}, 60000);

test('un SVG solo con viewBox carga con tamaño intrínseco y no cuenta como rota', async () => {
  const all = await checkOf('<img src="/vb.svg" alt="icono" width="24" height="24"><p>Texto</p>');
  expect(all).not.toContain('broken-image');
  expect(all).not.toContain('imagen rota');
}, 60000);

test('una imagen de otro origen que no carga se reporta como broken-image-external (fuera de RUNTIME_KINDS)', async () => {
  const all = await checkOf(`<img src="http://127.0.0.1:${ext.port}/rota.png" alt="externa" width="320" height="200"><p>Texto</p>`);
  expect(all).toContain('broken-image-external');
  expect(all).toContain('origen externo');
}, 60000);

const issuesOf = async (body: string) => {
  pageHtml = `<!doctype html><html><body><section data-wt-slug="01-features">${body}</section></body></html>`;
  const ctx: ViewportContext = { url: `http://127.0.0.1:${server.port}/`, ws: '.', changed: ['01-features'], headShots: null, scope: null, prev: null, head: null, prevTexts: null };
  return (await checkViewport(browser, 1440, ctx)).issues;
};

// QA #866 en vivo (serve.ts --fixture, src="https://imagenes.invalid/caida.png"): el run reportó broken-image-external y
// lanzó igual el auto-repair, por el `console` "Failed to load resource: net::ERR_NAME_NOT_RESOLVED" que Chromium anota con
// location().url = la imagen (preview-viewport.ts:49). El origen externo del test de arriba responde 200 con HTML y no lo
// emite; uno que responde 404 (o no resuelve) sí. Nada de RUNTIME_KINDS puede quedar por esa imagen.
test('una imagen externa que da 404 no deja ningún defecto de RUNTIME_KINDS, solo broken-image-external', async () => {
  const src = `http://127.0.0.1:${ext404.port}/rota.png`;
  const issues = await issuesOf(`<img src="${src}" alt="externa" width="320" height="200"><p>Texto</p>`);
  expect(issues.map((i) => i.kind)).toContain('broken-image-external');
  expect(issues.filter((i) => RUNTIME_KINDS.has(i.kind)).map((i) => `${i.kind}: ${i.message}`)).toEqual([]);
}, 60000);

// Un data: roto lo escribió el agente en la página: su origen es "null", no otro sitio. Clasificarlo como externo lo deja
// sin auto-repair (QA en vivo: data:image/png;base64,AAAAAAAA salió broken-image-external).
test('una imagen data: rota es de la página: broken-image, no broken-image-external', async () => {
  const issues = await issuesOf('<img src="data:image/png;base64,AAAAAAAA" alt="data" width="320" height="200"><p>Texto</p>');
  expect(issues.map((i) => i.kind)).toContain('broken-image');
  expect(issues.map((i) => i.kind)).not.toContain('broken-image-external');
}, 60000);
