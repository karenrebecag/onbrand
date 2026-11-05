// Banco fijo de sensores (Q5): cada fix se mide contra los mismos 3 briefs (bench/briefs.json) y no contra una
// sola página. Recibe un manifiesto con una salida por brief y herramienta, mide cada una con page-sensors
// (1440 y 375), corre content-sensors y la riqueza por forma, y da una tabla comparable entre corridas.
//   bun scripts/bench.ts <manifiesto.json> [--json out.json]
// Manifiesto: [{ "brief": "acme", "tool": "agent", "target": "<ws | dir | html | url>", "message": "<resumen.txt>" }]
// target y message son relativos al manifiesto. Sin message, S11 no se afirma (queda "-"). Un follow-up lleva
// "before": el --json de page-sensors de la versión anterior, para que S11 pida declarar solo lo nuevo.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contentSensors } from '../src/content-sensors';
import { lintRaw, sectionFiles } from '../src/lint-raw';
import type { Lang } from '../src/foreign-text';
import type { PageMeasure, SensorDefect } from '../src/page-sensors';
import { richness } from '../src/richness';

interface Run { brief: string; tool: string; target: string; message?: string; before?: string }
interface Row { brief: string; tool: string; page: number; content: number; disclosed: string; raw: string; withVisual: string; interactive: number; fields: Record<string, number> }

const args = process.argv.slice(2);
const manifestPath = args[0] && resolve(args[0]);
if (!manifestPath) { console.error('uso: bun scripts/bench.ts <manifiesto.json> [--json out.json]'); process.exit(2); }
const briefs = JSON.parse(readFileSync(join(import.meta.dir, '..', 'bench', 'briefs.json'), 'utf8')) as Record<string, { lang: Lang; brief: string }>;
const runs = JSON.parse(readFileSync(manifestPath, 'utf8')) as Run[];
const base = dirname(manifestPath);
const at = (p: string): string => (/^https?:\/\//.test(p) ? p : resolve(base, p));
const tmp = mkdtempSync(join(tmpdir(), 'wt-bench-'));

const rows: Row[] = [];
for (const [i, r] of runs.entries()) {
  const b = briefs[r.brief];
  if (!b) { console.error(`brief desconocido: ${r.brief} (bench/briefs.json tiene ${Object.keys(briefs).join(', ')})`); process.exit(2); }
  const out = join(tmp, `${i}.json`);
  // page-sensors sale 1 si hay defectos: eso es dato, no fallo del banco.
  const p = Bun.spawnSync(['bun', join(import.meta.dir, 'page-sensors.ts'), at(r.target), '--lang', b.lang, '--json', out], { stdout: 'ignore', stderr: 'pipe' });
  let report: { defects: SensorDefect[]; measures: PageMeasure[] };
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { console.error(`${r.brief}/${r.tool}: page-sensors no midió ${r.target}\n${p.stderr.toString().slice(-400)}`); process.exit(1); }
  const wide = report.measures[0];
  const message = r.message ? readFileSync(at(r.message), 'utf8') : undefined;
  const before = r.before ? (JSON.parse(readFileSync(at(r.before), 'utf8')) as { measures: PageMeasure[] }).measures[0] : undefined;
  const content = contentSensors(wide, { lang: b.lang, brief: b.brief, ...(message !== undefined ? { message } : {}), ...(before ? { before } : {}) });
  const rich = richness(wide);
  // lint.raw solo sobre un workspace nuestro: v0, Stitch o Figma Make llegan como HTML y no tienen src/sections.
  const ws = /^https?:\/\//.test(r.target) ? undefined : at(r.target);
  const raw = ws && existsSync(join(ws, 'src', 'sections')) ? lintRaw(sectionFiles(ws)) : undefined;
  const fields: Record<string, number> = {};
  for (const d of [...report.defects, ...content]) fields[d.field] = (fields[d.field] ?? 0) + 1;
  for (const h of raw ?? []) fields[`lint.raw.${h.kind}`] = (fields[`lint.raw.${h.kind}`] ?? 0) + 1;
  rows.push({
    brief: r.brief,
    tool: r.tool,
    page: report.defects.length,
    content: content.length,
    raw: raw ? String(raw.length) : '-',
    disclosed: message === undefined ? '-' : content.some((d) => d.field === 'facts.disclosed') ? 'no' : 'sí',
    withVisual: `${rich.withVisual}/${rich.sections}`,
    interactive: rich.interactive,
    fields,
  });
}

console.log('| brief | herramienta | page | content | lint.raw | declara | con visual | interactivos | campos |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.brief} | ${r.tool} | ${r.page} | ${r.content} | ${r.raw} | ${r.disclosed} | ${r.withVisual} | ${r.interactive} | ${Object.entries(r.fields).map(([k, n]) => `${k} ${n}`).join(', ') || '-'} |`);
const json = args.indexOf('--json');
if (json >= 0 && args[json + 1]) writeFileSync(args[json + 1], `${JSON.stringify(rows, null, 2)}\n`);
