// Migra un brand.json v1 a v2 y comprueba que no se mueve nada (brandpack-v2 PR #6). El mapeo es el de PAIRS de
// tests/brandpack-v2-reader.test.ts: accent, surface y tokens pasan a overrides, las palancas de forma a theme.scale y
// theme.roundness, fonts a theme.fonts, tokensDark a overridesDark, e inherit se descarta (el contrato lo cierra solo).
//   bun scripts/brandpack-migrate-v2.ts <carpeta-de-pack>...          comprueba (no escribe)
//   bun scripts/brandpack-migrate-v2.ts --write <carpeta-de-pack>...  reescribe brand.json solo si la hoja sale byte a byte igual

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityCss, parseBrandPack } from '../src/brand';
import { snapshotOf } from './brandpack-red';

type Obj = Record<string, unknown>;
export { isV1, migrateV1ToV2 } from '../src/theme/migrate-v1';
import { migrateV1ToV2 } from '../src/theme/migrate-v1';
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Diferencias entre lo que produce el pack v1 y su migración: hoja de identidad, y cada campo observable del snapshot
 * de la red (brandpack-red) salvo la herencia declarada, que v2 ya no tiene. Vacío = migración sin movimiento. */
export function equivalenceDiff(v1: Obj, v2: Obj): string[] {
  const diffs: string[] = [];
  const a = parseBrandPack(v1, { skipComponents: true });
  const b = parseBrandPack(v2, { skipComponents: true });
  if (identityCss(a) !== identityCss(b)) diffs.push('identityCss');
  const sa = snapshotOf(a) as Record<string, unknown> & { coverage: Obj };
  const sb = snapshotOf(b) as Record<string, unknown> & { coverage: Obj };
  // Lo que cambia a proposito: v2 no tiene inherit, y su contrato siempre cierra (missing vacio). `defined` (la identidad) debe
  // quedar igual; un v1 con inherit incompleto cerraba menos que su v2, y eso no es una diferencia de salida.
  if ((sb.coverage.missing as string[]).length) diffs.push('coverage.missing (v2 no cierra el contrato)');
  for (const k of Object.keys(sa)) {
    const x = k === 'coverage' ? sa.coverage.defined : sa[k];
    const y = k === 'coverage' ? sb.coverage.defined : sb[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(k);
  }
  if (JSON.stringify(v1.components) !== JSON.stringify(v2.components)) diffs.push('components (slugs)');
  if (JSON.stringify(v1.requires) !== JSON.stringify(v2.requires)) diffs.push('requires.ds');
  return diffs;
}

/** Migra y verifica; lanza con las diferencias si algo se mueve. */
export function migrateChecked(v1: Obj): Obj {
  const v2 = migrateV1ToV2(v1);
  if (v2 === v1) return v1;
  const diffs = equivalenceDiff(v1, v2);
  if (diffs.length) throw new Error(`migracion: ${String(v1.name)} no es equivalente (${diffs.join(', ')}); no se escribe`);
  return v2;
}

if (import.meta.main) {
  const write = process.argv.includes('--write');
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!dirs.length) throw new Error('uso: bun scripts/brandpack-migrate-v2.ts [--write] <carpeta-de-pack>...');
  for (const dir of dirs) {
    const file = join(dir, 'brand.json');
    const v1 = JSON.parse(readFileSync(file, 'utf8')) as Obj;
    const v2 = migrateChecked(v1);
    if (v2 === v1) { process.stdout.write(`${dir}: ya es v2\n`); continue; }
    if (write) writeFileSync(file, `${JSON.stringify(v2, null, 2)}\n`);
    process.stdout.write(`${dir}: ${write ? 'migrado' : 'migrable'} (diff vacio; ${Object.keys(isObj(v1.inherit) ? v1.inherit : {}).length} lineas de inherit descartadas)\n`);
  }
}
