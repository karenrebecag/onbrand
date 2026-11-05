// El navegador de la tool `browser`: Playwright (ya instalado, el mismo que render-gate y preview-runtime) con los
// verbos de agent-browser que usa v0 en j049 (open, viewport, screenshot --full, errors, find role click, get text).
// Aparte de workspace-tools para que la lógica se pruebe sin chromium.

import { chromium, type Browser } from 'playwright';
import type { RuntimeIssue } from '../runtime-sensors';

export type BrowseAction = { click: { role: string; name: string } } | { text: string };

export interface BrowseRequest {
  url: string;
  viewport: number;
  /** Alto del viewport de la persona cuando `viewport` es el suyo; sin él, el de HEIGHT. */
  height?: number;
  full: boolean;
  /** Primer píxel a capturar (QA c734443f: una página de 6420 px a 1440 pasa del tope de tramos; con `from` el agente pide el resto). */
  from?: number;
  actions: BrowseAction[];
  /** deviceScaleFactor de la captura: <1 achica los PNG para el modelo de visión sin cambiar el layout medido. */
  scale?: number;
  /** Rol o slug de una sección: solo se capturan los tramos que la cubren (Lovable pasa gauge.png y hero.png, no la
   * página: lov1358 offset 74667). */
  section?: string;
}

export interface BrowseResult {
  /** Un PNG por tramo de un viewport de alto, de arriba abajo (gen fac2bce5: una sola captura de 375×7652 le llegaba
   * al modelo reducida a 98×2000, ilegible). */
  pngs: Buffer[];
  /** Alto real de la página y hasta dónde llegan los tramos. */
  pageHeight: number;
  shownHeight: number;
  /** Desde dónde se capturó (px). */
  from: number;
  issues: RuntimeIssue[];
  /** Los [data-wt-slug] montados, para detectar una sección que tiró y desmontó la página. */
  mounted: string[];
  texts: string[];
  actionErrors: string[];
  overflow: Overflow;
}

/** Ancho del documento contra el viewport y los elementos que lo pasan: un desborde a 375 no se ve en la captura
 * recortada al viewport, así que se mide (como el eval de v0 en V3). */
export interface Overflow {
  scrollWidth: number;
  clientWidth: number;
  offenders: string[];
}

export const HEIGHT = { 1440: 900, 375: 800 } as Record<number, number>;
// Tope de tramos por captura. Los mira el modelo de visión, no el agente, así que el tope cubre la página entera de
// una vez (9000 px a 1440, 12800 a 375): con 5400/8000 la reanudación pedía `from` y era un turno más (planes/ec.md §15cd).
export const MAX_SEGMENTS = { 1440: 10, 375: 16 } as Record<number, number>;

export interface Segment { x: 0; y: number; width: number; height: number }

// Tras scrollTo, un frame para que lo sticky y las animaciones por scroll se asienten antes de capturar.
const SCROLL_SETTLE = 120;

/** Recorte relativo al viewport de un tramo, dado dónde quedó el scroll: al final de la página la ventana no baja
 * hasta `seg.y`, así que el tramo empieza más abajo dentro del viewport. */
export function viewportClip(seg: Segment, scrollY: number): Segment {
  return { x: 0, y: Math.max(0, seg.y - Math.round(scrollY)), width: seg.width, height: seg.height };
}

/** Recortes de un viewport de alto que cubren la página de arriba abajo, hasta el tope; sin `full`, solo el primero.
 * Con `until`, terminan ahí (el final de una sección). */
export function segmentsOf(pageHeight: number, viewport: number, full: boolean, from = 0, until?: number, height?: number): Segment[] {
  const h = height ?? HEIGHT[viewport] ?? 900;
  const max = full ? MAX_SEGMENTS[viewport] ?? 6 : 1;
  const total = Math.max(Math.min(pageHeight, until ?? pageHeight), 1);
  // Un `from` más allá del final no deja la tool sin captura: se recorta al último viewport.
  const start = Math.max(0, Math.min(Math.floor(from), total - 1));
  const out: Segment[] = [];
  for (let y = start; y < total && out.length < max; y += h) out.push({ x: 0, y, width: viewport, height: Math.min(h, total - y) });
  return out;
}
const ACTION_TIMEOUT = 5000;
const MAX_OFFENDERS = 5;
// chrome-headless-shell a veces no arranca (QA, chat 97fd95dc: 180 s colgado y el reintento siguiente arrancó en
// segundos): un launch corto más un reintento cuesta como máximo 60 s del turno en vez de 180.
const LAUNCH_TIMEOUT = 30_000;
const LAUNCH_ATTEMPTS = 2;

