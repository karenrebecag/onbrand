import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexReference } from '../src/ds-skill-agent';
import { BRAND_COLORS_FILE, BRAND_LOGOS_FILE, BRAND_VARIANTS_FILE, writeBrandSkill } from '../src/skill-brand';

function pinSkill(): { dir: string; index: string; colors: string } {
  const dir = mkdtempSync(join(tmpdir(), 'skill-brand-'));
  mkdirSync(join(dir, 'references', 'components'), { recursive: true });
  mkdirSync(join(dir, 'references', 'foundations'), { recursive: true });
  const index = indexReference([]);
  writeFileSync(join(dir, 'references', 'components', 'index.md'), index);
  writeFileSync(join(dir, BRAND_COLORS_FILE), '# Colores del pin\n');
  return { dir, index, colors: '# Colores del pin\n' };
}
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
const INDEX = 'references/components/index.md';

// El skill es del pin y la marca es de la petición: un follow-up sin marca vuelve al skill del pin, sin heredar la
// marca anterior y sin quedarse sin los colores del pin.
test('la marca pisa colores, logos y variantes; sin marca vuelve exactamente al skill del pin', () => {
  const { dir, index, colors } = pinSkill();

  writeBrandSkill(dir, { colorsMd: '# Colores de Acme\n', logosMd: '# Logos de Acme\n', variantsMd: '# Variantes de Acme\n' });
  writeBrandSkill(dir, { colorsMd: '# Colores de Acme\n', logosMd: '# Logos de Acme\n', variantsMd: '# Variantes de Acme\n' });
  expect(read(dir, BRAND_COLORS_FILE)).toBe('# Colores de Acme\n');
  expect(read(dir, BRAND_LOGOS_FILE)).toBe('# Logos de Acme\n');
  expect(read(dir, BRAND_VARIANTS_FILE)).toBe('# Variantes de Acme\n');
  expect(read(dir, INDEX).match(/`brand-variants\.md`/g)?.length).toBe(1);
  expect(read(dir, INDEX).indexOf('`brand-variants.md`')).toBeLessThan(read(dir, INDEX).indexOf('## Reglas universales'));

  writeBrandSkill(dir, {});
  expect(read(dir, BRAND_COLORS_FILE)).toBe(colors);
  expect(existsSync(join(dir, BRAND_LOGOS_FILE))).toBe(false);
  expect(existsSync(join(dir, BRAND_VARIANTS_FILE))).toBe(false);
  expect(read(dir, INDEX)).toBe(index);
});

test('una segunda marca no guarda la primera como si fuera el pin', () => {
  const { dir, colors } = pinSkill();
  writeBrandSkill(dir, { colorsMd: '# Colores de Acme\n' });
  writeBrandSkill(dir, { colorsMd: '# Colores de Nimbus\n' });
  expect(read(dir, BRAND_COLORS_FILE)).toBe('# Colores de Nimbus\n');
  writeBrandSkill(dir, {});
  expect(read(dir, BRAND_COLORS_FILE)).toBe(colors);
});
