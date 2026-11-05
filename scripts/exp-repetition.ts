// Resume la repetición entre secciones de páginas completas (src/exp/repetition.ts).
//   bun scripts/exp-repetition.ts <dir> [--pattern '^(?<business>[a-z0-9-]+?)-(?<cond>[a-z0-9]+)-(?<rep>\d+)\.json$']
// Lee <dir>/<negocio>-<condición>-<n>.json (página `{ sections: [...] }`), imprime por corrida y por
// condición: titulares duplicados entre secciones y pares de secciones que comparten un 4-grama.
// Deja <dir>/REPETITION.md.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repetitionOf, type Repetition } from '../src/exp/repetition';
import { stat } from '../src/exp/layout-metrics';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) throw new Error('uso: bun scripts/exp-repetition.ts <dir>');
const patIdx = args.indexOf('--pattern');
const NAME = new RegExp(patIdx >= 0 ? args[patIdx + 1] : '^(?<business>[a-z0-9-]+?)-(?<cond>[a-z0-9]+)-(?<rep>\\d+)\\.json$');

interface Row { file: string; business: string; cond: string; rep: number; r: Repetition }
const rows: Row[] = [];
const skipped: string[] = [];
for (const file of readdirSync(dir).sort()) {
  const m = NAME.exec(file);
  if (!m?.groups) continue;
  const page = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { sections?: unknown[] };
  if (!page.sections?.length) {
    skipped.push(file);
    continue;
  }
  rows.push({ file, business: m.groups.business, cond: m.groups.cond, rep: Number(m.groups.rep), r: repetitionOf(page.sections) });
}

const conds = [...new Set(rows.map((x) => x.cond))];
const f = (x: number): string => (Number.isNaN(x) ? '-' : x.toFixed(2));
const summary = conds.map((cond) => {
  const rs = rows.filter((x) => x.cond === cond);
  const dup = stat(rs.map((x) => x.r.duplicateTitles.length));
  const ratio = stat(rs.map((x) => (x.r.pairs ? x.r.overlappingPairs / x.r.pairs : 0)));
  const shared = stat(rs.map((x) => x.r.sharedNgrams.length));
  return `| ${cond} | ${rs.length} | ${f(dup.mean)} (${dup.min}-${dup.max}) | ${f(ratio.mean)} (${f(ratio.min)}-${f(ratio.max)}) | ${f(shared.mean)} (${shared.min}-${shared.max}) |`;
});

const md = [
  `# Repetición entre secciones (${rows.length} páginas${skipped.length ? `, ${skipped.length} sin secciones: ${skipped.join(', ')}` : ''})`,
  '',
  '| condición | páginas | titulares duplicados por página (media, rango) | pares de secciones con 4-grama compartido / pares (media) | 4-gramas compartidos por página |',
  '|---|---|---|---|---|',
  ...summary,
  '',
  'Un titular duplicado = el mismo texto (normalizado) como título en dos secciones. Un par solapado = dos secciones distintas comparten al menos una secuencia de 4 palabras.',
  '',
  '| página | secciones | titulares duplicados | pares solapados | 4-gramas compartidos (muestra) |',
  '|---|---|---|---|---|',
  ...rows.map((x) => `| ${x.file} | ${x.r.sections} | ${x.r.duplicateTitles.join('; ') || '-'} | ${x.r.overlappingPairs}/${x.r.pairs} | ${x.r.sharedNgrams.slice(0, 4).join('; ')}${x.r.sharedNgrams.length > 4 ? ` (+${x.r.sharedNgrams.length - 4})` : ''} |`),
  '',
].join('\n');
writeFileSync(join(dir, 'REPETITION.md'), md);
console.log(md);
