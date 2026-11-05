import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { layoutGuides, patternsOf, signatureOf, type SectionForm } from '../src/ds-layout-guides';
import type { RelumeScanItem } from '../src/catalog/ingest-relume';

const FIX = join(import.meta.dir, 'fixtures', 'vault');
const read = (cat: string, item: string): RelumeScanItem => ({
  category: cat,
  item,
  slug: `section_${item.replace('-', '')}`,
  name: item,
  file: `sections-react/${cat}/${item}/${item}.tsx`,
  npmDeps: [],
  tsx: readFileSync(join(FIX, 'sections-react', cat, item, `${item}.tsx`), 'utf8'),
});

describe('guías de layout desde Relume (regla, no a mano)', () => {
  test('la firma de forma sale del source: layout-237 es un grid de 3 columnas con icono, centrado', () => {
    const sig = signatureOf(read('feature-sections-3-col', 'layout-237'), 'features');
    expect(sig.cols).toBe(3);
    expect(sig.align).toBe('center');
    expect(sig.media).toBe('image');
    expect(sig.side).toBe('none');
    expect(sig.items).toBe(3);
    expect(sig.icons).toBe(true);
  });

  test('un patrón agrupa firmas iguales, cita sus slugs y una firma única no es patrón', () => {
    const base = signatureOf(read('feature-sections-3-col', 'layout-237'), 'features');
    const forms: SectionForm[] = [
      { slug: 'a', category: 'x', sig: base },
      { slug: 'b', category: 'x', sig: base },
      { slug: 'c', category: 'x', sig: { ...base, cols: 2, side: 'right' } },
    ];
    const { patterns, singles } = patternsOf(forms);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].slugs).toEqual(['a', 'b']);
    expect(singles).toEqual(['c']);
    // El árbol usa las primitivas del motor y placeholders, nunca slugs ni copy inventado.
    const json = JSON.stringify(patterns[0].tree);
    expect(json).toContain('"layout":"grid"');
    expect(json).toContain('@icon');
    expect(json).toContain('{heading}');
    // Sin eyebrow: el tagline de Relume no llega a la guía (Arc lo prohíbe).
    expect(json).not.toContain('{tagline}');
  });

  test('las categorías sin rol se reportan excluidas y cada rol produce su guía con fuentes', () => {
    const items = [read('feature-sections-3-col', 'layout-237'), read('feature-sections-3-col', 'layout-237'), read('cta-sections', 'cta-23'), read('stats-sections', 'stats-10'), { ...read('cta-sections', 'cta-23'), category: 'blog-sections' }];
    const report = layoutGuides(FIX, () => items);
    expect(report.excluded).toEqual({ 'blog-sections': 1 });
    expect(Object.keys(report.guides).sort()).toEqual(['layout-cta', 'layout-features', 'layout-stats']);
    expect(report.guides['layout-features']).toContain('Fuentes: section_layout237');
    expect(report.roles.features).toEqual({ total: 2, patterns: 1, covered: 2, singles: 0 });
  });
});
