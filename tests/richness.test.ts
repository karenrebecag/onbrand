import { describe, expect, test } from 'bun:test';
import type { MeasuredSection, PageMeasure } from '../src/page-sensors';
import { richness, type SectionVisuals } from '../src/richness';

const none: SectionVisuals = { photos: 0, mockups: 0, icons: 0, steps: 0, figures: 0, interactive: 0 };
const sec = (key: string, v: Partial<SectionVisuals>, frame = false): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: '', visuals: { ...none, ...v } });
const page = (sections: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: '', fonts: [], animations: 0, sections });

describe('richness', () => {
  test('v0 Mini del RE: mockup, iconografía, pasos y cifras son 4 secciones con visual; el marco no cuenta', () => {
    const r = richness(page([
      sec('01-navbar', { icons: 5 }, true),
      sec('02-hero', { mockups: 1 }),
      sec('03-beneficios', { icons: 4 }),
      sec('04-como-funciona', { steps: 3, icons: 3 }),
      sec('05-resultados', { figures: 3 }),
      sec('06-precios', { figures: 1, icons: 1 }),
      sec('07-faq', { interactive: 4 }),
      sec('09-footer', { icons: 4 }, true),
    ]));
    expect([r.withVisual, r.sections, r.interactive]).toEqual([4, 6, 4]);
    expect(r.bySection.find((s) => s.key === '04-como-funciona')?.kinds).toEqual(['iconography', 'steps']);
  });
});
