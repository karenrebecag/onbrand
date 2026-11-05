import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSchema, cleanProp, dataImportOf, demoStringsOf, enumValues, isDemoDefault, formatStats, literalAliasesOf, schemaWellFormed, validate } from '../src/catalog/schema-gen';
import { loadCatalog, REPO_ROOT } from '../src/catalog/load';
import { loadSlotSemantics, parseSlotSemantics } from '../src/catalog/slot-semantics';
import { classifyProp, inferFormat, isContentProp } from '../src/catalog/semantic-formats';
import type { CatalogEntry, ManifestProp } from '../src/catalog/schema';

const entry = (props: ManifestProp[]): CatalogEntry => ({
  library: 'arc', kind: 'block', slug: 'demo', name: 'Demo', category: 'c', role: 'features',
  tags: [], surface: { light: 'base', dark: 'base' } as never, geometry: 'standard' as never,
  verified: true, source: null, origin: { kind: 'vault', path: 'demo/demo.tsx', sha256: '' }, importPath: '@/x', export: 'X',
  manifest: { keywords: [], whenToUse: [], whenNotToUse: [], aiNotes: [], related: [], injection: { kind: 'props', detail: '' }, props },
} as CatalogEntry);

const p = (name: string, type: string, description = ''): ManifestProp => ({ name, type, description });

describe('inferFormat — vocabulario cerrado, no adivina (paso 4.1)', () => {
  test('nombre+tipo que concuerdan → alta confianza con format', () => {
    expect(inferFormat('title', 'string')).toEqual({ format: 'heading', confidence: 'high' });
    expect(inferFormat('primaryCta', 'string')).toEqual({ format: 'cta', confidence: 'high' });
    expect(inferFormat('monthlyPrice', 'string')).toEqual({ format: 'price', confidence: 'high' });
  });

  test('string sin regla → low SIN format (no se adivina)', () => {
    expect(inferFormat('locale', 'string')).toEqual({ confidence: 'low' });
    expect(inferFormat('slug', 'string')).toEqual({ confidence: 'low' });
  });

  test('regla con tipo incompatible → low (no fuerza el format)', () => {
    // metric es numérico; un headcountMetric:string no concuerda
    expect(inferFormat('headcountMetric', 'string')).toEqual({ confidence: 'low' });
    expect(inferFormat('headcountMetric', 'number')).toEqual({ format: 'metric', confidence: 'high' });
  });

  test('un format estructurado acepta objeto (cta/link/person), no solo texto', () => {
    expect(inferFormat('cta', 'ComparisonCta')).toEqual({ format: 'cta', confidence: 'high' });
    expect(inferFormat('privacyLink', '{ label: string; href: string }')).toEqual({ format: 'link', confidence: 'high' });
  });
});

describe('classifyProp — contenido / config / estado (paso 4.2)', () => {
  test('contenido es lo que llena el copy', () => {
    expect(classifyProp('title', 'string')).toBe('content');
    expect(classifyProp('greeting', 'string')).toBe('content');
    expect(classifyProp('faces', 'string[]')).toBe('content');
  });

  test('config: enum, boolean, handlers y nombres de configuración', () => {
    expect(classifyProp('variant', '"a" | "b"')).toBe('config');
    expect(classifyProp('sticky', 'boolean')).toBe('config');
    expect(classifyProp('onChange', '() => void')).toBe('config');
    expect(classifyProp('locale', 'string')).toBe('config');
    expect(classifyProp('compareWith', 'string')).toBe('config');
  });

  test('estado: defaultX y el valor controlado de un input', () => {
    expect(classifyProp('defaultChannel', 'string')).toBe('state');
    expect(classifyProp('value', 'string[]')).toBe('state');
    expect(classifyProp('current', 'string')).toBe('state');
    expect(classifyProp('query', 'string')).toBe('state');
  });

  test('isContentProp refleja classifyProp', () => {
    expect(isContentProp('variant', '"a" | "b"')).toBe(false);
    expect(isContentProp('placeholder', 'string')).toBe(true);
  });
});

