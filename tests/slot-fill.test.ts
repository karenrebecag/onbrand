import { describe, expect, test } from 'bun:test';
import type { RoleCopy } from '../src/copy';
import type { CatalogEntry, SlotSemantic } from '../src/catalog/schema';
import type { JsonSchema } from '../src/catalog/schema-gen';
import { fillSlots, readAll, slotSpecsOf, type FillContext } from '../src/catalog/slot-fill';

// Fixtures mínimas: el contrato del slot viene del schema (x-slot de S2), los componentes del índice.
const entry = (slug: string, role?: string) => ({ slug, role } as unknown as CatalogEntry);
const component = (slug: string, properties: string[], required: string[] = []) => ({
  entry: entry(slug),
  schema: { properties: Object.fromEntries(properties.map((p) => [p, { type: 'string' }])), required } as JsonSchema,
});
const semantics: Record<string, SlotSemantic[]> = {
  'animated-counter': ['metric'], 'metric-card': ['metric'], gauge: ['metric'], button: ['action'], 'dot-grid': ['illustration'], sparkline: ['series'],
};
const ctx = (schema: JsonSchema | null): FillContext => ({
  schema,
  components: [
    component('metric-card', ['label', 'value', 'suffix', 'context'], ['label', 'value', 'context']),
    component('animated-counter', ['value', 'prefix', 'suffix', 'label'], ['value']),
    component('gauge', ['value', 'label', 'thresholds'], ['value', 'label', 'thresholds']),
    component('button', ['variant']),
    component('dot-grid', ['gap']),
    component('sparkline', ['data'], ['data']),
  ],
  semanticsOf: (slug) => semantics[slug] ?? [],
});
const bentoSchema = (accepts: SlotSemantic[], extra: Record<string, unknown> = {}): JsonSchema =>
  ({ properties: { title: { type: 'string' }, features: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }, visuals: { 'x-slot': { accepts, cardinality: 'map', keys: 'features[].id' }, 'x-empty': '', ...extra } } }) as JsonSchema;
const stats: RoleCopy = { stats: { heading: 'H', stats: [{ value: 6, suffix: 'h', label: 'L1', detail: 'd1' }, { value: 3, suffix: '×', label: 'L2' }, { value: 200, prefix: '+', label: 'L3' }] } };
const bentoProps = { title: 'T', features: [{ id: 'f0' }, { id: 'f1' }, { id: 'f2' }] };

