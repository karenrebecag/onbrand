import { describe, expect, test } from 'bun:test';
import type { AllowEntry } from '../src/ds-skill';
import { checkLayout } from '../src/runtime/layout-check';
import { injectContext, pickSelection, shortlist } from '../src/runtime/retrieve';
import type { JsonSchema } from '../src/runtime/verify';

const entryOf = (category: string, summary: string, extra: Partial<AllowEntry> = {}): AllowEntry => ({
  export: 'X', importPath: '@/x', kind: 'component', schema: null, propless: false, accepts: [], provides: [], category, summary, ...extra,
});
const block = (role: string, extra: Partial<AllowEntry> = {}): AllowEntry => ({
  export: 'B', importPath: '@/b', kind: 'block', role, schema: null, propless: false, accepts: [], provides: [], ...extra,
});

const ALLOW: Record<string, AllowEntry> = {
  'pricing-table': block('pricing'),
  'pricing-demo': block('pricing', { propless: true }),
  'hero-a': block('hero'),
  'plan-switch': entryOf('actions', 'Switch billing between monthly and yearly plans.'),
  button: entryOf('actions', 'A clear action.'),
  'price-tag': entryOf('data', 'Show a price with its billing period.'),
  table: entryOf('data', 'Rows of data.'),
  accordion: entryOf('disclosure', 'Expand and collapse answers.'),
  sparkle: entryOf('special', 'Decorative effect.'),
  glow: entryOf('special', 'Decorative glow.'),
  orbit: entryOf('special', 'Decorative orbit.'),
};

describe('two-step retrieval', () => {
  test('shortlist: blocks del rol, átomos solo de sus categorías, primero los que coinciden y después el relleno', () => {
    const s = shortlist('pricing', { negocio: 'Cafetería con suscripción mensual' }, ALLOW, { maxAtoms: 3 });
    expect(s.blocks).toEqual(['pricing-table']);
    expect(s.atoms).toEqual(['button', 'price-tag', 'plan-switch']);
    expect(s.atoms).not.toContain('accordion');
  });

  test('shortlist: special respeta su tope aunque sobre cupo', () => {
    const s = shortlist('logos', {}, ALLOW, { maxAtoms: 10, maxSpecial: 1 });
    expect(s.atoms.filter((a) => ALLOW[a].category === 'special')).toHaveLength(1);
  });

  test('pickSelection: solo pasa lo del shortlist, sin repetir', () => {
    expect(pickSelection({ slugs: ['button', 'card', 'button', { slug: 'table' }] }, ['button', 'table'])).toEqual({ slugs: ['button', 'table'], rejected: ['card'] });
  });

  test('injectContext: la forma del bloque llega al modelo; sin ella elegía entre maduros solo por slug', () => {
    const allow = { 'hero-split': block('hero', { form: 'split, 2 Columns, Image' }) };
    expect(injectContext(['hero-split'], allow, () => null).prompt).toContain('- forma: split, 2 Columns, Image');
  });

  test('injectContext: lo que no se inyectó no pasa check_layout aunque exista en el DS', () => {
    const schema: JsonSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
    const store = (slug: string): JsonSchema | null => (slug === 'button' || slug === 'table' ? schema : null);
    const ctx = injectContext(['button'], ALLOW, store);
    expect(ctx.prompt).toContain('"required":["label"]');
    expect(ctx.schemas('table')).toBeNull();
    const verdict = checkLayout({ role: 'cta', children: [{ component: 'table', props: { label: 'x' } }] }, ctx.allow, ctx.schemas);
    expect(verdict.violations.map((v) => v.code)).toContain('unknown-component');
  });
});

// #73: los componentes export-default (toast, segmented-control, casi todo ui-squircle) deben importarse
// sin llaves. injectContext imprime la línea de import que ve el modelo; con el `import { X }` fijo viejo
// compilaba contra un export que no existe.
test('injectContext usa importLine: export-default sin llaves, nombrado con llaves', () => {
  const allow: Record<string, AllowEntry> = {
    toast: entryOf('special', 'Toast notification.', { export: 'Toast', importPath: '@/toast', exportDefault: true }),
    button: entryOf('actions', 'A clear action.', { export: 'Button', importPath: '@/button' }),
  };
  const store = () => null;
  const ctx = injectContext(['toast', 'button'], allow, store);
  expect(ctx.prompt).toContain('import Toast from "@/toast";');
  expect(ctx.prompt).toContain('import { Button } from "@/button";');
});
