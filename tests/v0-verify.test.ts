import { describe, expect, test } from 'bun:test';
import { lintPage, verifySection, type JsonSchema } from '../src/runtime/verify';
import type { AllowEntry } from '../src/ds-skill';

const entry = (over: Partial<AllowEntry> = {}): AllowEntry => ({
  export: 'X', importPath: '@/components/arc/x/x', kind: 'component', schema: 'x', propless: false, accepts: [], provides: [], ...over,
});

const allow: Record<string, AllowEntry> = {
  card: entry({ accepts: [{ prop: 'action', required: false, type: 'ReactNode' }] }),
  button: entry(),
  accordion: entry({ accepts: [{ prop: 'items', required: true, type: '{ title: string; content: ReactNode }[]' }] }),
  'hero-demo': entry({ kind: 'block', propless: true }),
  hero: entry({ kind: 'block' }),
};

const schemas: Record<string, JsonSchema> = {
  card: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, size: { type: 'string', enum: ['md', 'lg'] }, action: {}, onOpenChange: { type: 'object' } } },
  button: { type: 'object', additionalProperties: false, properties: { children: {}, variant: { type: 'string', enum: ['primary', 'secondary'] } } },
  hero: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', format: 'heading' }, description: { type: 'string' } } },
  accordion: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', minItems: 1, items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, content: {} } } } } },
};
const store = (slug: string): JsonSchema | null => schemas[slug] ?? null;
const codes = (r: { violations: { code: string }[] }): string[] => r.violations.map((v) => v.code).sort();

describe('verifySection', () => {
  test('una sección vacía no pasa y pide reintento', () => {
    const r = verifySection({ role: 'testimonials', parts: [] }, allow, store);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['empty-section']);
    expect(r.feedback).toContain('testimonials');
  });

  test('valida contra el schema completo, también dentro de los items', () => {
    const r = verifySection({ role: 'faq', parts: [
      { component: 'card', props: { title: 3, size: 'xl' } },
      { component: 'accordion', props: { items: [{ content: 'sin título' }] } },
    ] }, allow, store);
    expect(codes(r)).toEqual(['missing-required', 'not-in-enum', 'wrong-type']);
    expect(r.fix).toBeUndefined();
  });

  test('prop inventada o callback se quitan con el autofix y la sección queda limpia', () => {
    const r = verifySection({ role: 'features', parts: [{ component: 'card', props: { title: 'Equipos remotos', ribbon: 'x', onOpenChange: 'fn' } }] }, allow, store);
    expect(codes(r)).toEqual(['callback-prop', 'unknown-prop']);
    expect(r.fix?.section.parts[0].props).toEqual({ title: 'Equipos remotos' });
  });

  test('un componente anidado solo entra en props que aceptan JSX, y se valida él también', () => {
    const ok = verifySection({ role: 'cta', parts: [{ component: 'card', props: { title: 'Prueba', action: { $component: 'button', props: { variant: 'primary' }, children: 'Empezar' } } }] }, allow, store);
    expect(ok.ok).toBe(true);
    const bad = verifySection({ role: 'cta', parts: [{ component: 'card', props: { title: { $component: 'button' }, action: { $component: 'tooltip' } } }] }, allow, store);
    expect(codes(bad)).toEqual(['nesting-not-accepted', 'unknown-component']);
  });

  test('un propless (con o sin props), un organismo sin título y un texto de relleno caen a demo', () => {
    const r = verifySection({ role: 'hero', parts: [
      { component: 'hero-demo', props: {} },
      { component: 'hero', props: { description: 'Vende por chat' } },
      { component: 'card', props: { title: 'Short heading goes here' } },
    ] }, allow, store);
    expect(codes(r)).toEqual(['demo-fallback', 'placeholder-text', 'propless-as-content']);
  });
});

describe('lintPage', () => {
  test('un rol repetido falla aunque cada sección sea válida', () => {
    const s = { role: 'cta', parts: [{ component: 'card', props: { title: 'Hola' } }] };
    expect(lintPage([s, s], allow, store).ok).toBe(false);
    expect(lintPage([s], allow, store).ok).toBe(true);
  });
});

describe('demo-copy', () => {
  test('un asset o una frase de la demo del componente es copia; una palabra suelta no', () => {
    const allow = { 'logo-marquee': { export: 'LogoMarquee', importPath: '@/x', kind: 'block' as const, schema: null, propless: false, accepts: [], provides: [], demoStrings: ['/block-logos/stripe.svg', 'Still have a question?'] } };
    const sec = (brands: unknown) => ({ role: 'logos', parts: [{ component: 'logo-marquee', props: { brands } }] });
    const v = verifySection(sec([{ name: 'Stripe', icon: '/block-logos/stripe.svg' }]), allow, () => null);
    expect(v.violations.map((x) => `${x.path}:${x.code}`)).toEqual(['parts[0].props.brands[0].icon:demo-copy']);
    expect(verifySection(sec([{ name: 'Stripe', icon: '/logos/stripe.svg' }]), allow, () => null).ok).toBe(true);
  });
});
