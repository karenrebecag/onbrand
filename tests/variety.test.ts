import { describe, expect, test } from 'bun:test';
import type { MeasuredSection, PageMeasure } from '../src/page-sensors';
import { runSignature, varietySensors } from '../src/variety';

const visuals = (over: Partial<NonNullable<MeasuredSection['visuals']>> = {}) => ({ photos: 0, mockups: 0, icons: 0, steps: 0, figures: 0, interactive: 0, ...over });
const section = (key: string, text = 'texto', v = visuals()): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text, visuals: v });
const page = (accent: string, fonts: [string, number][], sections: MeasuredSection[]): PageMeasure =>
  ({ viewport: 1440, lang: 'es', title: 'Acme', accent: { attr: null, rgb: accent }, animations: 0, sections,
    fonts: fonts.map(([family, count]) => ({ family, count, generic: false, loaded: true, declared: true })) });
// La página que el agente repite (cc7b8016, 999ea0e0): verde #0f6b5c, Bricolage de display y las mismas métricas.
const repeated = (accent: string, display: string, cases: string) => page(accent, [['Hanken Grotesk', 80], [display, 22]], [
  section('02-hero', 'Vende por WhatsApp', visuals({ mockups: 1 })), section('03-features', 'x', visuals({ icons: 4 })),
  section('04-steps', 'x', visuals({ steps: 3 })), section('05-casos', cases, visuals({ figures: 3 })), section('06-pricing', '$49 $149'), section('07-faq'),
]);
const fields = (r: ReturnType<typeof varietySensors>) => r.defects.map((d) => d.field).sort();

describe('variety: N corridas del mismo brief no deberían ser la misma página', () => {
  test('dos corridas con el mismo verde, display, cifras y foco por sección convergen en los cuatro ejes', () => {
    const r = varietySensors([runSignature('a', repeated('rgb(15, 107, 92)', 'Bricolage Grotesque', '38% más ventas, 3,1x')), runSignature('b', repeated('rgb(11, 93, 87)', 'Bricolage Grotesque', '+38 % y 3.1x'))]);
    expect(fields(r)).toEqual(['variety.color', 'variety.figures', 'variety.structure', 'variety.type', 'variety.typical', 'variety.typical']);
    expect(r.defects.find((d) => d.field === 'variety.figures')?.actual).toBe('38% 3.1x $49 $149');
  });

  test('otra dirección (acento, display, cifras y focos distintos) no converge en nada', () => {
    const other = page('rgb(184, 63, 18)', [['Inter', 80], ['Sora', 20]], [
      section('02-hero', 'x', visuals({ photos: 1 })), section('03-features', 'x', visuals({ figures: 2 })), section('04-steps'), section('05-casos', '12% 4min', visuals({ photos: 2 })), section('06-pricing', '$99'),
    ]);
    const r = varietySensors([runSignature('a', repeated('rgb(15, 107, 92)', 'Bricolage Grotesque', '38% 3,1x')), runSignature('b', other)]);
    expect([r.pairs, r.defects.filter((d) => d.field !== 'variety.typical')]).toEqual([1, []]);
  });

  test('sin acento medido (v0, Stitch) el color no se afirma, y una sola corrida no da pares', () => {
    const v0 = runSignature('v0', { ...repeated('', 'Manrope', 'x'), accent: { attr: null, rgb: null } });
    expect(varietySensors([v0, runSignature('st', { ...repeated('', 'DM Sans', 'y'), accent: undefined })]).converged['variety.color']).toBe(0);
    expect(varietySensors([v0]).pairs).toBe(0);
  });
});

test('variety.typical: una corrida con cifras de plantilla es defecto aunque ningún par converja', () => {
  const r = varietySensors([{ run: 'a', structure: [], accent: null, display: null, figures: ['+38%', '17%'] }]);
  expect(r.defects.map((d) => [d.field, d.section, d.actual])).toEqual([['variety.typical', 'a', '+38%']]);
});
