import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInventory, detectFormat, renderMarkdown, type IndexEntry } from '../src/catalog/inventory';

const FX = join(import.meta.dir, 'fixtures', 'vault');
const sha = (rel: string): string => createHash('sha256').update(readFileSync(join(FX, rel))).digest('hex');

// Índice sintético que ancla cada estado a un item real del fixture por origin.path (+sha vigente),
// más dos huérfanos deliberados (path inexistente y sha desfasado).
function fixtureIndex(): IndexEntry[] {
  const ctaRel = 'sections-react/cta-sections/cta-23/cta-23.tsx';
  const statsRel = 'sections-react/stats-sections/stats-10/stats-10.tsx';
  const layoutRel = 'sections-react/feature-sections-3-col/layout-237/layout-237.tsx';
  return [
    { slug: 'cta-23', library: 'relume', source: null, verified: false, gate: { ok: true }, origin: { kind: 'vault', path: ctaRel, sha256: sha(ctaRel) } },
    { slug: 'stats-10', library: 'relume', source: null, verified: false, gate: { ok: false, reasons: ['no compila'] }, origin: { kind: 'vault', path: statsRel, sha256: sha(statsRel) } },
    { slug: 'layout-237', library: 'relume', source: null, verified: true, gate: { ok: true }, origin: { kind: 'vault', path: layoutRel, sha256: sha(layoutRel) } },
    { slug: 'ghost', library: 'relume', source: null, origin: { kind: 'vault', path: 'sections-react/heroes/ghost/ghost.tsx', sha256: 'deadbeef' } },
    { slug: 'drifted', library: 'relume', source: null, origin: { kind: 'vault', path: 'ui-react/blocks/spotlight-grid/doc.md', sha256: '0'.repeat(64) } },
  ];
}

describe('inventario del vault (F0)', () => {
  const inv = buildInventory(FX, fixtureIndex(), '2026-10-16T00:00:00.000Z');

  test('clasifica cada carpeta con su bandera de ingest', () => {
    const byName = new Map(inv.folders.map((f) => [f.name, f]));
    expect(byName.get('sections-react')?.scanned).toBe(true);
    expect(byName.get('ui-react')?.scanned).toBe(true);
    expect(byName.get('buttons')?.scanned).toBe(false);
  });

  test('deriva el estado frente al índice por origin.path', () => {
    const bySlug = new Map(inv.items.map((i) => [i.slug, i]));
    expect(bySlug.get('cta-23')?.status).toBe('gate_ok');
    expect(bySlug.get('stats-10')?.status).toBe('gate_failed');
    expect(bySlug.get('stats-10')?.gateReason).toContain('no compila');
    expect(bySlug.get('layout-237')?.status).toBe('gate_ok');
    expect(bySlug.get('layout-237')?.verified).toBe(true);
    expect(bySlug.get('button-001')?.status).toBe('not_indexed');
  });

  test('un botón HTML/CSS/JS se detecta como tal y no como componente', () => {
    const btn = inv.items.find((i) => i.slug === 'button-001');
    expect(btn?.format).toBe('html+css+js');
    expect(btn?.folder).toBe('buttons');
  });

  test('marca imports a alias de proyecto como no resueltos', () => {
    const cta = inv.items.find((i) => i.slug === 'cta-23');
    expect(cta?.unresolvedImports).toContain('@kit/ui');
  });

  test('ui-react con .module.css es tsx+css-modules; sections-react es tsx+tailwind', () => {
    expect(detectFormat(['a/newsletter-signup.tsx', 'a/newsletter-signup.module.css'])).toBe('tsx+css-modules');
    expect(detectFormat(['a/cta-23.tsx'])).toBe('tsx+tailwind');
    expect(detectFormat(['x/html.html', 'x/css.css'])).toBe('html+css+js');
    expect(detectFormat(['i/search.svg'])).toBe('svg');
  });

  test('detecta huérfanos del índice (path inexistente y sha desfasado)', () => {
    const slugs = inv.quality.orphans.map((o) => o.slug).sort();
    expect(slugs).toEqual(['drifted', 'ghost']);
  });

  test('los totales cuadran con los items y el markdown sale del JSON', () => {
    const t = inv.totals;
    expect(t.vaultItems).toBe(inv.items.length);
    expect(t.indexed + t.notIndexed).toBe(t.vaultItems);
    expect(t.gateOk).toBeGreaterThanOrEqual(1);
    expect(t.verified).toBeGreaterThanOrEqual(1);
    const md = renderMarkdown(inv);
    expect(md).toContain(`| Items en el vault | ${t.vaultItems} |`);
    expect(md).toContain(`| NO indexados | ${t.notIndexed} |`);
  });
});
