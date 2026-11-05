import { describe, expect, test } from 'bun:test';
import { planRoles, requestedRoles, roleOfKey, softRoles, structureSimilarity, varietyPairs, type PlannedPage } from '../src/plan-sensors';
import type { MeasuredSection, PageMeasure } from '../src/page-sensors';

const sec = (key: string, cols: number[] = []): MeasuredSection =>
  ({ key, role: key, frame: false, height: 400, header: null, collections: cols.map((c) => ({ items: c, rows: [c], tag: 'li', cls: '' })), hiddenBefore: 0, revealed: 0, text: '' });
const measure = (sections: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: '', fonts: [], animations: 0, sections });
const page = (id: string, brief: string, keys: [string, number[]?][]): PlannedPage => ({ id, brief, measure: measure(keys.map(([k, c]) => sec(k, c))) });

const NIMBUS = 'Landing page for Nimbus. Include a hero, logos, features, how it works, stats, testimonials, pricing, FAQ and a CTA.';
const ACME = 'Quiero una landing para Acme. Incluye beneficios, cómo funciona, casos de éxito con métricas, precios y preguntas frecuentes.';
const LUMBRE = 'Landing page for Café Lumbre. Include a hero with a photo, a logo for the brand in the header, 3 features with icons, customer testimonials with avatars, and a CTA to order online.';
// Las 11 fijas de DEFAULT_ROLES, como salen hoy para cualquier brief.
const FIXED: [string, number[]?][] = [['01-navbar'], ['02-hero'], ['03-logos', [6]], ['04-features', [3]], ['05-stats', [4]], ['06-steps', [3]], ['07-testimonials', [3]], ['08-pricing', [3]], ['09-faq'], ['10-cta'], ['11-footer']];

describe('plan-sensors: las secciones salen del brief', () => {
  test('el vocabulario lee la lista del brief en en y es; "un logo en el header" no pide la sección logos', () => {
    expect([...requestedRoles(ACME)].sort()).toEqual(['cases', 'faq', 'features', 'pricing', 'stats', 'steps']);
    expect(requestedRoles(LUMBRE).has('logos')).toBe(false);
    expect(['05-como-funciona', '03-metrics-strip', '06-casos', '09-final-cta', '06-section', '01-header'].map(roleOfKey)).toEqual(['steps', 'stats', 'cases', 'cta', 'other', 'frame']);
  });

  test('las páginas de v0 dan 0: lo pedido está, hero y cierre son implícitos y un slug sin rol cubre lo que falta', () => {
    const v0 = [
      page('v0-acme', ACME, [['01-header'], ['02-hero'], ['03-metrics-strip', [4]], ['04-beneficios'], ['05-como-funciona', [4]], ['06-casos'], ['07-precios', [3]], ['08-faq'], ['09-final-cta'], ['10-footer']]),
      page('v0-lumbre', LUMBRE, [['01-header'], ['02-hero', [3]], ['03-nosotros', [3]], ['04-testimonios', [3]], ['05-pedido'], ['06-footer']]),
      page('v0-j049', NIMBUS, [['01-header'], ['02-hero'], ['03-logos', [6]], ['04-features', [3]], ['05-how-it-works', [3]], ['06-section', [4]], ['07-customers', [3]], ['08-pricing', [3]], ['09-faq'], ['10-cta'], ['11-footer']]),
    ];
    expect(v0.flatMap(planRoles)).toEqual([]);
    expect(varietyPairs(v0)).toEqual([]);
  });

  test('las 11 fijas para el brief de Acme traen logos y testimonials sin pedirlos y les faltan los casos', () => {
    expect(planRoles(page('wt-acme', ACME, FIXED)).map((d) => [d.field, d.actual])).toEqual([['plan.roles', 'falta'], ['plan.roles', 'logos'], ['plan.roles', 'testimonials']]);
  });

  test('un rol pedido que no está y ningún slug sin rol lo cubre es defecto', () => {
    expect(planRoles(page('p', 'Incluye precios y preguntas frecuentes.', [['01-hero'], ['02-faq']])).map((d) => d.expected)).toEqual(['pricing']);
  });
});

describe('plan-sensors: dos briefs distintos no dan la misma página', () => {
  test('Nimbus y Acme con las 11 fijas: misma secuencia y misma forma', () => {
    const d = varietyPairs([page('wt-nimbus', NIMBUS, FIXED), page('wt-acme', ACME, FIXED)]);
    expect(d.map((x) => x.field)).toEqual(['variety.sequence', 'variety.structure']);
  });

  test('la forma cuenta columnas, no items: 3 tarjetas y 6 en 3 columnas son la misma sección', () => {
    const a = measure([sec('04-features', [3])]);
    const b = measure([{ ...sec('04-features'), collections: [{ items: 6, rows: [3, 3], tag: 'li', cls: '' }] }]);
    expect(structureSimilarity(a, b)).toBe(1);
  });

  test('el mismo brief dos veces no se compara: variedad es entre briefs', () => {
    expect(varietyPairs([page('a', NIMBUS, FIXED), page('b', NIMBUS, FIXED)])).toEqual([]);
  });
});

describe('plan-sensors: atributos y briefs sin lista', () => {
  test('"casos de éxito con métricas" pide cases y deja stats opcional: no falta dentro de cases ni sobra aparte', () => {
    const inCases = page('orq', ACME, [['01-navbar'], ['02-hero'], ['03-features', [3]], ['04-steps', [3]], ['05-cases', [3]], ['06-pricing', [3]], ['07-faq'], ['08-cta'], ['09-footer']]);
    const apart = page('v0', ACME, [['01-header'], ['02-hero'], ['03-metrics-strip', [4]], ['04-beneficios'], ['05-como-funciona', [4]], ['06-casos'], ['07-precios', [3]], ['08-faq'], ['09-final-cta'], ['10-footer']]);
    expect([...softRoles(ACME)]).toEqual(['stats']);
    expect(planRoles(inCases)).toEqual([]);
    expect(planRoles(apart)).toEqual([]);
  });

  test('un brief sin lista pide hero y entre 2 y 5 secciones de contenido; las 11 fijas (7 de contenido) se pasan', () => {
    const OPEN = 'Landing para Lumbre, una taquería en la Roma. Queremos que la gente pida por WhatsApp.';
    expect(planRoles(page('ok', OPEN, [['01-navbar'], ['02-hero'], ['03-features'], ['04-steps'], ['05-testimonials'], ['06-faq'], ['07-cta'], ['08-footer']]))).toEqual([]);
    expect(planRoles(page('fijas', OPEN, FIXED)).map((d) => d.actual)).toEqual(['7']);
  });
});
