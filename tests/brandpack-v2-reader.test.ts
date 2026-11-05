import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBrand, BRAND_PACK_V2_KEYS, brandCoverage, identityCss, parseBrandPack, THEME_KEYS, withThemeParams } from '../src/brand';

const BRANDS = join(import.meta.dir, '..', 'brands');
type Schema = { properties: Record<string, Schema>; required?: string[] };
const schema = JSON.parse(readFileSync(join(BRANDS, 'brandpack-v2.schema.json'), 'utf8')) as Schema;
const sorted = (l: readonly string[]) => [...l].sort();

// Pares v1 -> v2 de la red (scripts/brandpack-red.ts brandpackCases): cada canal de v1 en su lugar de v2.
const PAIRS: [string, unknown, unknown][] = [
  ['preset', { name: 'Preset', accent: 'blue' }, { name: 'Preset', theme: { preset: 'blue' } }],
  ['acento y superficie propios con oscuro',
    { name: 'Propio', accent: { base: '#1f4d3a', strong: '#163829', subtle: 'rgb(31 77 58 / 0.1)', foreground: '#ffffff' }, surface: { background: '#fbfaf7', foreground: '#14130f' }, tokensDark: { '--background': '#12130f', '--foreground': '#f4f2ec', '--accent': '#7fc8a4', '--accent-foreground': '#0d1a13' } },
    { name: 'Propio', overrides: { '--accent': '#1f4d3a', '--accent-strong': '#163829', '--accent-subtle': 'rgb(31 77 58 / 0.1)', '--accent-foreground': '#ffffff', '--background': '#fbfaf7', '--foreground': '#14130f' }, overridesDark: { '--background': '#12130f', '--foreground': '#f4f2ec', '--accent': '#7fc8a4', '--accent-foreground': '#0d1a13' } }],
  ['palancas de forma', { name: 'Forma', accent: 'neutral', tokens: { '--scaling': '1.15', '--radius-factor': '1.6', '--text-5xl': '5.5rem' } }, { name: 'Forma', theme: { scale: 1.15, roundness: 1.6 }, overrides: { '--text-5xl': '5.5rem' } }],
];

describe('brand.json v2 detrás del lector dual', () => {
  test('el schema v2 declara las claves que acepta el parser', () => {
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(BRAND_PACK_V2_KEYS));
    expect(sorted(Object.keys(schema.properties.theme.properties))).toEqual(sorted(THEME_KEYS));
    expect(schema.required).toEqual(['name']);
  });

  test('un pack v2 emite la misma hoja que su v1 y cierra el contrato sin inherit', () => {
    for (const [what, v1, v2] of PAIRS) {
      const a = parseBrandPack(v1, { skipComponents: true });
      const b = parseBrandPack(v2, { skipComponents: true });
      expect(identityCss(b), what).toBe(identityCss(a));
      expect(brandCoverage(b).missing, what).toEqual([]);
    }
    // Base: 93 líneas de inherit en v1 (brands/brand-pack/brand.json) contra solo el nombre en v2.
    expect(brandCoverage(parseBrandPack({ name: 'Base' }, { skipComponents: true })).missing).toEqual([]);
  });

  test('v1 sigue cargando y una mezcla de las dos formas falla con su motivo', () => {
    expect(parseBrandPack(JSON.parse(readFileSync(join(BRANDS, 'brand-pack-ejemplo', 'brand.json'), 'utf8')), { skipComponents: true }).name).toBe('Ejemplo');
    expect(() => parseBrandPack({ name: 'X', accent: 'blue', theme: { preset: 'blue' } })).toThrow('mezcla v1 ("accent") y v2 ("theme")');
    expect(() => parseBrandPack({ name: 'X', overrides: { '--accent': '#111111' } })).toThrow('requiere --accent, --accent-strong y --accent-subtle');
    expect(() => parseBrandPack({ name: 'X', theme: { preset: 'blue' }, overrides: { '--accent': '#111111', '--accent-strong': '#000000', '--accent-subtle': '#eeeeee' } })).toThrow('se contradicen');
    expect(() => parseBrandPack({ name: 'X', overrides: { '--no-existe': '1' } })).toThrow('overrides."--no-existe" no es un token del contrato');
    expect(() => parseBrandPack({ name: 'X', theme: { scale: 0 } })).toThrow('theme.scale debe ser un número mayor que 0');
  });

  test('el tema del panel se fusiona con la marca: lo que el panel no expone se queda y el acento nuevo saca al viejo', () => {
    const ejemplo = { name: 'E', theme: { preset: 'violet', fonts: { display: 'Fraunces' } }, overrides: { '--background': '#fbfaf7' }, overridesDark: { '--background': '#12130f', '--accent': '#a78bff' } };
    // El panel cambia esquinas y preset: fuentes, superficie y oscuro de la marca siguen; el --accent oscuro viejo se va.
    expect(withThemeParams(ejemplo, { theme: { preset: 'blue', roundness: 1.5 } })).toEqual({ name: 'E', theme: { preset: 'blue', fonts: { display: 'Fraunces' }, roundness: 1.5 }, overrides: { '--background': '#fbfaf7' }, overridesDark: { '--background': '#12130f' } });
    // Un acento propio quita el preset de la marca (si no, parseBrandPackV2 los rechaza por contradecirse).
    const own = { '--accent': '#1f4d3a', '--accent-strong': '#163829', '--accent-subtle': 'rgb(31 77 58 / 0.1)' };
    expect(withThemeParams(ejemplo, { overrides: own })).toEqual({ name: 'E', theme: { fonts: { display: 'Fraunces' } }, overrides: { '--background': '#fbfaf7', ...own }, overridesDark: { '--background': '#12130f' } });
    // El panel reenvía el acento que la marca ya tenía: no es un acento nuevo y el oscuro de la marca se queda.
    const withDark = { name: 'A', overrides: { ...own, '--accent-foreground': '#ffffff' }, overridesDark: { '--accent': '#7fc8a4' } };
    expect(withThemeParams(withDark, { theme: { roundness: 1.2 }, overrides: own })).toEqual({ ...withDark, theme: { roundness: 1.2 } });
    expect(withThemeParams({ name: 'P', theme: { preset: 'violet' }, overridesDark: { '--accent': '#a78bff' } }, { theme: { preset: 'violet' } }).overridesDark).toEqual({ '--accent': '#a78bff' });
    // Un pack v1 se lee en v2 antes de fusionar: su superficie sobrevive y no queda mezclado.
    expect(withThemeParams({ name: 'V1', accent: 'orange', surface: { background: '#fbfaf7' } }, { theme: { scale: 1.1 } })).toEqual({ name: 'V1', theme: { preset: 'orange', scale: 1.1 }, overrides: { '--background': '#fbfaf7' } });
    expect(() => withThemeParams(ejemplo, { name: 'otra' })).toThrow('clave desconocida "name"');
  });

  test('theme.colorMode fija el modo por defecto del <html> al aplicar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-v2-'));
    const pack = join(dir, 'pack');
    const out = join(dir, 'out');
    mkdirSync(pack);
    mkdirSync(join(out, 'src'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<!doctype html>\n<html lang="es" data-theme="light">\n</html>\n');
    writeFileSync(join(pack, 'brand.json'), JSON.stringify({ name: 'Nocturna', theme: { preset: 'violet', colorMode: 'dark' } }));
    applyBrand(out, pack);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<html lang="es" data-theme="dark" data-accent="violet">');
  });
});
