// preview.runtime sobre un preview vivo (vite dev del workspace, no dist):
//   bun scripts/preview-runtime.ts <url> <workspace> [--json out.json]
// Carga a la vez 1440 y 375 y los marcos del lienzo (1280 y 390), una página por ancho (src/preview-viewport.ts), recorre la página, junta errores y compara los [data-wt-slug] montados con las secciones
// del workspace (src/sections/NN-rol.tsx). En cada ancho mide desborde horizontal y CTA partido; a 1440, el contraste WCAG del texto y pulsa los botones de las secciones que cambió la versión, y guarda el DOM y los textos de la versión (src/dom-snapshot.ts, preserve.text). Sale 1 si hay defectos y 2 si el propio check no pudo correr.

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { changedSlugs } from '../src/interaction-sensor';
import { checkViewport, type ViewportCheck, type ViewportContext } from '../src/preview-viewport';
import { previewCheckWidths } from '../src/render-review';
import { runtimeDefects } from '../src/runtime-sensors';
import { turnScope } from '../src/scope-sensor';
import { shotStore } from '../src/shot-store';

const [url, ws] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--json' && all[i - 1] !== '--log' && all[i - 1] !== '--viewport');
if (!url || !ws) { console.error('uso: bun scripts/preview-runtime.ts <url> <workspace> [--json out.json] [--log mensaje.ndjson] [--viewport WxH]'); process.exit(2); }
const jsonAt = process.argv.indexOf('--json');
const logAt = process.argv.indexOf('--log');
// Q6: el ancho que la persona mira, además de los fijos; sin él (o igual a uno fijo) no cambia nada.
const personWidth = Number(/^(\d+)x\d+$/.exec(process.argv[process.argv.indexOf('--viewport') + 1] ?? '')?.[1]);
const widths = previewCheckWidths(personWidth);
const expected = readdirSync(join(resolve(ws), 'src', 'sections')).filter((f) => /^\d+-.+\.tsx$/.test(f)).map((f) => f.replace(/\.tsx$/, '')).sort();
// La versión ya está commiteada: lo que cambió es HEAD contra su commit anterior. Sin anterior, toda la página.
const diff = spawnSync('git', ['-C', resolve(ws), 'diff', '--name-only', 'HEAD~1', 'HEAD', '--', 'src/sections'], { encoding: 'utf8' });
const changed = diff.status === 0 ? changedSlugs(diff.stdout.split('\n')) : expected;
const rev = (r: string): string | null => {
  const x = spawnSync('git', ['-C', resolve(ws), 'rev-parse', '--verify', '-q', r], { encoding: 'utf8' });
  return x.status === 0 ? x.stdout.trim() : null;
};
const head = rev('HEAD');
const headShots = head ? shotStore(resolve(ws), head) : null;
// Alcance del turno (secciones elegidas): el diff es contra el primer padre, como el turno de Make.
const prev = rev('HEAD~1');
const scope = head ? turnScope(resolve(ws), prev, head, logAt > 0 ? process.argv[logAt + 1] : undefined) : null;
const prevTexts = prev ? shotStore(resolve(ws), prev) : null;

// Un crash saldría con 1, el mismo código que "hay defectos": el llamador buscaría un JSON que no existe.
const fail = (e: unknown): never => {
  console.error(`preview-runtime: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
};
const ctx: ViewportContext = { url, ws: resolve(ws), changed, headShots, scope, prev, head, prevTexts };
const browser = await chromium.launch({ headless: true }).catch(fail);
let failed: unknown;
let checks: ViewportCheck[] = [];
try {
  // Los anchos son independientes: en paralelo, el check dura lo que el más lento y no la suma.
  checks = await Promise.all(widths.map((v) => checkViewport(browser, v, ctx)));
} catch (e) {
  failed = e ?? new Error('error sin detalle');
} finally {
  await browser.close();
}
if (failed) fail(failed);
const mounted = new Map(checks.map((c) => [c.viewport, c.mounted]));
// Mismo orden que en serie (por sensor y, dentro, por ancho): el reporte no depende de qué página terminó primero.
const defects = [
  ...runtimeDefects(checks.flatMap((c) => c.issues), expected, mounted),
  ...(['layout', 'contrast', 'interaction', 'scoped'] as const).flatMap((k) => checks.flatMap((c) => c[k])),
];
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify({ url, expected, mounted: Object.fromEntries(mounted), defects }, null, 2)}\n`);
console.log(`${defects.length ? 'FAIL' : 'PASS'} ${url} defectos=${defects.length}`);
for (const d of defects) console.log(`  [${d.owner}] ${d.kind} ${d.slug ?? '-'} @${d.viewport}: ${d.message.split('\n')[0].slice(0, 160)}`);
process.exitCode = defects.length ? 1 : 0;
