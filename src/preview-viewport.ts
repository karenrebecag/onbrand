// Un ancho del preview-check: carga, recorre y corre los sensores de ese ancho en su propia página. preview-runtime
// lanza los cuatro anchos a la vez porque son verificaciones independientes, como el agente de Make cuando abre el
// build y el grep de autochequeo antes de que vuelva el primer resultado (re-iteracion/figma-make/
// net-t4-figmake.network-response:1443-1447). Ninguna referencia corre sensores por sección como los nuestros
// (re-iteracion/planes/qa.md §5): el paralelismo tiene respaldo, los sensores siguen siendo un hueco.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { saveDom, serializeDom } from './dom-snapshot';
import { collectContrastSamples, contrastDefects } from './contrast-sensor';
import { clickControls, interactionDefects } from './interaction-sensor';
import { collectLayout, layoutDefects } from './layout-sensor';
import { REVIEW_VIEWPORTS } from './render-review';
import type { RuntimeDefect, RuntimeIssue } from './runtime-sensors';
import { collectTexts, filesOutOfScope, scopeDefects, textOutOfScope } from './scope-sensor';

export interface ViewportContext {
  url: string;
  ws: string;
  /** Secciones que cambió la versión: las únicas cuyos botones se pulsan. */
  changed: readonly string[];
  headShots: string | null;
  scope: ReadonlySet<string> | null;
  prev: string | null;
  head: string | null;
  prevTexts: string | null;
  // HACK: ownOrigins queda sin poblar. Hoy ninguna página generada emite una imagen propia cross-origin (uploads y canvas
  // son root-relative, avatares/logos son data: SVG), así que una rota propia ya cae en broken-image. Disparador: en el
  // deploy H11 las imágenes subidas/generadas salen del API y del Blob del perfil (otro origen); hasta cablear ownOrigins
  // con esos hosts en el caller, una ruta mal escrita hacia una imagen propia saldrá broken-image-external y no se reparará
  // (checklist en docs/notas/deploy-builder.md, sección "orígenes de imágenes propias (H11)").
  /** Orígenes propios además del de la preview (API/builder, host del Blob del perfil); lo puebla el caller (preview-runtime/serve). */
  ownOrigins?: readonly string[];
}

export interface ViewportCheck {
  viewport: number;
  issues: RuntimeIssue[];
  mounted: string[];
  layout: RuntimeDefect[];
  contrast: RuntimeDefect[];
  interaction: RuntimeDefect[];
  scoped: RuntimeDefect[];
}

