// Resume las corridas del experimento "guía de layout sí/no" (src/exp/layout-metrics.ts).
//   bun scripts/exp-layout-guides.ts <dir>
// Lee <dir>/<negocio>-<guide|noguide>-<n>.json (página `{ sections: [LayoutSection] }`; las escribía
// `scripts/v0layout.ts --json`, archivado con el camino composer props/JSON: hoy solo analiza corridas ya guardadas) y, si existe, <mismo nombre>.gate.json con `{ ok: boolean }` del
// render-gate. Imprime la tabla por condición y la deja en <dir>/REPORT.md.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomsOf, renderSummary, skeletonOf, summarize, treeDistance, type Run } from '../src/exp/layout-metrics';

/** Árbol inyectado en la condición guide1: el bloque json de <dir>/guides1-<negocio>/layout-<rol>.md. */
function injectedTree(dir: string, business: string, role: string): unknown {
  const p = join(dir, `guides1-${business}`, `layout-${role}.md`);
  if (!existsSync(p)) return undefined;
  const m = /```json\n([\s\S]*?)\n```/.exec(readFileSync(p, 'utf8'));
  return m ? (JSON.parse(m[1]) as unknown) : undefined;
}

const dir = process.argv[2];
if (!dir) throw new Error('uso: bun scripts/exp-layout-guides.ts <dir>');

const NAME = /^(?<business>[a-z0-9-]+?)-(?<cond>noguide|guide1|guide|twostepguide1|twostep)-(?<rep>\d+)\.json$/;
const runs: Run[] = [];
const rows: string[] = [];
for (const file of readdirSync(dir).sort()) {
  const m = NAME.exec(file);
  if (!m?.groups) continue;
  const page = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { sections?: unknown[] };
  const section = page.sections?.[0];
  if (!section) {
    rows.push(`| ${file} | sin sección | | | | |`);
    continue;
  }
  const gatePath = join(dir, file.replace(/\.json$/, '.gate.json'));
  const gate = existsSync(gatePath) ? (JSON.parse(readFileSync(gatePath, 'utf8')) as { ok?: boolean }) : undefined;
  const role = String((section as Record<string, unknown>).role ?? 'features');
  const injected = /guide1$/.test(m.groups.cond) ? injectedTree(dir, m.groups.business, role) : undefined;
  const run: Run = { business: m.groups.business, cond: m.groups.cond, rep: Number(m.groups.rep), section, ...(gate?.ok !== undefined ? { renderOk: gate.ok } : {}), ...(injected !== undefined ? { injected } : {}) };
  runs.push(run);
  rows.push(`| ${file} | ${atomsOf(section).join(', ') || '-'} | ${skeletonOf(section).filter((t) => /:(stack|grid|split|cluster)/.test(t)).map((t) => t.split(':').slice(1).join(':')).join(' > ')} | ${gate?.ok === undefined ? 'sin medir' : gate.ok ? 'ok' : 'roto'} | ${String((section as Record<string, unknown>)['x-pattern'] ?? '-')} | ${injected === undefined ? '-' : treeDistance(section, injected).toFixed(2)} |`);
}

const summary = summarize(runs);
const md = [
  `# Experimento: guía de layout sí/no (${runs.length} corridas)`,
  '',
  renderSummary(summary),
  '',
  'Separación = distancia entre negocios / distancia dentro del mismo negocio. La guía da variedad solo si supera claramente 1.',
  '',
  '| corrida | átomos | esqueleto de layout | render-gate | patrón declarado | dist. a la guía |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
writeFileSync(join(dir, 'REPORT.md'), md);
console.log(md);
