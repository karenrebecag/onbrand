// Render-gate (sensor del render real, no de los props): sirve el dist/ de una página generada, la
// recorre como una persona (scroll por pasos y espera a que se asiente) y mide por bloque cuánto del
// texto visible no salió de los props emitidos. Sale 1 si algún bloque de contenido supera el umbral,
// tiene imágenes rotas o no se ve. Escribe render.json junto a la app.
//
//   bun scripts/render-gate.ts generated/<brief> [--threshold 0.5] [--out render.json] [--shots <dir>] [--lang es] [--review]
//
// --review añade, en el mismo browser, la revisión de render (src/render-review.ts): desborde por
// sección a 1440 y 375, errores de página por viewport y smoke de tabs, switches y desplegables.
// --sensors añade los sensores de página (src/page-sensors.ts) a 1440 y 375: filas incompletas,
// alineación de cabecera, lang, fuentes cargadas y entradas animadas. El idioma esperado es --lang.
//
// Requiere `vite build` previo en el directorio generado y la entrada render-input.json que escribe emit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { REVIEW_VIEWPORTS, reviewDefects, type ControlProbe, type Review, type ViewportMeasure } from '../src/render-review';
import { pageForeign, uiLiterals, type Lang } from '../src/foreign-text';
import { serve } from './static-serve';
import { emittedSections } from './emitted-sections';
import { pageSensors, type PageMeasure, type SensorReport } from '../src/page-sensors';
import { DEFAULT_THRESHOLD, RENDER_INPUT, demoLiterals, pageVerdict, parseRenderInput, type VisibleBlock } from '../src/render-gate';

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const flag = (name: string, def: string): string => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const threshold = Number(flag('--threshold', String(DEFAULT_THRESHOLD)));
const out = resolve(dir, flag('--out', 'render.json'));
const shots = flag('--shots', '');
const lang = flag('--lang', '');
const review = args.includes('--review');
const sensors = args.includes('--sensors');
const SENSORS_JS = readFileSync(join(import.meta.dir, 'page-sensors.browser.js'), 'utf8');
if (lang && !['en', 'es', 'pt'].includes(lang)) { console.error(`--lang ${lang}: se espera en, es o pt`); process.exit(2); }

const IMAGE_WAIT_MS = 5000;
/** Por sección, cuánto pasa del borde derecho su descendiente más saliente. Un hijo dentro de un
 * ancestro que recorta (overflow hidden/clip/auto/scroll, un marquee) no desborda la página. El izquierdo
 * no cuenta: en LTR no genera scroll, y ahí viven los sr-only fuera de pantalla. */
async function overflowAt(page: Page, width: number, errors: string[]): Promise<ViewportMeasure> {
  const m = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const clipped = (el: Element): boolean => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(a).overflowX)) return true;
      }
      return false;
    };
    const sections = ([...document.querySelectorAll('[data-wt-slug]')] as HTMLElement[]).map((el) => {
      let max = 0;
      for (const k of el.querySelectorAll('*')) {
        const r = k.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const over = r.right - cw;
        if (over > max && !clipped(k)) max = over;
      }
      return { slug: el.getAttribute('data-wt-slug') ?? '?', role: el.getAttribute('data-wt-role') ?? '?', overflowPx: Math.round(max) };
    });
    return { pageOverflowPx: document.documentElement.scrollWidth - cw, sections };
  });
  return { width, ...m, errors };
}

const CONTROLS: [string, string, string][] = [
  ['tab', '[role=tab]:not([aria-selected="true"])', 'aria-selected'],
  ['switch', '[role=switch]', 'aria-checked'],
  ['expanded', 'button[aria-expanded], [role=button][aria-expanded]', 'aria-expanded'],
];
// Dos por tipo y sección: alcanza para ver si el control responde sin pasarse del presupuesto de tiempo.
const PER_KIND = 2;

/** Activa cada control y mira si su estado ARIA cambia. Un desplegable se vuelve a cerrar para que el
 * desborde a 375 se mida sobre la página tal como llega. */
