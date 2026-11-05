import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBrandPack } from '../src/brand';
import { planSections } from '../src/plan';
import { selectPage } from '../src/select';
import type { Brief, Candidate } from '../src/types';


const SRC = join(import.meta.dir, '..', 'src');
const base = { name: 'X', accent: 'blue' as const };

// CA1 (RF1,RF3): parse valida el bloque composition en la frontera de confianza.
describe('parse de composition (CA1)', () => {
  test('acepta un composition válido y lo tipa', () => {
    const b = parseBrandPack({ ...base, composition: { roles: { hero: { desiredTags: ['Image'] } }, density: 'compact', styleSet: 'editorial' } });
    expect(b.composition?.roles?.hero?.desiredTags).toEqual(['Image']);
    expect(b.composition?.density).toBe('compact');
    expect(b.composition?.styleSet).toBe('editorial');
  });
  test('sin composition queda undefined (comportamiento actual)', () => {
    expect(parseBrandPack(base).composition).toBeUndefined();
  });
  test('lanza con desiredTags que no es string[]', () => {
    expect(() => parseBrandPack({ ...base, composition: { roles: { hero: { desiredTags: 'Image' } } } })).toThrow(/desiredTags/);
  });
  test('lanza con density fuera del enum', () => {
    expect(() => parseBrandPack({ ...base, composition: { density: 'enorme' } })).toThrow(/density/);
  });
});

// CA2 (RF4): base <- marca <- intención; la intención GANA en conflicto (ADR 0003).
describe('regla marca↔intent (CA2)', () => {
  const comp = { roles: { hero: { desiredTags: ['BrandHero'] }, cta: { desiredTags: ['BrandCTA'], undesiredTags: ['x'] } } };

  test('la marca aplica donde la intención calla (hero en brief demo)', () => {
    const brief: Brief = { summary: 'SaaS para equipos', goal: 'agendar una demo' };
    const hero = planSections(brief, comp).find((s) => s.role === 'hero');
    expect(hero?.desiredTags).toEqual(['BrandHero']);
  });

  test('la intención gana sobre la marca en el mismo rol (cta en brief waitlist)', () => {
    const brief: Brief = { summary: 'Súmate a la lista de espera (waitlist)', goal: 'captar emails' };
    const cta = planSections(brief, comp).find((s) => s.role === 'cta');
    // waitlist clava el cta en form de suscripción; NO queda BrandCTA.
    expect(cta?.desiredTags).toContain('Form');
    expect(cta?.desiredTags).not.toContain('BrandCTA');
    expect(cta?.undesiredTags).toEqual([]);
  });
});

// CA4: density mapea SOLO a tope de strips (espaciado). El perfil de ritmo ya NO sale de density.
describe('density (CA4)', () => {
  const rich: Brief = { summary: 'SaaS con precios, faq, features y métricas', goal: 'vender' };
  test('compact recorta a 2 strips; spacious sube a 4; sin density, 3', () => {
    expect(planSections(rich, { density: 'compact' }).length).toBe(2);
    expect(planSections(rich, { density: 'spacious' }).length).toBe(4);
    expect(planSections(rich).length).toBe(3);
  });
  test('el brief gana: maxStrips explícito pisa la densidad', () => {
    expect(planSections({ ...rich, maxStrips: 5 }, { density: 'compact' }).length).toBe(5);
  });
  // CA1/CA2 (RF2): el perfil de ritmo lo pide composition.rhythm, desacoplado de density.
  test('composition.rhythm acepta el enum y rechaza fuera de él; density ya no define perfil', () => {
    expect(parseBrandPack({ ...base, composition: { rhythm: 'banded' } }).composition?.rhythm).toBe('banded');
    expect(() => parseBrandPack({ ...base, composition: { rhythm: 'ruidoso' } })).toThrow(/rhythm/);
    expect(parseBrandPack({ ...base, composition: { density: 'spacious' } }).composition?.rhythm).toBeUndefined();
  });
});

// CA5 (RF6): allowedCategories que vacía el pool de un rol lo omite (no se inventa).
test('allowedCategories que excluye la única categoría omite el rol (CA5)', () => {
  const cand = (slug: string, category: string): Candidate =>
    ({ slug, name: slug, category, tags: [], surface: { light: 'base', dark: 'base' }, geometry: 'standard' });
  const byRole: Record<string, Candidate[]> = {
    hero: [cand('header-1', 'hero-header-sections')],
    cta: [cand('cta-1', 'cta-sections')],
  };
  const brief: Brief = { summary: 'SaaS', goal: 'agendar demo' };
  const comp = { roles: { hero: { allowedCategories: ['no-existe'] } } };
  const roles = selectPage(brief, byRole, 'neutral', comp).selections.map((s) => s.role);
  expect(roles).not.toContain('hero');
  expect(roles).toContain('cta');
});

// CA3 (RF2,RF4): dos marcas con composition distinto eligen heros distintos, de forma estable.
test('dos marcas componen heros distintos y estables (CA3)', () => {
  const cand = (slug: string, tags: string[]): Candidate =>
    ({ slug, name: slug, category: 'hero-header-sections', tags, surface: { light: 'base', dark: 'base' }, geometry: 'standard' });
  const byRole: Record<string, Candidate[]> = {
    hero: [cand('hero-img', ['Image', '2 Columns']), cand('hero-plain', ['Text Only', '1 Column'])],
    cta: [cand('cta-1', ['Buttons'])],
  };
  const brief: Brief = { summary: 'SaaS', goal: 'agendar demo' };
  const marcaA = { roles: { hero: { desiredTags: ['Image'] } } };
  const marcaB = { roles: { hero: { desiredTags: ['Text Only'] } } };
  const heroOf = (comp: Parameters<typeof selectPage>[3]) =>
    selectPage(brief, byRole, 'neutral', comp).selections.find((s) => s.role === 'hero')?.pick.slug;
  expect(heroOf(marcaA)).toBe('hero-img');
  expect(heroOf(marcaB)).toBe('hero-plain');
  // estable: 3 corridas dan el mismo resultado
  expect([heroOf(marcaA), heroOf(marcaA), heroOf(marcaA)]).toEqual(['hero-img', 'hero-img', 'hero-img']);
});

// CA6 (RNF3): sin composition, el plan es idéntico al actual.
test('sin composition el plan no cambia (CA6)', () => {
  const brief: Brief = { summary: 'SaaS para equipos', goal: 'agendar una demo' };
  expect(planSections(brief)).toEqual(planSections(brief, undefined));
});

// CA7 (RNF4): el sesgo de marca entra por un punto único; router/rank/select no deciden sobre él.
test('punto único: router/rank/select no ramifican sobre composition (CA7)', () => {
  const decides = /composition\.(roles|density|rhythm|styleSet)|\bbrandBias\b/;
  for (const f of ['router.ts', 'rank.ts', 'select.ts']) {
    expect(readFileSync(join(SRC, f), 'utf8')).not.toMatch(decides);
  }
});