export async function checkViewport(browser: Browser, viewport: number, ctx: ViewportContext): Promise<ViewportCheck> {
  const origin = new URL(ctx.url).origin;
  const issues: RuntimeIssue[] = [];
  // Un sink por página: con los anchos en paralelo, uno compartido le atribuiría a un clic de 1440 lo que tira 375.
  const sink: { errors: string[] | null } = { errors: null };
  const page = await browser.newPage({ viewport: { width: viewport, height: 900 } });
  try {
    // Lo que tira durante un clic es del botón, no de la carga.
    page.on('pageerror', (e) => (sink.errors ? sink.errors.push(e.message) : issues.push({ kind: 'pageerror', message: e.message, source: e.stack, viewport })));
    page.on('console', (m) => { if (m.type() === 'error') (sink.errors ? sink.errors.push(m.text()) : issues.push({ kind: 'console', message: m.text(), source: m.location().url, viewport })); });
    // Un clic no puede mandar nada fuera del preview (un lead, un webhook) ni dejar ventanas abiertas.
    await page.route((u) => u.origin !== origin, (r) => (r.request().method() === 'GET' ? r.continue() : r.abort()));
    page.on('popup', (p) => void p.close());
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(origin)) issues.push({ kind: 'request', message: `${r.status()} ${r.url()}`, source: r.url(), viewport }); });
    await page.goto(ctx.url, { waitUntil: 'networkidle', timeout: 60000 });
    for (let y = 0; y <= (await page.evaluate(() => document.documentElement.scrollHeight)); y += 400) {
      await page.evaluate((v) => scrollTo(0, v), y);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600);
    const mounted = await page.evaluate(() => [...document.querySelectorAll('[data-wt-slug]')].map((e) => e.getAttribute('data-wt-slug') ?? ''));
    // Imagen rota: cargó (complete) pero sin dimensiones reales (naturalWidth 0). El sensor `request` no la ve cuando el
    // dev server responde la página con 200 a una ruta inexistente (fallback de SPA); el navegador recibe HTML, no una
    // imagen, y la decodificación falla. Es el inverso del filtro de v0, que se queda las buenas con `complete &&
    // naturalWidth>0` (v0-fe-capture/sensors/page-sensors.browser.js:183 y measure-fn.js:212).
    // Un `<img>` sin src (o src="") también da complete+naturalWidth 0, pero es un placeholder vacío, no un fallo: se excluye
    // exigiendo src no vacío para no disparar un auto-repair sobre nada. `data:` y `blob:` son de la página (los escribe el
    // agente), igual que el origen de la preview y los propios (API/builder, Blob del perfil): una rota ahí la arregla el
    // agente → `broken-image`. Solo una http(s) hacia un origen ajeno es `broken-image-external`, fuera de RUNTIME_KINDS:
    // visible pero sin gastar un turno de reparación que no puede arreglar un sitio de terceros (como los defectos `preserve.*`).
    const own = [origin, ...(ctx.ownOrigins ?? [])];
    const broken = await page.evaluate((owns) => [...document.querySelectorAll('img')]
      .filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.getAttribute('src') || '').trim() !== '')
      .map((i) => {
        const raw = i.currentSrc || i.getAttribute('src') || '';
        let external = false;
        let abs = raw;
        if (!/^(data|blob):/i.test(raw)) {
          try { const u = new URL(raw, location.href); abs = u.href; external = u.origin !== location.origin && !owns.includes(u.origin); } catch { external = false; }
        }
        return { src: raw.slice(0, 300), abs, slug: i.closest('[data-wt-slug]')?.getAttribute('data-wt-slug') ?? null, external };
      }), own);
    for (const b of broken) issues.push({ kind: b.external ? 'broken-image-external' : 'broken-image', message: `imagen rota${b.external ? ' (origen externo)' : ''}: ${b.src}${b.slug ? ` en ${b.slug}` : ''}`, source: b.src, slug: b.slug, viewport });
    // Una imagen externa que no resuelve, da 404 o rechaza la conexión deja además un console.error del navegador con la URL de
    // la imagen; ese `console` está en RUNTIME_KINDS y dispararía el auto-repair que un origen ajeno no puede arreglar. Se
    // descarta el console cuyo source es esa imagen; el console de un script externo roto (otra URL) se queda.
    const externalSrcs = new Set(broken.filter((b) => b.external).map((b) => b.abs));
    for (let k = issues.length - 1; k >= 0; k--) {
      const it = issues[k];
      if (it.kind === 'console' && it.source && externalSrcs.has(it.source)) issues.splice(k, 1);
    }
    // Layout y contraste antes de los clics: un clic puede dejar abierto un modal.
    const layout = layoutDefects(await page.evaluate(collectLayout), viewport);
    // Contraste a un solo ancho: los colores no cambian por viewport y repetirlo duplicaría cada defecto.
    const contrast = viewport === REVIEW_VIEWPORTS[0] ? contrastDefects(await page.evaluate(collectContrastSamples), viewport) : [];
    const scoped: RuntimeDefect[] = [];
    // saveDom crea el directorio de la versión (mkdir) antes de que scopeAt escriba texts.json en él; mantener este orden.
    if (viewport === REVIEW_VIEWPORTS[0] && ctx.headShots) {
      // Antes de los clics (un clic puede dejar un modal abierto) y en la misma página: el DOM de la versión sin navegador nuevo.
      saveDom(ctx.headShots, viewport, await page.evaluate(serializeDom));
      scoped.push(...(await scopeAt(page, viewport, ctx, ctx.headShots)));
    }
    const interaction = viewport === REVIEW_VIEWPORTS[0] && ctx.changed.length ? interactionDefects(await clickControls(page, ctx.changed, sink), viewport) : [];
    return { viewport, issues, mounted, layout, contrast, interaction, scoped };
  } finally {
    await page.close();
  }
}

async function scopeAt(page: Page, viewport: number, ctx: ViewportContext, headShots: string): Promise<RuntimeDefect[]> {
  const texts = await page.evaluate(collectTexts);
  writeFileSync(join(headShots, 'texts.json'), JSON.stringify(texts));
  if (!ctx.scope || !ctx.prev || !ctx.head) return [];
  // El texto se compara solo contra el padre directo: contra un ancestro, una edición directa intermedia del
  // propio usuario contaría como cambio del turno.
  const before = ctx.prevTexts && existsSync(join(ctx.prevTexts, 'texts.json')) ? JSON.parse(readFileSync(join(ctx.prevTexts, 'texts.json'), 'utf8')) as Record<string, string> : null;
  return scopeDefects(filesOutOfScope(ctx.ws, ctx.prev, ctx.head, ctx.scope), before ? textOutOfScope(before, texts, ctx.scope) : [], ctx.scope, viewport);
}