describe('cleanProp — parsea el ruido del doc.md', () => {
  test('quita backticks y (required), detecta array por notación', () => {
    const c = cleanProp(p('features[].visual` (required)', 'string'));
    expect(c.required).toBe(true);
    expect(c.segments).toEqual([{ key: 'features', array: true }, { key: 'visual', array: false }]);
  });
});

describe('buildSchema — draft-07, additionalProperties:false, format en contenido', () => {
  const schema = buildSchema(entry([
    p('title', 'string', 'Titular'),
    p('variant', '"minimal" | "centered"', 'Estilo'),
    p('features', 'Feature[]', 'Las celdas'),
    p('features[].title', 'string', 'Título de la celda'),
    p('features[].size', '"wide" | "half"', 'Tamaño'),
  ]));

  test('raíz bien formada con format en title y enum en variant', () => {
    expect(schemaWellFormed(schema)).toBe(true);
    expect(schema.properties!.title).toMatchObject({ type: 'string', format: 'heading' });
    expect(schema.properties!.variant).toMatchObject({ enum: ['minimal', 'centered'] });
    expect(schema.properties!.variant.format).toBeUndefined();
  });

  test('un prop X[] + X[].Y construyen un array con items.properties (en cualquier orden)', () => {
    const feat = schema.properties!.features;
    expect(feat.type).toBe('array');
    expect(feat.items!.type).toBe('object');
    expect(feat.items!.properties!.title).toMatchObject({ format: 'heading' });
    expect(feat.items!.properties!.size).toMatchObject({ enum: ['wide', 'half'] });
  });
});

describe('validate — validador mínimo (sin ajv)', () => {
  const schema = buildSchema(entry([p('title', 'string'), p('items', 'string[]')]));

  test('additionalProperties:false atrapa un campo extra', () => {
    expect(validate(schema, { title: 'ok', extra: 1 })).toContainEqual(expect.stringContaining('additionalProperties'));
  });

  test('un ejemplo correcto no da errores', () => {
    expect(validate(schema, { title: 'ok', items: ['a', 'b'] })).toEqual([]);
  });

  test('formatStats cuenta format y low', () => {
    const s = buildSchema(entry([p('title', 'string'), p('slug', 'string')]));
    const st = formatStats(s);
    expect(st.withFormat).toBe(1); // title
    expect(st.lowConfidence).toBe(1); // slug: contenido de texto sin regla
  });
});

describe('schemas y semánticas de componente (composicion-slots S1b)', () => {
  test('CA2: un alias de union de literales del mismo archivo se resuelve a enum (ButtonVariant)', () => {
    const src = 'export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";\ntype Size =\n  | "sm"\n  | "md";\nexport type Ref = HTMLButtonElement;\n';
    const aliases = literalAliasesOf(src);
    expect(enumValues(aliases.get('ButtonVariant') ?? '')).toEqual(['primary', 'secondary', 'ghost', 'danger']);
    expect(enumValues(aliases.get('Size') ?? '')).toEqual(['sm', 'md']);
    expect(aliases.has('Ref')).toBe(false);
    const button = JSON.parse(readFileSync(join(REPO_ROOT, 'catalog/schemas/components/button.schema.json'), 'utf8'));
    expect(button['x-variants']).toEqual(['primary', 'secondary', 'ghost', 'danger', 'whatsapp']);
  });

  test('RF3: el overlay valida el vocabulario cerrado y solo nombra componentes del índice con schema', () => {
    expect(() => parseSlotSemantics({ version: 1, components: { sparkline: ['sparkline'] } })).toThrow(/fuera del vocabulario/);
    expect(() => parseSlotSemantics({ version: 1, components: { badge: [] } })).toThrow(/lista no vacía/);
    expect(() => parseSlotSemantics({ version: 1, components: { badge: ['badge', 'badge'] } })).toThrow(/repetida/);
    const components = new Set(loadCatalog({ requireManifest: false }).filter((e) => e.kind === 'component').map((e) => e.slug));
    for (const slug of Object.keys(loadSlotSemantics().components)) {
      expect(components.has(slug), `${slug} no es un component del índice`).toBe(true);
      expect(existsSync(join(REPO_ROOT, `catalog/schemas/components/${slug}.schema.json`)), `${slug} sin schema`).toBe(true);
    }
  });
});