type Launch = (opts: { headless: boolean; timeout: number }) => Promise<Browser>;

export async function launchBrowser(launch: Launch = (o) => chromium.launch(o), timeoutMs = LAUNCH_TIMEOUT): Promise<Browser> {
  const errors: string[] = [];
  for (let i = 0; i < LAUNCH_ATTEMPTS; i++) {
    try {
      return await launch({ headless: true, timeout: timeoutMs });
    } catch (e) {
      errors.push((e instanceof Error ? e.message : String(e)).split('\n')[0]);
    }
  }
  throw new Error(`browser: chromium no arrancó en ${LAUNCH_ATTEMPTS} intentos: ${errors.join(' | ')}`);
}

// Tope de una llamada completa: launch (hasta 2 x 30 s) más carga y captura. Sin él una llamada colgada se llevaba el
// turno entero (gen3: más de 810 s solo con heartbeats); al vencer se mata chromium y el agente recibe el paso.
const DEADLINE = 90_000;

/** Cierra chromium sin esperar ni lanzar. El Browser de `chromium.launch()` no tiene process(): eso es de BrowserServer
 * (`launchServer`, playwright-core 1.64.1 types.d.ts:20759). Para uno lanzado, close() "closes the browser and all of its
 * pages" y es como forzar la salida (types.d.ts:11210-11218). */
function closeQuietly(b: Browser): void {
  try {
    void b.close({ reason: 'browser: tope vencido' }).catch(() => undefined);
  } catch {
    // un close que lanza en sincrónico tampoco puede tumbar el proceso
  }
}

export interface BrowseOptions {
  launch?: Launch;
  deadlineMs?: number;
  /** La corrida se detuvo: chromium se cierra igual que al vencer el tope (auditoría #5). */
  signal?: AbortSignal;
}

export async function browse(req: BrowseRequest, opts: BrowseOptions = {}): Promise<BrowseResult> {
  const deadlineMs = opts.deadlineMs ?? DEADLINE;
  let step = 'launch';
  let browser: Browser | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Nada de estos callbacks puede lanzar: desde f691017 la tool corre dentro del transport y una excepción aquí lo
    // tumbaba entero (bench a77b6e3, 18:44 UTC: TypeError de process()).
    const cut = (message: string): void => {
      timedOut = true;
      if (browser) closeQuietly(browser);
      reject(new Error(message));
    };
    timer = setTimeout(() => cut(`browser: sin resultado en ${Math.round(deadlineMs / 1000)} s (paso: ${step}); chromium cerrado, vuelve a llamar`), deadlineMs);
    onAbort = () => cut('browser: la corrida se detuvo; chromium cerrado');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const work = (async () => {
    const b = await launchBrowser(opts.launch);
    // Un launch que llega después del tope no debe quedar huérfano.
    if (timedOut) { closeQuietly(b); throw new Error('browser: tope vencido'); }
    browser = b;
    try {
      return await shoot(b, req, (s) => { step = s; });
    } finally {
      await b.close().catch(() => {});
    }
  })();
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Alto que ocupa la sección en la página. El wrapper de emit es `display: contents` (rect vacío): se suma el de sus hijos. */
async function sectionRange(page: import('playwright').Page, section: string): Promise<{ top: number; bottom: number } | null> {
  return page.evaluate((name) => {
    const el = [...document.querySelectorAll('[data-wt-slug]')].find((e) => {
      const slug = e.getAttribute('data-wt-slug') ?? '';
      return slug === name || e.getAttribute('data-wt-role') === name || slug.endsWith(`-${name}`);
    });
    if (!el) return null;
    const rects = [el, ...el.children].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0);
    if (!rects.length) return null;
    return { top: Math.floor(Math.min(...rects.map((r) => r.top)) + scrollY), bottom: Math.ceil(Math.max(...rects.map((r) => r.bottom)) + scrollY) };
  }, section);
}