async function probeControls(page: Page, errors: string[]): Promise<ControlProbe[]> {
  const out: ControlProbe[] = [];
  for (const section of await page.locator('[data-wt-slug]').all()) {
    const slug = (await section.getAttribute('data-wt-slug')) ?? '?';
    const role = (await section.getAttribute('data-wt-role')) ?? '?';
    for (const [control, selector, attr] of CONTROLS) {
      const found = await section.locator(selector).all();
      let probed = 0;
      for (const el of found) {
        if (probed >= PER_KIND) break;
        if (!(await el.isVisible())) continue;
        probed += 1;
        const name = ((await el.getAttribute('aria-label')) ?? (await el.innerText()).trim()).slice(0, 60);
        const before = await el.getAttribute(attr);
        const seenErrors = errors.length;
        try {
          await el.click({ timeout: 1500 });
          await page.waitForTimeout(150);
          const after = await el.getAttribute(attr);
          const error = errors.slice(seenErrors).join(' | ') || undefined;
          out.push({ slug, role, control, name, changed: after !== before, ...(error ? { error } : {}) });
          if (control === 'expanded' && after !== before) await el.click({ timeout: 1500 }).catch(() => undefined);
        } catch (e) {
          out.push({ slug, role, control, name, changed: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) });
        }
      }
    }
  }
  return out;
}

async function measure(url: string): Promise<{ seen: VisibleBlock[]; errors: string[]; review?: Review; sensed?: PageMeasure[] }> {
  const browser = await chromium.launch({ headless: true });
  const started = Date.now();
  try {
    const page = await browser.newPage({ viewport: { width: review ? REVIEW_VIEWPORTS[0] : 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    // 'load' y no 'networkidle': el @import de Google Fonts deja una conexión abierta y networkidle
    // puede no resolver nunca.
    await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    // Lo que espera un reveal solo se ve antes de bajar: el sensor de entradas mide antes y después.
    if (sensors) {
      await page.evaluate(SENSORS_JS);
      await page.evaluate(() => (window as unknown as { __wtSensors: { pre(): unknown } }).__wtSensors.pre());
    }
    // Los bloques aparecen al entrar en vista (IntersectionObserver once:true): bajar por pasos deja
    // todo visible al llegar al fondo.
    await page.evaluate(async () => {
      for (let y = 0; y <= document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
    });
    // Dos lecturas iguales de innerText (contadores y motion terminados) o tope de 6 s.
    let prev = '';
    for (let i = 0; i < 15; i += 1) {
      await page.waitForTimeout(400);
      const cur = await page.evaluate(() => document.body.innerText);
      if (cur === prev) break;
      prev = cur;
    }
    // Una imagen externa todavía en vuelo no está rota: sin esta espera, la misma página daba 6 rotas
    // en frío y 0 después (testimonial3_block contra el CDN de Relume). Solo cuenta lo que terminó en error
    // o no llegó en IMAGE_WAIT_MS.
    await page.evaluate((ms) => Promise.race([
      Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise((r) => setTimeout(r, ms)),
    ]), IMAGE_WAIT_MS);
    const seen = await page.evaluate(() => {
      const read = (el: HTMLElement) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        const parts: string[] = [];
        const hidden = new Set<Node>();
        let n: Node | null = walker.currentNode;
        while (n) {
          if (n.nodeType === 1) {
            const e = n as HTMLElement;
            const cs = getComputedStyle(e);
            // sr-only es texto para lectores de pantalla, no pixeles: si contara, el valor accesible de
            // un contador duplicaría la cifra visible.
            const srOnly = cs.display !== 'contents' && cs.position === 'absolute' && (cs.clipPath === 'inset(50%)' || (cs.width === '1px' && cs.height === '1px'));
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none' || srOnly) hidden.add(e);
            else if (e.parentElement && hidden.has(e.parentElement)) hidden.add(e);
          } else if (n.nodeType === 3 && !(n.parentElement && (hidden.has(n.parentElement) || n.parentElement.closest('script,style')))) {
            parts.push(n.nodeValue ?? '');
          }
          n = walker.nextNode();
        }
        // El envoltorio es display:contents y no tiene caja: la del bloque es la unión de sus descendientes.
        let top = Infinity;
        let bottom = -Infinity;
        let opacity = '0';
        for (const k of el.querySelectorAll('*')) {
          const r = (k as HTMLElement).getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          top = Math.min(top, r.top);
          bottom = Math.max(bottom, r.bottom);
          const o = getComputedStyle(k as HTMLElement).opacity;
          if (o !== '0') opacity = o;
        }
        const imgs = [...el.querySelectorAll('img')] as HTMLImageElement[];
        const fields = [...el.querySelectorAll('input[placeholder],textarea[placeholder]')] as HTMLInputElement[];
        return {
          slug: el.getAttribute('data-wt-slug'),
          role: el.getAttribute('data-wt-role'),
          text: parts.join(' '),
          height: bottom > top ? Math.round(bottom - top) : 0,
          opacity,
          images: imgs.length,
          brokenImages: imgs.filter((i) => !i.complete || i.naturalWidth === 0).length,
          placeholders: fields.filter((f) => f.getClientRects().length > 0 && !f.value).map((f) => f.placeholder),
        };
      };
      return ([...document.querySelectorAll('[data-wt-slug]')] as HTMLElement[]).map(read);
    });
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shots, '01-top.png') });
      await page.screenshot({ path: join(shots, '02-full.png'), fullPage: true });
    }
    const sense = (): Promise<PageMeasure> => page.evaluate(async () => {
      await document.fonts.ready;
      return (window as unknown as { __wtSensors: { post(): PageMeasure } }).__wtSensors.post();
    });
    const sensedWide = sensors ? await sense() : undefined;
    if (!review && !sensors) return { seen, errors };
    if (!review) {
      await page.setViewportSize({ width: REVIEW_VIEWPORTS[1], height: 800 });
      await page.waitForTimeout(400);
      return { seen, errors, sensed: [sensedWide!, await sense()] };
    }
    // Mismo browser y misma página: los bloques ya se revelaron al bajar, así que a 375 basta con
    // cambiar el ancho y dejar que reacomode, sin volver a recorrer.
    const wide = await overflowAt(page, REVIEW_VIEWPORTS[0], [...errors]);
    const controls = await probeControls(page, errors);
    wide.errors = [...errors];
    const mark = errors.length;
    await page.setViewportSize({ width: REVIEW_VIEWPORTS[1], height: 800 });
    await page.waitForTimeout(400);
    const narrow = await overflowAt(page, REVIEW_VIEWPORTS[1], errors.slice(mark));
    const viewports = [wide, narrow];
    const sensed = sensedWide ? [sensedWide, await sense()] : undefined;
    return { seen, errors, review: { viewports, controls, defects: reviewDefects(viewports, controls), ms: Date.now() - started }, ...(sensed ? { sensed } : {}) };
  } finally {
    await browser.close();
  }
}