describe('props controlados y fechas (chat-thread)', () => {
  const ts = (name: string, type: string, required: boolean) => ({ name, type, required, description: '' });
  const schema = buildSchema(entry([]), undefined, [
    ts('currentUserId', 'string', true),
    ts('messages', 'ChatMessage[]', false),
    ts('messages[].createdAt', 'Date | string | number', true),
    ts('defaultMessages', 'ChatMessage[]', false),
    ts('defaultMessages[].createdAt', 'Date | string | number', true),
    ts('series', 'Series[]', false),
    ts('series[].label', 'string', true),
    ts('defaultSeries', 'string', false),
    ts('value', 'Date', false),
  ]);

  test('controlado y no controlado no salen obligatorios a la vez; un default de otro tipo no es par', () => {
    expect(schema.required).toEqual(['currentUserId']);
    expect(schema.properties?.messages?.items?.required).toEqual(['createdAt']);
  });

  test('una fecha que acepta string valida el ISO de JSON; un Date solo sigue opaco', () => {
    expect(schema.properties?.messages?.items?.properties?.createdAt?.type).toBe('string');
    expect(schema.properties?.value?.type).toBe('object');
  });
});

describe('requerido por default de demo', () => {
  const src = [
    'import { kpis as sampleKpis, sampleResponder } from "./kpi-data";',
    'const SYMBOLS = [{ ticker: "ACME", name: "Acme Corp" }];',
    'const DEFAULT_REACTIONS = ["👍", "🎉"];',
    'const LEVELS = [5, 3, 2];',
  ].join('\n');
  const data = 'export const kpis = [];\nexport async function* sampleResponder() {}';

  test('dato importado de *-data o constante con texto de pantalla es demo; configuración y callbacks no', () => {
    expect(isDemoDefault('sampleKpis', src, data)).toBe(true);
    expect(isDemoDefault('SYMBOLS', src, data)).toBe(true);
    expect(isDemoDefault('{ name: "Arc" }', src, data)).toBe(true);
    expect(isDemoDefault('sampleResponder', src, data)).toBe(false);
    expect(isDemoDefault('DEFAULT_REACTIONS', src, data)).toBe(false);
    expect(isDemoDefault('LEVELS', src, data)).toBe(false);
    expect(isDemoDefault('{ month: "short" }', src, data)).toBe(false);
    expect(isDemoDefault('[]', src, data)).toBe(false);
    expect(dataImportOf('sampleKpis', src)).toBe('kpis');
  });
});

test('un prop de datos con un callback adentro y `| null` sigue siendo dato, y null valida', () => {
  const s = buildSchema(entry([]), undefined, [{ name: 'contact', type: '{ label: string; onClick?: () => void } | null', required: true, description: '' }]);
  expect(s.properties?.contact).toMatchObject({ type: 'object', 'x-nullable': true });
  expect(validate(s, { contact: null })).toEqual([]);
});

test('demoStringsOf junta frases y assets de los defaults de demo, no palabras sueltas ni configuración', () => {
  const src = 'const exampleBrands = [{ name: "Stripe", icon: "/block-logos/stripe.svg" }];\nconst LEVELS = [5, 3];';
  const defaults = new Map([['brands', 'exampleBrands'], ['contact', '{ label: "Still have a question?" }'], ['zoom', 'LEVELS']]);
  expect(demoStringsOf(defaults, src)).toEqual(['/block-logos/stripe.svg', 'Still have a question?']);
});