async function shoot(browser: Browser, req: BrowseRequest, mark: (step: string) => void): Promise<BrowseResult> {
  const issues: RuntimeIssue[] = [];
  const origin = new URL(req.url).origin;
  {
    mark('newPage');
    const page = await browser.newPage({ viewport: { width: req.viewport, height: req.height ?? HEIGHT[req.viewport] ?? 900 }, ...(req.scale ? { deviceScaleFactor: req.scale } : {}) });
    page.on('pageerror', (e) => issues.push({ kind: 'pageerror', message: e.message, source: e.stack, viewport: req.viewport }));
    page.on('console', (m) => { if (m.type() === 'error') issues.push({ kind: 'console', message: m.text(), source: m.location().url, viewport: req.viewport }); });
    page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(origin)) issues.push({ kind: 'request', message: `${r.status()} ${r.url()}`, source: r.url(), viewport: req.viewport }); });
    mark('goto');
    await page.goto(req.url, { waitUntil: 'networkidle', timeout: 60_000 });
    mark('scroll');
    // Un recorrido como el de una persona: lo que carga o entra al hacer scroll queda pintado en la captura.
    for (let y = 0; y <= (await page.evaluate(() => document.documentElement.scrollHeight)); y += 400) {
      await page.evaluate((v) => scrollTo(0, v), y);
      await page.waitForTimeout(60);
    }
    await page.evaluate(() => scrollTo(0, 0));
    const texts: string[] = [];
    const actionErrors: string[] = [];
    mark('actions');
    for (const a of req.actions) {
      try {
        if ('click' in a) await page.getByRole(a.click.role as Parameters<typeof page.getByRole>[0], { name: a.click.name }).first().click({ timeout: ACTION_TIMEOUT });
        else texts.push(`${a.text}: ${(await page.locator(a.text).first().innerText({ timeout: ACTION_TIMEOUT })).slice(0, 1000)}`);
      } catch (e) {
        actionErrors.push(`${JSON.stringify(a)}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      }
    }
    await page.waitForTimeout(300);
    mark('overflow');
    const overflow = await page.evaluate((max) => {
      const cw = document.documentElement.clientWidth;
      const offenders = [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > cw + 1)
        // solo el más externo de cada rama: sus hijos desbordan por arrastre
        .filter((e, _, all) => !all.some((o) => o !== e && o.contains(e)))
        .slice(0, max)
        .map((e) => {
          const slug = e.closest('[data-wt-slug]')?.getAttribute('data-wt-slug');
          const cls = typeof e.className === 'string' && e.className ? `.${e.className.trim().split(/\s+/)[0]}` : '';
          return `${slug ? `${slug} ` : ''}${e.tagName.toLowerCase()}${cls} (${Math.round(e.getBoundingClientRect().right)} px)`;
        });
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: cw, offenders };
    }, MAX_OFFENDERS);
    const mounted = await page.evaluate(() => [...document.querySelectorAll('[data-wt-slug]')].map((e) => e.getAttribute('data-wt-slug') ?? ''));
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const range = req.section ? await sectionRange(page, req.section) : null;
    if (req.section && !range) actionErrors.push(`sección "${req.section}" no encontrada: se capturó la página`);
    const segments = range ? segmentsOf(pageHeight, req.viewport, true, range.top, range.bottom, req.height) : segmentsOf(pageHeight, req.viewport, req.full, req.from ?? 0, undefined, req.height);
    mark('screenshot');
    const pngs: Buffer[] = [];
    // Captura del viewport tras hacer scroll a cada tramo, no `fullPage` + clip: en Chromium ese clip se desplaza con el
    // scroll que la página ya tenga (gen 3fc160a7: el tramo 1 a 1440 arrancaba en la sección 2 y el agente no vio el hero).
    for (const seg of segments) {
      const scrollY = await page.evaluate((y) => { window.scrollTo(0, y); return window.scrollY; }, seg.y);
      await page.waitForTimeout(SCROLL_SETTLE);
      pngs.push(await page.screenshot({ type: 'png', clip: viewportClip(seg, scrollY) }));
    }
    const last = segments[segments.length - 1];
    return { pngs, pageHeight, shownHeight: last.y + last.height, from: segments[0].y, issues, mounted, texts, actionErrors, overflow };
  }
}