const inputPath = join(dir, RENDER_INPUT);
const distDir = join(dir, 'dist');
if (!existsSync(inputPath)) { console.error(`sin ${RENDER_INPUT} en ${dir}: genera la página con scripts/run.ts`); process.exit(2); }
if (!existsSync(join(distDir, 'index.html'))) { console.error(`sin dist/ en ${dir}: corre vite build primero`); process.exit(2); }

const emitted = parseRenderInput(JSON.parse(readFileSync(inputPath, 'utf8')));
const demo = demoLiterals(join(dir, 'src', 'components'));
const server = serve(distDir);
const { seen, errors, review: reviewed, sensed } = await measure(`http://localhost:${server.port}/`).finally(() => server.stop(true));
const { page, blocks } = pageVerdict(seen, emitted, demo, threshold);
// foreign-text informa y no reprueba todavía: primero hay que medir cuánto chrome falta portar.
const foreign = pageForeign(seen, emitted, uiLiterals(join(dir, 'src', 'components')), (lang || undefined) as Lang | undefined);

// Los sensores informan y no cambian la salida: quién actúa con ellos lo decide su dueño (HC2).
const sensorReport: SensorReport | undefined = sensed ? pageSensors(sensed, lang ? { lang: lang as Lang } : {}, emittedSections(dir)) : undefined;
writeFileSync(out, `${JSON.stringify({ page: { ...page, errors, foreignText: foreign.summary }, blocks, foreignText: foreign.findings, ...(reviewed ? { review: reviewed } : {}), ...(sensorReport ? { sensors: { ...sensorReport, measures: sensed } } : {}) }, null, 2)}\n`);
console.log(`${page.pass ? 'PASS' : 'FAIL'} ${dir} residuo=${page.residueRatio} max=${page.residueRatioMax} rotas=${page.brokenImages} foreign=${foreign.summary.count}(ui ${foreign.summary.ui}, demo ${foreign.summary.demo}, lang ${foreign.summary.lang ?? '?'}) fallan=${page.failing.join(',') || '-'}${reviewed ? ` defectos=${reviewed.defects.length} (${reviewed.ms} ms)` : ''}${sensorReport ? ` sensores=${sensorReport.defects.length}` : ''}${page.unmatched.length ? ` sin pareja=${page.unmatched.join(',')}` : ''}`);
process.exit(page.pass ? 0 : 1);
