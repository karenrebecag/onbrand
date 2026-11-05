import { describe, expect, test } from 'bun:test';
import { pageSensors, type MeasuredSection, type PageMeasure } from '../src/page-sensors';
import { parsePagePlanMd } from '../src/page-plan-md';
import { BLOCK_CANDIDATES, DIRECTIONS } from '../src/directions';

const d = DIRECTIONS.find((x) => x.id === 'editorial-serif')!;
const section = (key: string): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: 'texto de la sección en español para el sensor de idioma' });
const page = (fonts: string[]): PageMeasure =>
  ({ viewport: 1440, lang: 'es', title: 'Acme', animations: 0, sections: [section('02-hero'), section('06-casos')], fonts: fonts.map((family) => ({ family, count: 30, generic: false, loaded: true, declared: true })) });
// Lo que pide editorial-serif: hero full-bleed con foto en base; testimonios single-quote con cita en muted.
const plan = (head: string, hero: string, casos: string) => parsePagePlanMd(`# Plan\n- negocio: Acme\n${head}\n\n## 02-hero · #inicio\n${hero}\n\n## 06-casos · #casos\n${casos}`);
const OK_HERO = '- forma: full-bleed\n- focal: foto del equipo atendiendo\n- superficie: base';
const OK_CASOS = '- forma: single-quote\n- focal: cita de un gerente\n- superficie: muted';
const dir = (r: ReturnType<typeof pageSensors>) => r.defects.filter((x) => x.field === 'plan.direction').map((x) => [x.section, x.expected]);

describe('plan.direction: el plan y la página siguen la dirección entregada', () => {
  test('cabecera con la dirección, forma, focal y superficie de cada rol, y el par tipográfico pintado: 0', () => {
    const p = plan('- direccion: `editorial-serif`', OK_HERO, OK_CASOS);
    expect(p.direction).toBe('editorial-serif');
    const r = pageSensors([page(['Instrument Sans', 'Fraunces'])], { plan: p, direction: { direction: d, brandFonts: false } });
    // 4: dirección, hero y casos en el plan, más casos (single-quote) sin fila de 3 en el DOM.
    expect([dir(r), r.checked['plan.direction']]).toEqual([[], 4]);
  });

  test('otra dirección en la cabecera, otra forma, otro focal y otra superficie son defectos; casos se mide como testimonios', () => {
    const p = plan('- direccion: bento-producto', '- forma: split-media\n- focal: mockup de chat\n- superficie: muted', OK_CASOS);
    const r = pageSensors([page(['Instrument Sans', 'Fraunces'])], { plan: p, direction: { direction: d, brandFonts: false } });
    expect(dir(r)).toEqual([['-', 'editorial-serif'], ['02-hero', 'forma full-bleed'], ['02-hero', 'focal foto'], ['02-hero', 'superficie base']]);
  });

  test('sin pack, la página que no pinta el par de la dirección es defecto; con pack ganan sus fuentes y no se afirma', () => {
    const p = plan('- direccion: editorial-serif', OK_HERO, OK_CASOS);
    expect(dir(pageSensors([page(['Inter'])], { plan: p, direction: { direction: d, brandFonts: false } }))).toEqual([['-', 'Fraunces + Instrument Sans']]);
    expect(dir(pageSensors([page(['Inter'])], { plan: p, direction: { direction: d, brandFonts: true } }))).toEqual([]);
  });
});

describe('plan.direction sobre el DOM', () => {
  const sec = (key: string, role: string, rows: number[]): MeasuredSection => ({ ...section(key), role, collections: rows.length ? [{ items: rows.reduce((a, b) => a + b, 0), rows, tag: 'article', cls: 'g' }] : [] });
  const measure = (s: MeasuredSection[]): PageMeasure => ({ ...page(['Inter']), sections: s });
  const ps = DIRECTIONS.find((x) => x.id === 'premium-sobrio')!;

  test('una forma de una pieza que el DOM pinta como fila de 3 tarjetas es defecto (fac2bce5, precios)', () => {
    const p = parsePagePlanMd('# Plan\n- direccion: premium-sobrio\n\n## 07-faq · #faq\n- forma: narrow-accordion\n- focal: acordeón\n- superficie: base');
    const r = pageSensors([measure([sec('07-faq', 'faq', [3])])], { plan: p, direction: { direction: ps, brandFonts: true } });
    expect(dir(r)).toEqual([['07-faq', 'forma narrow-accordion en el DOM']]);
  });

  test('casos medido como stats se compara con la fila stats de la dirección', () => {
    const p = parsePagePlanMd('# Plan\n- direccion: premium-sobrio\n\n## 05-casos · #casos\n- forma: stats-row\n- focal: métricas\n- superficie: base');
    expect(dir(pageSensors([measure([sec('05-casos', 'stats', [3])])], { plan: p, direction: { direction: ps, brandFonts: true } }))).toEqual([]);
  });

  // #292: con Bloque en la fila el DOM se mide contra el bloque elegido. Un direction.md de otro catálogo puede asignar
  // a la FAQ en card-grid el acordeón, que no la pinta: manda la forma del bloque.
  test('con bloque, el DOM se mide contra la forma del bloque elegido', () => {
    const tr = DIRECTIONS.find((x) => x.id === 'tarjetas-retail')!;
    const p = parsePagePlanMd('# Plan\n- direccion: tarjetas-retail\n\n## 07-faq · #faq\n- forma: card-grid\n- focal: acordeón\n- superficie: ' + tr.roles.faq.surface);
    const faq = BLOCK_CANDIDATES.find((c) => c.id === 'arc/faq-section:accordion')!;
    expect(dir(pageSensors([measure([sec('07-faq', 'faq', [3])])], { plan: p, direction: { direction: tr, brandFonts: true, blocks: { faq } } }))).toEqual([['07-faq', 'forma narrow-accordion en el DOM']]);
  });
});
