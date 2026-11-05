// Sensores de página sobre cualquier HTML, para calibrar contra v0 sin pasar por render-input.json:
// un snapshot suelto (snapshots/proxy de v0), el dist de un workspace o una URL.
//   bun scripts/page-sensors.ts <archivo.html | dir con dist/ | http(s)://…> [--lang en] [--align start] [--motion-budget 1] [--json out.json]
//   bun scripts/page-sensors.ts --measures 1440.json,375.json [--lang es]
// Sale 1 si hay defectos. Mide a 1440 y 375 con el mismo código que render-gate --sensors. --measures decide
// sobre medidas ya tomadas con page-sensors.browser.js en otro navegador (el preview de v0 en el Chrome de
// Karen, que Playwright no puede abrir sin su sesión).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { pageSensors, type Align, type PageMeasure } from '../src/page-sensors';
import type { Lang } from '../src/foreign-text';
import { REVIEW_VIEWPORTS } from '../src/render-review';
import { serve } from './static-serve';
import { emittedSections } from './emitted-sections';
import { PLAN_FILE, parsePagePlanMd, type PagePlanMd } from '../src/page-plan-md';
import { DIRECTIONS } from '../src/directions';
import { directionBlocks, directionRefDefects, traceBlocks, type TraceBlock } from '../src/direction-refs';
import { readWaSdk } from '../src/wa-sdk';
import { waSensors, type WaMeasure } from '../src/wa-sensors';
import { armWa, measureWa } from './wa-measure';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const measuresArg = flag('--measures');
const target = measuresArg ?? args.find((a, i) => !a.startsWith('--') && !['--lang', '--align', '--motion-budget', '--json'].includes(args[i - 1]));
if (!target) { console.error('uso: bun scripts/page-sensors.ts <archivo.html | dir | url> [--lang en]'); process.exit(2); }
const lang = flag('--lang') as Lang | undefined;
if (lang && !['en', 'es', 'pt'].includes(lang)) { console.error(`--lang ${lang}: se espera en, es o pt`); process.exit(2); }
const align = flag('--align') as Align | undefined;
const budget = flag('--motion-budget');
const SENSORS_JS = readFileSync(join(import.meta.dir, 'page-sensors.browser.js'), 'utf8');

// Un workspace (dir con dist/) se sirve como lo hará QA: con wa-sdk.json, static-serve pone el SDK y el sink (spec wa-sdk §3.5).
const wsOf = (t: string): string | undefined => (!/^https?:\/\//.test(t) && existsSync(resolve(t)) && statSync(resolve(t)).isDirectory() && existsSync(join(resolve(t), 'dist', 'index.html')) ? resolve(t) : undefined);

function open(t: string): { url: string; stop(): void } {
  if (/^https?:\/\//.test(t)) return { url: t, stop: () => undefined };
  const abs = resolve(t);
  if (!existsSync(abs)) { console.error(`no existe ${abs}`); process.exit(2); }
  const root = statSync(abs).isDirectory() ? (existsSync(join(abs, 'dist', 'index.html')) ? join(abs, 'dist') : abs) : dirname(abs);
  const ws = wsOf(t);
  const waSdk = ws ? readWaSdk(ws) : undefined;
  const server = serve(root, statSync(abs).isDirectory() ? 'index.html' : basename(abs), waSdk ? { waSdk } : {});
  return { url: `http://localhost:${server.port}/`, stop: () => server.stop(true) };
}

async function measureInBrowser(t: string): Promise<{ measures: PageMeasure[]; wa?: WaMeasure }> {
  const { url, stop } = open(t);
  const ws = wsOf(t);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: REVIEW_VIEWPORTS[0], height: 900 } });
    // Antes de navegar: el SDK manda telemetría al cargar, sin clic.
    const cap = ws ? await armWa(page) : undefined;
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(SENSORS_JS);
    type Api = { __wtSensors: { run(): Promise<PageMeasure>; post(): PageMeasure } };
    const wide = await page.evaluate(() => (window as unknown as Api).__wtSensors.run());
    const wa = ws && cap ? await measureWa(page, cap, ws) : undefined;
    await page.setViewportSize({ width: REVIEW_VIEWPORTS[1], height: 800 });
    await page.waitForTimeout(400);
    return { measures: [wide, await page.evaluate(() => (window as unknown as Api).__wtSensors.post())], ...(wa ? { wa } : {}) };
  } finally {
    await browser.close();
    stop();
  }
}

const measured = measuresArg
  ? { measures: measuresArg.split(',').map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as PageMeasure) }
  : await measureInBrowser(target);