describe('slot-fill — filler por semántica (spec composicion-slots, RF7/CA5)', () => {
  test('map por features[].id: tres stats → tres $component con exactamente esos valores, prefijos y sufijos', () => {
    const out = fillSlots(entry('features', 'features'), bentoProps, stats, ctx(bentoSchema(['metric'])));
    expect(out.visuals).toEqual({
      f0: { $component: 'animated-counter', props: { value: 6, suffix: 'h', label: 'L1' } },
      f1: { $component: 'animated-counter', props: { value: 3, suffix: '×', label: 'L2' } },
      f2: { $component: 'animated-counter', props: { value: 200, prefix: '+', label: 'L3' } },
    });
    expect(out.features).toBe(bentoProps.features);
  });

  test('sin stats en el copy el slot cae a else ("") y nunca a un dato inventado; con menos stats que celdas, solo las que tienen dato', () => {
    expect(fillSlots(entry('features', 'features'), bentoProps, {}, ctx(bentoSchema(['metric']))).visuals).toBe('');
    const one: RoleCopy = { stats: { heading: 'H', stats: [{ value: 1, label: 'L' }] } };
    expect(Object.keys(fillSlots(entry('features', 'features'), bentoProps, one, ctx(bentoSchema(['metric']))).visuals as object)).toEqual(['f0']);
  });

  test('accepts series sin dato real nunca produce $component; un componente cuyo obligatorio no sale del dato (gauge.thresholds) no se usa', () => {
    expect(fillSlots(entry('features', 'features'), bentoProps, stats, ctx(bentoSchema(['series']))).visuals).toBe('');
    const onlyGauge: FillContext = { ...ctx(bentoSchema(['metric'])), components: [component('gauge', ['value', 'label', 'thresholds'], ['value', 'label', 'thresholds'])] };
    expect(fillSlots(entry('features', 'features'), bentoProps, stats, onlyGauge).visuals).toBe('');
  });

  test('el binding manda: un slot ya puesto no se toca; un map sin keys no se llena; sin schema los props vuelven tal cual', () => {
    const bound = { ...bentoProps, visuals: { f0: 'mío' } };
    expect(fillSlots(entry('features', 'features'), bound, stats, ctx(bentoSchema(['metric']))).visuals).toEqual({ f0: 'mío' });
    const noKeys = { properties: { visuals: { 'x-slot': { accepts: ['metric'], cardinality: 'map' }, 'x-empty': '' } } } as JsonSchema;
    expect(fillSlots(entry('features', 'features'), bentoProps, stats, ctx(noKeys)).visuals).toBe('');
    expect(fillSlots(entry('features', 'features'), bentoProps, stats, ctx(null))).toBe(bentoProps);
  });

  test('one: action toma el CTA del rol como children del botón; illustration no necesita dato; else null cuando no hay proveedor (media)', () => {
    const schema = { properties: { visual: { 'x-slot': { accepts: ['illustration'], cardinality: 'one' }, 'x-empty': null }, action: { 'x-slot': { accepts: ['action'], cardinality: 'one' } }, media: { 'x-slot': { accepts: ['media'], cardinality: 'one' }, 'x-empty': null } } } as JsonSchema;
    const copy: RoleCopy = { cta: { heading: 'H', description: 'D', primaryCta: 'Únete' } };
    const out = fillSlots(entry('cta-section', 'cta'), { heading: 'H' }, copy, ctx(schema));
    expect(out.visual).toEqual({ $component: 'dot-grid' });
    expect(out.action).toEqual({ $component: 'button', children: 'Únete' });
    expect(out.media).toBeNull();
    expect(fillSlots(entry('cta-section', 'cta'), { heading: 'H' }, {}, ctx(schema)).action).toBeUndefined();
  });

  test('determinista: dos llamadas, mismo resultado; slots anidados (brand.mark, channels[].icon) se descubren con su ruta', () => {
    const a = fillSlots(entry('features', 'features'), bentoProps, stats, ctx(bentoSchema(['metric'])));
    expect(fillSlots(entry('features', 'features'), bentoProps, stats, ctx(bentoSchema(['metric'])))).toEqual(a);
    const nested = { properties: { brand: { type: 'object', properties: { name: { type: 'string' }, mark: { 'x-slot': { accepts: ['logo'], cardinality: 'one' } } } }, channels: { type: 'array', items: { type: 'object', properties: { icon: { 'x-slot': { accepts: ['icon'], cardinality: 'one' }, 'x-empty': '' } } } } } } as JsonSchema;
    expect(slotSpecsOf(nested)).toEqual([{ path: 'brand.mark', accepts: ['logo'], cardinality: 'one' }, { path: 'channels[].icon', accepts: ['icon'], cardinality: 'one', else: '' }]);
    const out = fillSlots(entry('contact-section', 'cta'), { brand: { name: 'N' }, channels: [{ label: 'a' }, { label: 'b' }] }, {}, ctx(nested));
    expect(out.channels).toEqual([{ label: 'a', icon: '' }, { label: 'b', icon: '' }]);
    expect(out.brand).toEqual({ name: 'N' });
  });

  test('readAll recorre listas: features[].id devuelve un id por feature', () => {
    expect(readAll(bentoProps, 'features[].id')).toEqual(['f0', 'f1', 'f2']);
    expect(readAll({}, 'features[].id')).toEqual([]);
  });
});
