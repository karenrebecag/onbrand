import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeBrandDir, applyBrand } from '../src/brand';
import { readBrandPackItem } from '../src/brand-registry';
import { setActiveProfile } from '../src/profile';

const BRANDS = join(import.meta.dir, '..', 'brands');

// El clon trae su molde: si el ejemplo deja de validar, quien lo copie arranca con un pack que no se publica.
describe('brand packs del repo', () => {
  test('el base neutral y el ejemplo pasan la misma validación que al publicar', () => {
    expect(readBrandPackItem('base', join(BRANDS, 'brand-pack')).files.map((f) => f.path)).toEqual(['brand.json']);
    expect(readBrandPackItem('ejemplo', join(BRANDS, 'brand-pack-ejemplo')).files.map((f) => f.path)).toEqual(['DESIGN.md', 'brand.json', 'facts.json', 'logo.svg']);
  });

  test('el ejemplo se aplica a un workspace: hoja del pack, DESIGN.md y logo', () => {
    const out = mkdtempSync(join(tmpdir(), 'wt-brands-'));
    mkdirSync(join(out, 'src'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html lang="es" data-theme="light" data-accent="orange"><body></body></html>');
    applyBrand(out, join(BRANDS, 'brand-pack-ejemplo'));
    expect(readFileSync(join(out, 'src', 'identity.css'), 'utf8')).toStartWith('/* brand-pack: Ejemplo */');
    expect(readFileSync(join(out, 'DESIGN.md'), 'utf8')).toBe(readFileSync(join(BRANDS, 'brand-pack-ejemplo', 'DESIGN.md'), 'utf8'));
    expect(existsSync(join(out, 'public', 'brand', 'logo.svg'))).toBe(true);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).not.toContain('data-accent');
  });

  test('el base sale de la carpeta del perfil: core el del repo, un perfil externo la suya, WT_BRANDS_ROOT gana', () => {
    const saved = { pack: process.env.WT_BRAND_PACK, root: process.env.WT_BRANDS_ROOT };
    delete process.env.WT_BRAND_PACK;
    delete process.env.WT_BRANDS_ROOT;
    try {
      expect(activeBrandDir()).toBe(join(BRANDS, 'brand-pack'));
      setActiveProfile({ name: 'ejemplo', defaults: { brandsRoot: join(BRANDS, '..', 'packs-ejemplo') } });
      expect(activeBrandDir()).toBe(join(BRANDS, '..', 'packs-ejemplo', 'brand-pack'));
      process.env.WT_BRANDS_ROOT = '/otra/carpeta';
      expect(activeBrandDir()).toBe(join('/otra/carpeta', 'brand-pack'));
    } finally {
      setActiveProfile(undefined);
      for (const [k, v] of [['WT_BRAND_PACK', saved.pack], ['WT_BRANDS_ROOT', saved.root]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
