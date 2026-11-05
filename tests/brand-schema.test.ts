import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCENT_KEYS, BRAND_PACK_KEYS, FONT_KEYS, parseBrandPack, PRESET_ACCENTS, SURFACE_KEYS } from '../src/brand';
import { FACT_ENTRY_KEYS, FACTS_KEYS, parseBrandFacts } from '../src/brand-facts';

// Los schemas son el contrato para quien arma una marca sin leer el código: si el parser acepta algo que el schema no
// declara (o al revés), el editor marca como error un pack válido o deja pasar uno que el loader rechaza.
const BRANDS = join(import.meta.dir, '..', 'brands');
type Schema = { properties: Record<string, Schema & { oneOf?: Schema[]; items?: Schema }>; required?: string[]; enum?: string[] };
const brandSchema = JSON.parse(readFileSync(join(BRANDS, 'brandpack.schema.json'), 'utf8')) as Schema;
const factsSchema = JSON.parse(readFileSync(join(BRANDS, 'facts.schema.json'), 'utf8')) as Schema;
const keys = (s: Schema) => Object.keys(s.properties).sort();
const sorted = (l: readonly string[]) => [...l].sort();

describe('brandpack.schema.json y parseBrandPack', () => {
  test('declaran las mismas claves, en la raíz y en accent, surface y fonts', () => {
    expect(keys(brandSchema)).toEqual(sorted(BRAND_PACK_KEYS));
    const [preset, custom] = brandSchema.properties.accent.oneOf ?? [];
    expect(sorted(preset.enum ?? [])).toEqual(sorted(PRESET_ACCENTS));
    expect(keys(custom)).toEqual(sorted(ACCENT_KEYS));
    expect(keys(brandSchema.properties.surface)).toEqual(sorted(SURFACE_KEYS));
    expect(keys(brandSchema.properties.fonts)).toEqual(sorted(FONT_KEYS));
  });

  test('lo obligatorio del schema es lo que el parser exige', () => {
    expect(sorted(brandSchema.required ?? [])).toEqual(['accent', 'name']);
    expect(() => parseBrandPack({ accent: 'blue' })).toThrow('"name"');
    // Sin `accent` el pack se lee como v2 (lector dual, brandpack-v2.schema.json); un canal de v1 sin accent no pasa.
    expect(() => parseBrandPack({ name: 'X', surface: { background: '#ffffff' } })).toThrow('clave desconocida "surface"');
    const custom = { base: '#111111', strong: '#000000', subtle: '#eeeeee' };
    const [, schemaCustom] = brandSchema.properties.accent.oneOf ?? [];
    expect(sorted(schemaCustom.required ?? [])).toEqual(sorted(Object.keys(custom)));
    expect(parseBrandPack({ name: 'X', accent: custom }).name).toBe('X');
    for (const k of Object.keys(custom)) {
      const { [k]: _, ...rest } = custom as Record<string, string>;
      expect(() => parseBrandPack({ name: 'X', accent: rest })).toThrow('requiere base, strong y subtle');
    }
  });

  test('una clave fuera del schema falla en el parser con su nombre', () => {
    expect(() => parseBrandPack({ name: 'X', accent: 'blue', tokensdark: {} })).toThrow('clave desconocida "tokensdark"');
    expect(() => parseBrandPack({ name: 'X', accent: 'blue', fonts: { heading: 'Inter' } })).toThrow('fonts: clave desconocida "heading"');
    expect(parseBrandPack({ $schema: '../brandpack.schema.json', name: 'X', accent: 'blue' }).name).toBe('X');
  });
});

describe('facts.schema.json y parseBrandFacts', () => {
  test('declaran las mismas claves, en la raíz y en cada entrada', () => {
    expect(keys(factsSchema)).toEqual(sorted(FACTS_KEYS));
    for (const [list, entryKeys] of Object.entries(FACT_ENTRY_KEYS)) {
      expect({ list, keys: keys(factsSchema.properties[list].items as Schema) }).toEqual({ list, keys: sorted(entryKeys) });
    }
  });

  test('lo obligatorio de cada entrada es lo que el parser exige', () => {
    for (const list of Object.keys(FACT_ENTRY_KEYS)) {
      const required = (factsSchema.properties[list].items as Schema).required ?? [];
      const minimal = Object.fromEntries(required.map((k) => [k, 'x']));
      expect(() => parseBrandFacts({ [list]: [minimal] })).not.toThrow();
      for (const k of required) {
        const { [k]: _, ...rest } = minimal;
        expect(() => parseBrandFacts({ [list]: [rest] })).toThrow(`${list}[0].${k}`);
      }
    }
  });

  test('una clave fuera del schema falla en el parser con su nombre', () => {
    expect(() => parseBrandFacts({ metric: [] })).toThrow('clave desconocida "metric"');
    expect(() => parseBrandFacts({ metrics: [{ label: 'a', value: '1', source: 's', fuente: 'x' }] })).toThrow('metrics[0]: clave desconocida "fuente"');
  });

  test('el pack de ejemplo apunta a los dos schemas', () => {
    const json = (f: string) => JSON.parse(readFileSync(join(BRANDS, 'brand-pack-ejemplo', f), 'utf8')) as { $schema?: string };
    expect(json('brand.json').$schema).toBe('../brandpack-v2.schema.json');
    expect(json('facts.json').$schema).toBe('../facts.schema.json');
  });
});
