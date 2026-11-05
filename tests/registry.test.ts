import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lintComponent } from '../src/lint';
import { candidatesForRole, loadRegistry, RELUME_RHYTHM, relumeCandidate, verifiedCandidatesByRole } from '../src/registry';
import { composePage } from '../src/select';
import { migrateRelume, type LegacyRelumeEntry } from '../scripts/catalog-migrate';

const FIXTURES = fileURLToPath(new URL('./fixtures/vault/', import.meta.url));

describe('registry — allowlist curada por rol (gate)', () => {
  test('candidatesForRole devuelve SOLO verified, traducido a Candidate del core', () => {
    const legacy: LegacyRelumeEntry[] = [
      { slug: 'section_cta23', name: 'CTA 23', role: 'cta', category: 'cta-sections', tags: ['Buttons'], layoutStyle: ['standard'], verified: true },
      { slug: 'section_stats10', name: 'Stats 10', role: 'stats', category: 'stats-sections', tags: ['Background Image'], layoutStyle: ['background'], verified: false },
    ];
    const registry = migrateRelume(legacy, { keepVerified: true, vaultRoot: FIXTURES });
    expect(candidatesForRole('cta', registry).map((c) => c.slug)).toEqual(['section_cta23']);
    expect(candidatesForRole('cta', registry)[0]).toEqual({
      slug: 'section_cta23', name: 'CTA 23', category: 'cta-sections', tags: ['Buttons'],
      surface: { light: 'base', dark: 'base' }, geometry: 'standard',
    });
    expect(candidatesForRole('stats', registry)).toEqual([]);
  });

  test('traducción Relume -> core: background o "Background Image" = media; off_grid es geometría sobre base', () => {
    const base = { name: 'x', category: 'c' };
    expect(relumeCandidate({ ...base, slug: 'bg', tags: [], layoutStyle: ['off_grid', 'background'] })).toMatchObject({
      surface: { light: 'media', dark: 'media' }, geometry: 'off_grid',
    });
    expect(relumeCandidate({ ...base, slug: 'tag', tags: ['Background Video'], layoutStyle: [] }).surface.light).toBe('media');
    expect(relumeCandidate({ ...base, slug: 'og', tags: [], layoutStyle: ['off_grid'] })).toMatchObject({
      surface: { light: 'base', dark: 'base' }, geometry: 'off_grid',
    });
    expect(RELUME_RHYTHM).toBe('banded');
  });

  test('el pool por rol excluye los slugs rotos del índice real (timeline10, testimonial39)', () => {
    const pool = verifiedCandidatesByRole(['steps', 'testimonials']);
    const slugs = Object.values(pool).flat().map((c) => c.slug);
    expect(slugs).not.toContain('section_timeline10');
    expect(slugs).not.toContain('section_testimonial39');
    expect(pool.steps.map((c) => c.slug)).toEqual(['section_layout122']);
  });

  test('un item Relume que no está en el vault falla ruidoso al migrar', () => {
    expect(() => migrateRelume([{ slug: 'section_nada', name: 'Nada', role: 'cta', category: 'cta-sections', tags: [], layoutStyle: [], verified: true }], { vaultRoot: FIXTURES }))
      .toThrow(/section_nada.*no está en el vault/);
  });

  // Decisión C del brief runner-e2e-arquitectura (research 2026-10-14): `verified` es juicio HUMANO
  // (render visto), separado de `lint.ok`. El lint es NECESARIO pero no suficiente: una entrada
  // verified debe pasar el lint, pero una no-verified puede pasarlo (recién fetcheada, pendiente de
  // render) o fallarlo (excluida por rota). No se acopla `ok === verified`.
  // HACK: desde el alpha, la fuente vendorizada de las entradas de Arc y del porter vive en la distro, no en
  // este árbol; aquí solo se lintea lo que existe. Se quita cuando el catálogo se parta en core y distro
  // (catalog/index.json sigue mezclándolos: src/directions.ts lee BLOCK_CANDIDATES de ahí).
  const DISTRO_SOURCES = ['templates/arc-scaffold/', 'fixtures/relume-themed/'];
  test('verified ⇒ lint.ok (necesario, no suficiente): todo verified con fuente lintea ok', () => {
    const withSource = loadRegistry().filter((e) => e.verified && e.source !== null);
    const absent = withSource.filter((e) => !existsSync(new URL(`../${e.source}`, import.meta.url)));
    expect(absent.map((e) => e.source).filter((s) => !DISTRO_SOURCES.some((p) => s!.startsWith(p)))).toEqual([]);
    for (const e of withSource.filter((e) => !absent.includes(e))) {
      const src = readFileSync(new URL(`../${e.source}`, import.meta.url), 'utf8');
      expect({ slug: e.slug, ok: lintComponent(src).ok }).toEqual({ slug: e.slug, ok: true });
    }
  });

  test('los excluidos por rotura siguen fallando el lint (timeline10, testimonial39)', () => {
    const reg = loadRegistry();
    for (const slug of ['section_timeline10', 'section_testimonial39']) {
      const e = reg.find((x) => x.slug === slug);
      expect(e?.verified).toBe(false);
      const src = readFileSync(new URL(`../${e!.source}`, import.meta.url), 'utf8');
      expect({ slug, ok: lintComponent(src).ok }).toEqual({ slug, ok: false });
    }
  });

  test('cableado: composePage sobre el índice curado arma la página sin tocar selectPage', () => {
    const brief = { summary: 'SaaS con features, stats y cómo funciona', goal: 'agendar demo', tone: 'clean' as const, maxStrips: 8 };
    const page = composePage(brief, verifiedCandidatesByRole(['hero', 'features', 'steps', 'stats', 'cta', 'navbar', 'footer']), RELUME_RHYTHM);
    expect(page.frame.navbar?.pick.slug).toBe('navbar13_component');
    expect(page.frame.footer?.pick.slug).toBe('footer1_component');
    expect(page.strips.find((s) => s.role === 'cta')?.pick.slug).toBe('section_cta23');
    expect(page.strips.map((s) => s.pick.slug)).not.toContain('section_timeline10');
  });
});
