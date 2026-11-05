// Partes del skill que dependen de la marca de la petición, no del pin: el skill se publica una vez por pin y se
// copia al workspace, así que la marca se escribe encima después de la copia. Antes de pisar un archivo se guarda
// la versión del pin en `.pin/`, y sin marca se restaura: un follow-up sin marca vuelve al skill del pin, no a un
// skill sin colores.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BRAND_VARIANTS_FILE = 'references/components/brand-variants.md';
export const BRAND_COLORS_FILE = 'references/foundations/colors.md';
export const BRAND_LOGOS_FILE = 'references/assets/logos.md';
const INDEX_FILE = 'references/components/index.md';
const PIN_DIR = '.pin';
// Un archivo que el pin no trae se recuerda como ausente para borrarlo al restaurar.
const ABSENT = '.absent';
const ROW = '| Variantes de la marca | las que declara el brand pack de esta página | `brand-variants.md` |';
// La fila va al final de la tabla del índice, que termina antes de "## Reglas universales".
const TABLE_END = '\n\n## Reglas universales';

export interface BrandSkillFiles { colorsMd?: string; logosMd?: string; variantsMd?: string }

/** index.md con la fila de variantes de marca. Idempotente. */
export function withBrandVariantsRow(index: string): string {
  if (index.includes(ROW)) return index;
  const at = index.indexOf(TABLE_END);
  return at < 0 ? `${index}\n${ROW}\n` : `${index.slice(0, at)}\n${ROW}${index.slice(at)}`;
}

function pinCopy(skillDir: string, rel: string): string {
  return join(skillDir, PIN_DIR, rel);
}

/** Guarda la versión del pin una sola vez: la segunda marca no puede guardar la primera como si fuera el pin. */
function savePin(skillDir: string, rel: string): void {
  const saved = pinCopy(skillDir, rel);
  if (existsSync(saved) || existsSync(saved + ABSENT)) return;
  mkdirSync(dirname(saved), { recursive: true });
  const live = join(skillDir, rel);
  if (existsSync(live)) copyFileSync(live, saved);
  else writeFileSync(saved + ABSENT, '');
}

function restorePin(skillDir: string, rel: string): void {
  const saved = pinCopy(skillDir, rel);
  const live = join(skillDir, rel);
  if (existsSync(saved)) copyFileSync(saved, live);
  else if (existsSync(saved + ABSENT)) rmSync(live, { force: true });
}

function put(skillDir: string, rel: string, content: string | undefined): void {
  if (content === undefined) return restorePin(skillDir, rel);
  savePin(skillDir, rel);
  mkdirSync(dirname(join(skillDir, rel)), { recursive: true });
  writeFileSync(join(skillDir, rel), content);
}

/** Aplica la marca de la petición al skill montado en `skillDir`; sin partes, lo deja como lo publicó el pin. */
export function writeBrandSkill(skillDir: string, parts: BrandSkillFiles): void {
  put(skillDir, BRAND_COLORS_FILE, parts.colorsMd);
  put(skillDir, BRAND_LOGOS_FILE, parts.logosMd);
  put(skillDir, BRAND_VARIANTS_FILE, parts.variantsMd);
  const index = join(skillDir, INDEX_FILE);
  if (!existsSync(index) && !existsSync(pinCopy(skillDir, INDEX_FILE))) return;
  if (!parts.variantsMd) return restorePin(skillDir, INDEX_FILE);
  savePin(skillDir, INDEX_FILE);
  writeFileSync(index, withBrandVariantsRow(readFileSync(pinCopy(skillDir, INDEX_FILE), 'utf8')));
}
