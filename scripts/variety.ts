// Variedad entre N corridas del mismo brief sobre los JSON de page-sensors (--json): estructura, acento, display y
// cifras repetidas entre pares.
//   bun scripts/variety.ts <corrida.json> <corrida.json> [...] [--json out.json]
// El nombre de cada corrida es el del archivo. Sale 1 si algún par converge en algún eje.

import { basename } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { PageMeasure } from '../src/page-sensors';
import { runSignature, varietySensors } from '../src/variety';

const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');
const out = jsonAt >= 0 ? args[jsonAt + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith('--') && (jsonAt < 0 || i !== jsonAt + 1));
if (files.length < 2) { console.error('uso: bun scripts/variety.ts <corrida.json> <corrida.json> [...] [--json out.json]'); process.exit(2); }

const sigs = files.map((f) => {
  const m = (JSON.parse(readFileSync(f, 'utf8')) as { measures: PageMeasure[] }).measures[0];
  if (!m) { console.error(`${f}: sin measures (¿es un JSON de page-sensors --json?)`); process.exit(2); }
  return runSignature(basename(f, '.json'), m);
});
const report = varietySensors(sigs);
if (out) writeFileSync(out, `${JSON.stringify({ sigs, ...report }, null, 2)}\n`);
const counts = Object.entries(report.converged).map(([k, n]) => `${k}=${n}/${report.pairs}`).join(' ');
console.log(`${report.defects.length ? 'CONVERGE' : 'VARÍA'} corridas=${sigs.length} (${counts})`);
for (const d of report.defects) console.log(`  ${d.field} ${d.section}: ${d.actual}`);
process.exitCode = report.defects.length ? 1 : 0;
