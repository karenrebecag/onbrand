import { describe, expect, test } from 'bun:test';
import { brandSensors, type BrandExpect } from '../src/brand-sensors';
import { brandExpectOf } from '../src/brand-pack';
import type { PageMeasure } from '../src/page-sensors';

const ACME: BrandExpect = { name: 'Acme', accent: { base: '#ff6600' }, fonts: { display: 'Grift', body: 'Inter Tight' }, surface: { background: '#fafafa' } };
const font = (family: string, loaded = true) => ({ family, count: 20, generic: false, loaded, declared: true });
const page = (accent: PageMeasure['accent'], fonts: PageMeasure['fonts'], pageBg: string): PageMeasure =>
  ({ viewport: 1440, lang: 'es', title: '', fonts, animations: 0, accent, sections: [{ key: '02-hero', role: 'hero', frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: '', surface: { declared: 'base', bg: pageBg, page: pageBg } }] });

describe('brand-sensors', () => {
  test('la página de hoy (orange del scaffold, Inter y Geist, fondo blanco) no aplica el pack de Acme', () => {
    const d = brandSensors(page({ attr: 'orange', rgb: 'rgb(244, 129, 32)' }, [font('Inter Variable'), font('Geist Variable')], 'rgb(255, 255, 255)'), ACME);
    expect(d.map((x) => [x.field, x.expected])).toEqual([['brand.accent', '#ff6600'], ['brand.typeface', 'Grift'], ['brand.typeface', 'Inter Tight'], ['brand.background', '#fafafa']]);
  });

  test('con el pack aplicado no hay defectos, aunque el DS redondee el acento al pasarlo por oklch', () => {
    expect(brandSensors(page({ attr: null, rgb: 'rgb(253, 104, 2)' }, [font('Grift'), font('Inter Tight Variable')], 'rgb(250, 250, 250)'), ACME)).toEqual([]);
  });

  test('una fuente de marca declarada que no carga es defecto; un acento preset se compara por nombre', () => {
    const d = brandSensors(page({ attr: 'blue', rgb: 'rgb(0, 0, 255)' }, [font('Grift', false)], 'rgb(255, 255, 255)'), { name: 'Base', accent: 'orange', fonts: { display: 'Grift' } });
    expect(d.map((x) => [x.field, x.actual])).toEqual([['brand.accent', 'blue'], ['brand.typeface', 'Grift sin cargar']]);
  });
});

describe('brand.highlight-area: el color de identidad de detalle no pinta CTAs ni áreas grandes', () => {
  // Acme con el mapeo invertido: el interactivo (--accent) es oscuro y el naranja es --brand-highlight.
  const ACME_INV: BrandExpect = { ...ACME, accent: { base: '#0a0a0a' }, tokens: { '--brand-highlight': '#ff6600' } };
  const withAreas = (areas: NonNullable<PageMeasure['highlightAreas']>): PageMeasure => ({ ...page({ attr: null, rgb: 'rgb(10, 10, 10)' }, [font('Grift'), font('Inter Tight')], 'rgb(250, 250, 250)'), highlightAreas: areas });

  test('un CTA o una burbuja con el naranja son defecto; un badge o un punto no', () => {
    const d = brandSensors(withAreas([
      { tag: 'a', text: 'Agenda tu demo', bg: 'rgb(255, 102, 0)', area: 9600, section: 'hero' },
      { tag: 'div', text: 'Hola, ¿en qué te ayudo?', bg: 'rgb(253, 104, 2)', area: 14000, section: 'features' },
      { tag: 'span', text: 'Más elegido', bg: 'rgb(255, 102, 0)', area: 2107, section: 'pricing' },
      { tag: 'span', text: '', bg: 'rgb(255, 102, 0)', area: 64, section: 'stats' },
    ]), ACME_INV);
    expect(d.map((x) => [x.field, x.section])).toEqual([['brand.highlight-area', 'hero'], ['brand.highlight-area', 'features']]);
  });

  test('una marca cuyo color de identidad es el interactivo puede pintar CTAs con él', () => {
    const d = brandSensors(withAreas([{ tag: 'a', text: 'Empezar', bg: 'rgb(255, 102, 0)', area: 9600, section: 'hero' }]), ACME);
    expect(d.filter((x) => x.field === 'brand.highlight-area')).toEqual([]);
  });

  // c20c9574: el svg de Acme ya es el wordmark y DirectionalHeader pinta además brandName="Acme".
  test('brand.logo marca un wordmark junto al nombre de la marca en texto, no junto a otro texto', () => {
    const m = page({ attr: null, rgb: 'rgb(253, 104, 2)' }, [font('Grift'), font('Inter Tight')], 'rgb(250, 250, 250)');
    const nav = { ...m.sections[0]!, key: '01-navbar', role: 'navbar', logos: [{ src: '/brand/logo.svg', text: 'Acme' }] };
    const foot = { ...m.sections[0]!, key: '10-footer', role: 'footer', logos: [{ src: '/brand/logo.svg', text: 'Inicio' }] };
    expect(brandSensors({ ...m, sections: [nav, foot] }, ACME).map((x) => [x.field, x.section])).toEqual([['brand.logo', '01-navbar']]);
  });

  // HACK #25 cerrado: con logoKind manda el pack; la proporción solo decide si el pack no lo declara.
  const navWith = (ratio: number) => {
    const m = page({ attr: null, rgb: 'rgb(253, 104, 2)' }, [font('Grift'), font('Inter Tight')], 'rgb(250, 250, 250)');
    return { ...m, sections: [{ ...m.sections[0]!, key: '01-navbar', role: 'navbar', logos: [{ src: '/brand/logo.svg', text: 'Acme', ratio }] }] };
  };
  const logoField = (m: PageMeasure, pack: BrandExpect) => brandSensors(m, pack).filter((x) => x.field === 'brand.logo').map((x) => x.section);

  test('logoKind wordmark: un wordmark apilado (cuadrado) junto al nombre también lo repite', () => {
    expect(logoField(navWith(1), { ...ACME, logoKind: 'wordmark' })).toEqual(['01-navbar']);
  });

  test('logoKind mark: un símbolo junto al nombre es legítimo aunque sea ancho', () => {
    expect(logoField(navWith(4), { ...ACME, logoKind: 'mark' })).toEqual([]);
  });

  test('sin pack (identidad efímera, sin logoKind) decide la proporción: ancho es wordmark, cuadrado no', () => {
    expect(logoField(navWith(4), ACME)).toEqual(['01-navbar']);
    expect(logoField(navWith(1), ACME)).toEqual([]);
  });

  test('un pack sin logoKind es mark por contrato: un logo ancho junto al nombre no es defecto; con wordmark sí', () => {
    const raw = { name: 'Acme', accent: 'orange' };
    expect(brandExpectOf(raw).logoKind).toBe('mark');
    expect(logoField(navWith(4), brandExpectOf(raw))).toEqual([]);
    expect(logoField(navWith(4), brandExpectOf({ ...raw, logoKind: 'wordmark' }))).toEqual(['01-navbar']);
  });
});
