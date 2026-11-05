import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandPackErrors, loadBrandPack } from '../src/brand';
import { checkPackDesign, packDesignFrontmatter } from '../src/identity-ephemeral';


const REPO = join(import.meta.dir, '..');
const EJEMPLO = join(REPO, 'brands', 'brand-pack-ejemplo');

function pack(from = EJEMPLO): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'wt-check-brand-')), 'brand-pack-mia');
  cpSync(from, dir, { recursive: true });
  return dir;
}
const check = (...args: string[]) => spawnSync('bun', [join(REPO, 'scripts', 'check-brand.ts'), ...args], { encoding: 'utf8' });

describe('check-brand', () => {
  // loadBrandPack corta en el primero; quien arma una marca necesita la lista entera para arreglarla de una vez.
  test('reporta los errores de todos los archivos del pack, no solo el primero', () => {
    const dir = pack();
    writeFileSync(join(dir, 'facts.json'), JSON.stringify({ domain: 42 }));
    writeFileSync(join(dir, 'DESIGN.md'), '# sin frontmatter\n');
    const errors = brandPackErrors(dir);
    expect(errors.map((e) => e.split(':')[0])).toEqual(['brand-pack-mia/facts.json', 'brand-pack-mia/DESIGN.md']);
    expect(() => loadBrandPack(dir)).toThrow(/^brand-pack-mia\/facts\.json: [\s\S]*brand-pack-mia\/DESIGN\.md: /);
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('2 errores');
  });

  test('el frontmatter generado valida para un pack con colores propios y para uno solo preset', () => {
    for (const dir of [EJEMPLO, join(REPO, 'brands', 'brand-pack')]) {
      const { brand } = loadBrandPack(dir);
      expect(checkPackDesign(brand, `${packDesignFrontmatter(brand)}\n## Brand & Style\n\n## Colors\n\n## Typography\n`)).toEqual([]);
    }
  });

  test('--write-design reescribe solo el frontmatter, conserva la prosa y deja el pack válido', () => {
    const dir = pack();
    const prose = readFileSync(join(dir, 'DESIGN.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '');
    const brand = JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8'));
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...brand, overrides: { ...brand.overrides, '--accent-foreground': '#fffffe' } }));
    expect(check(dir).status).toBe(1);
    const r = check(dir, '--write-design');
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, 'DESIGN.md'), 'utf8');
    expect(md).toContain("on-primary: '#fffffe'");
    expect(md.endsWith(prose)).toBe(true);
  });

  test('--write-design crea DESIGN.md con sus secciones si el pack no trae uno', () => {
    const dir = pack();
    rmSync(join(dir, 'DESIGN.md'));
    expect(check(dir, '--write-design').status).toBe(0);
    expect(readFileSync(join(dir, 'DESIGN.md'), 'utf8')).toContain('## Typography');
  });
});