const measures: PageMeasure[] = measured.measures;
// Un workspace trae page.json: se afirma también que lo que decidió el composer llegó a la página.
const wsDir = !measuresArg && !/^https?:\/\//.test(target) && existsSync(resolve(target)) && statSync(resolve(target)).isDirectory() ? resolve(target) : undefined;
// El plan se afirma solo en un workspace del agente (page.json con `agent`): el camino anterior no lo escribe.
function workspacePlan(dir: string): PagePlanMd | null | undefined {
  const planPath = join(dir, PLAN_FILE);
  if (existsSync(planPath)) return parsePagePlanMd(readFileSync(planPath, 'utf8'));
  const pagePath = join(dir, 'page.json');
  return existsSync(pagePath) && (JSON.parse(readFileSync(pagePath, 'utf8')) as { agent?: unknown }).agent ? null : undefined;
}
const plan = wsDir ? workspacePlan(wsDir) : undefined;
// La dirección entregada al agente (spec catalogo-direcciones §5): `# Dirección: <id>` en references/direction.md del skill.
function workspaceDirection(dir: string) {
  const file = [join(dir, '.wt', 'skill', 'references', 'direction.md'), join(dir, 'references', 'direction.md')].find((f) => existsSync(f));
  const md = file ? readFileSync(file, 'utf8') : '';
  const id = /^# Direcci[oó]n:\s*(\S+)/m.exec(md)?.[1];
  const direction = id ? DIRECTIONS.find((d) => d.id === id) : undefined;
  if (id && !direction) { console.error(`${file}: la dirección ${id} no está en el catálogo`); process.exit(2); }
  const pagePath = join(dir, 'page.json');
  const page = existsSync(pagePath) ? (JSON.parse(readFileSync(pagePath, 'utf8')) as { page?: { brand?: unknown }; agent?: { trace?: { blocks?: TraceBlock[] } } }) : {};
  const brandFonts = !!page.page?.brand;
  const traced = page.agent?.trace?.blocks;
  return direction ? { direction, brandFonts, blocks: Array.isArray(traced) ? traceBlocks(traced) : directionBlocks(md) } : undefined;
}
const direction = wsDir ? workspaceDirection(wsDir) : undefined;
// El código de cada sección del agente: page.json no trae secciones en una corrida del agente, así que se lee del ws.
const sectionsDir = wsDir ? join(wsDir, 'src', 'sections') : '';
const sources = sectionsDir && existsSync(sectionsDir) ? Object.fromEntries(readdirSync(sectionsDir).filter((f) => /^\d{2}-.+\.tsx$/.test(f)).map((f) => [f.replace(/\.tsx$/, ''), readFileSync(join(sectionsDir, f), 'utf8')])) : undefined;
// Imágenes cuyo generador falló según page.json: solo turnos anteriores a la tool de imagen (ya no hay paso de slots).
function workspacePending(dir: string): string[] {
  const pagePath = join(dir, 'page.json');
  const declared = existsSync(pagePath) ? (JSON.parse(readFileSync(pagePath, 'utf8')) as { agent?: { images?: { pending?: unknown } } }).agent?.images?.pending : undefined;
  return Array.isArray(declared) ? declared.filter((p): p is string => typeof p === 'string') : [];
}
const pendingImages = wsDir ? workspacePending(wsDir) : [];
const report = pageSensors(measures, { ...(lang ? { lang } : {}), ...(align ? { align } : {}), ...(budget ? { motionBudget: Number(budget) } : {}), ...(plan !== undefined ? { plan } : {}), ...(direction ? { direction } : {}), ...(sources ? { sources } : {}), ...(pendingImages.length ? { pendingImages } : {}) }, wsDir ? emittedSections(wsDir) : []);
// direction.refs decide sobre el stream del agente, no sobre la página: solo con workspace y dirección.
const streamPath = wsDir ? join(wsDir, '.wt', 'agent-stream.ndjson') : '';
const refs = direction && existsSync(streamPath) ? directionRefDefects(readFileSync(streamPath, 'utf8'), direction.direction, direction.blocks, plan ? new Set(plan.sections.map((p) => p.slug)) : undefined) : undefined;
const total = report.defects.length + (refs?.defects.length ?? 0);
// Spec wa-sdk §5: hasta el paso 3 los sensores del SDK solo informan; no cuentan para el código de salida.
const wa = measured.wa && wsDir ? waSensors(measured.wa, readWaSdk(wsDir)) : undefined;
const json = flag('--json');
if (json) writeFileSync(json, `${JSON.stringify({ target, ...report, ...(refs ? { refs } : {}), ...(wa ? { wa: { defects: wa, measure: measured.wa } } : {}), measures }, null, 2)}\n`);
const checked = Object.entries(report.checked).map(([k, n]) => `${k}=${n}`).join(' ');
console.log(`${total ? 'FAIL' : 'PASS'} ${target} defectos=${total} (${checked}${refs ? ` direction.refs=${refs.read}/${refs.checked}` : ''})`);
for (const d of report.defects) console.log(`  [${d.owner}] ${d.field} ${d.section} @${d.viewport}: ${d.message}`);
for (const d of refs?.defects ?? []) console.log(`  [${d.severity}] direction.refs ${d.section}: ${d.message}`);
if (wa) console.log(`  wa-sdk (informe, no cuenta): ${wa.length} defecto(s), ${measured.wa!.links.length} CTA de WhatsApp, ${measured.wa!.clicks.length} clic(s)`);
for (const d of wa ?? []) console.log(`  [${d.owner}] ${d.field} ${d.section} (informe): ${d.message}`);
process.exitCode = total ? 1 : 0;
