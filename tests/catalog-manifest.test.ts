import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { catalogFor, loadCatalog } from '../src/catalog/load';
import { injectionOf, parseArcDoc, propsOf, registryDepsOf, resolveItem, type KnownItem } from '../src/catalog/manifest-arc';
import { importArcEntry } from '../scripts/catalog-import';
import { migrateRelume, rederiveRelume, type LegacyRelumeEntry } from '../scripts/catalog-migrate';
import { relumeRules } from '../src/catalog/manifest-relume';

const FIXTURES = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));
const doc = (slug: string): string => readFileSync(`${FIXTURES}ui-react/blocks/${slug}/doc.md`, 'utf8');
const known: KnownItem[] = [
  { slug: 'hero-section', name: 'Hero Section' },
  { slug: 'hero-signup', name: 'Hero Signup' },
  { slug: 'page-header', name: 'Page Header' },
  { slug: 'logo-marquee', name: 'Logo Marquee' },
];

// CA18: ningún test hace red. Un fetch invocado durante la suite hace fallar el test que lo invoque.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('fetch prohibido en tests'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

describe('manifiesto Arc parseado del doc.md (spec F2a, RF3)', () => {
  test('CA4: hero-section: 7 keywords, whenNotToUse con alternativa hero-signup, prop variant tipado', () => {
    const m = parseArcDoc(doc('hero-section'), 'HeroSection', 'hero-section', known);
    expect(m.keywords.length).toBe(7);
    expect(m.keywords[0]).toBe('react hero section');
    expect(m.whenToUse.length).toBe(3);
    expect(m.whenNotToUse).toEqual([
      { text: 'Use page-header for titles inside app screens.', alternative: 'page-header' },
      { text: 'Use hero-signup when the goal is collecting an email in the first section.', alternative: 'hero-signup' },
    ]);
    expect(m.props.find((p) => p.name === 'variant')).toEqual({ name: 'variant', type: '"centered" | "split" | "minimal"', default: '"centered"', description: 'Which design to render.' });
    expect(m.props.some((p) => p.name === 'points')).toBe(false); // la tabla de HeroMesh no es la del export principal
    expect(m.injection).toEqual({ kind: 'props', detail: expect.stringContaining('title, description') });
    expect(m.related).toEqual(['site-header', 'logo-marquee', 'hero-signup']);
    expect(m.aiNotes.length).toBe(4);
  });

  test('CA5: una regla que no nombra ningún item conocido queda sin alternativa', () => {
    const m = parseArcDoc(doc('hero-section'), 'HeroSection', 'hero-section', [{ slug: 'logo-marquee', name: 'Logo Marquee' }]);
    expect(m.whenNotToUse.every((r) => r.alternative === undefined)).toBe(true);
    expect(resolveItem('Use Hero signup when...', known)).toBe('hero-signup'); // por nombre, sin distinguir mayúsculas
    expect(resolveItem('nothing here', known)).toBeUndefined();
  });

  test('spotlight-grid: sin props -> injection constants; registryDependencies sin motion-tokens', () => {
    const m = parseArcDoc(doc('spotlight-grid'), 'SpotlightGrid', 'spotlight-grid', known);
    expect(m.props).toEqual([]);
    expect(m.injection.kind).toBe('constants');
    expect(m.injection.detail).toContain('CARDS');
    expect(registryDepsOf(readFileSync(`${FIXTURES}ui-react/blocks/spotlight-grid/registry.json`, 'utf8'))).toEqual(['animated-counter']);
    expect(injectionOf([{ name: 'className', type: 'string', description: '' }], ['Edit stats-band-data.ts to replace the sample numbers.'])).toEqual({ kind: 'data-file', detail: 'stats-band-data.ts' });
    expect(propsOf('## API reference\n\n### X\n| Prop | Type | Default | Description |\n|---|---|---|---|\n| `a` | `A \\| B` | – | d |\n', 'X')).toEqual([{ name: 'a', type: 'A | B', description: 'd' }]);
  });

  test('CA19 + RF6: el import lee SOLO bajo la raíz dada y no toca surface/geometry/verified/emittable/source', () => {
    const entry = catalogFor('arc').find((e) => e.slug === 'hero-section')!;
    const out = importArcEntry(entry, known, FIXTURES);
    expect(out.manifestOrigin).toBe('parsed');
    expect(out.registryDependencies).toEqual(['avatar', 'button', 'copy-button', 'line-chart', 'segmented-control', 'sparkline']);
    const { manifest: _m, manifestOrigin: _o, registryDependencies: _d, ...rest } = out;
    const { manifest: _m2, manifestOrigin: _o2, registryDependencies: _d2, ...orig } = entry;
    expect(rest).toEqual(orig);
    expect(() => importArcEntry(entry, known, `${FIXTURES}no-existe/`)).toThrow(/no-existe\/ui-react\/blocks\/hero-section\/doc\.md/);
  });

  test('CA6: un item Relume derivado nace verified:false, manifestOrigin derived, keywords de tags y sin reglas si el rol no tiene undesiredTags', () => {
    const [stats] = migrateRelume([{ slug: 'section_stats10', name: 'Stats 10', role: 'stats', category: 'stats-sections', tags: ['3 Columns', 'Text Align Left', 'Background Image', 'Stats Section'], layoutStyle: ['background'], verified: true }], { vaultRoot: FIXTURES });
    expect(stats).toMatchObject({ library: 'relume', verified: false, manifestOrigin: 'derived', surface: { light: 'media', dark: 'media' }, geometry: 'standard', export: 'Stats10' });
    expect(stats.origin.path).toBe('sections-react/stats-sections/stats-10/stats-10.tsx');
    expect(stats.manifest?.keywords).toEqual(expect.arrayContaining(['stats section', 'background image', 'stats', 'sections']));
    expect(stats.manifest?.whenNotToUse).toEqual([]);
    expect(stats.manifest?.injection.kind).toBe('props');
    expect(stats.manifest?.props.map((p) => p.name)).toContain('heading');
    expect(stats.manifest?.aiNotes[0]).toMatch(/^Preview renderizado: https:\/\//);
  });

  test('DA2: whenNotToUse derivado SOLO desde undesiredTags del rol, con la alternativa hermana que no lleva el tag', () => {
    const legacy: LegacyRelumeEntry[] = [
      { slug: 'section_cta23', name: 'CTA 23', role: 'cta', category: 'cta-sections', tags: ['1 Column', 'Buttons'], layoutStyle: ['standard'], verified: true },
      { slug: 'section_cta40', name: 'CTA 40', role: 'cta', category: 'cta-sections', tags: ['1 Column', 'Cards', 'Form'], layoutStyle: ['card'], verified: true },
    ];
    // cta40 reutiliza la fixture de cta-23 como source: solo importa el tag Form para la regla
    const rules = relumeRules({ slug: 'section_cta40', name: 'CTA 40', role: 'cta', category: 'cta-sections', tags: legacy[1].tags }, legacy.map((e) => ({ slug: e.slug, role: e.role, tags: e.tags })));
    expect(rules).toEqual([{ text: expect.stringContaining('lleva "Form"'), alternative: 'section_cta23' }]);
    expect(relumeRules({ slug: 'section_cta23', name: 'CTA 23', role: 'cta', category: 'cta-sections', tags: legacy[0].tags }, [])).toEqual([]);
  });

  test('CA7: re-derivar sobre una entrada existente deja verified, surface, geometry, emittable y source intactos', () => {
    const entry = { ...catalogFor('relume').find((e) => e.slug === 'section_cta23')!, emittable: true, notes: 'n' };
    const tsx = readFileSync(`${FIXTURES}sections-react/cta-sections/cta-23/cta-23.tsx`, 'utf8');
    const out = rederiveRelume(entry, tsx, []);
    const { manifest: _m, manifestOrigin: _o, ...rest } = out;
    const { manifest: _m2, manifestOrigin: _o2, ...orig } = entry;
    expect(rest).toEqual(orig);
    expect(out.manifest?.injection.kind).toBe('props');
    expect(out.manifestOrigin).toBe('derived');
  });

  test('CA3 en el índice real: las 11 entradas arc verified traen manifiesto parseado (loadCatalog lo exige)', () => {
    const arc = catalogFor('arc', loadCatalog());
    expect(arc.filter((e) => e.verified).every((e) => e.manifest !== null && e.manifestOrigin === 'parsed')).toBe(true);
    const hero = arc.find((e) => e.slug === 'hero-section')!;
    expect(hero.manifest?.whenNotToUse.some((r) => r.alternative === 'hero-signup')).toBe(true);
  });
});
