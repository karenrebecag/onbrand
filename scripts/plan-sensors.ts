// Sensores del plan sobre un corpus de páginas ya medidas: secciones contra el brief (plan.roles) y variedad
// entre briefs distintos (variety.sequence, variety.structure).
//   bun scripts/plan-sensors.ts manifest.json
// manifest: [{ "id": "wt-acme", "brief": "…" | "briefFile": "brief.txt", "sensors": "page-sensors.json" }]
// `sensors` es la salida de `page-sensors --json` (toma la medida a 1440) o una medida suelta del navegador
// (el preview de v0 medido con page-sensors.browser.js). El brief va aparte porque el workspace no lo guarda:
// request.json se sobrescribe con el prompt del repair. Sale 1 si hay defectos.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { planRoles, varietyPairs, type PlannedPage } from '../src/plan-sensors';
import type { PageMeasure } from '../src/page-sensors';

interface Entry { id: string; brief?: string; briefFile?: string; sensors: string }

const file = process.argv[2];
if (!file) { console.error('uso: bun scripts/plan-sensors.ts manifest.json'); process.exit(2); }
const base = dirname(resolve(file));
const entries = JSON.parse(readFileSync(file, 'utf8')) as Entry[];
const pages: PlannedPage[] = entries.map((e) => {
  const brief = e.brief ?? (e.briefFile ? readFileSync(resolve(base, e.briefFile), 'utf8') : undefined);
  if (!brief) { console.error(`${e.id}: falta brief o briefFile`); process.exit(2); }
  const raw = JSON.parse(readFileSync(resolve(base, e.sensors), 'utf8')) as { measures?: PageMeasure[] } & PageMeasure;
  return { id: e.id, brief, measure: raw.measures ? raw.measures[0] : raw };
});
const defects = [...pages.flatMap(planRoles), ...varietyPairs(pages)];
console.log(`${defects.length ? 'FAIL' : 'PASS'} ${pages.length} páginas defectos=${defects.length}`);
for (const d of defects) console.log(`  [${d.owner}] ${d.field} ${d.page}: ${d.message}`);
process.exitCode = defects.length ? 1 : 0;
