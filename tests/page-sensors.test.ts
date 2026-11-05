import { describe, expect, test } from 'bun:test';
import { incompleteRows, pageSensors, textLeaves, type MeasuredSection, type PageMeasure } from '../src/page-sensors';

const EN = 'Plan the sprint with your team and ship the work that matters for every customer';
const section = (key: string, over: Partial<MeasuredSection> = {}): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame: false, height: 400, header: { align: 'start', text: 'Title' }, collections: [], hiddenBefore: 0, revealed: 0, text: EN, ...over });
const page = (sections: MeasuredSection[], over: Partial<PageMeasure> = {}): PageMeasure =>
  ({ viewport: 1440, lang: 'en', title: 'Nimbus', fonts: [{ family: 'IBM Plex Sans', count: 40, generic: false, loaded: true, declared: true }], animations: 0, sections, ...over });

describe('page-sensors: aserciones del contrato sobre la página medida', () => {
  test('una página como la de v0 (filas completas, cabeceras a la izquierda, lang y fuente bien) da 0 defectos y sí midió', () => {
    const r = pageSensors([page([section('04-features', { collections: [{ items: 6, rows: [3, 3], tag: 'li', cls: 'feature-grid' }] }), section('08-pricing', { collections: [{ items: 3, rows: [3], tag: 'li', cls: 'pricing-grid' }] })])], { lang: 'en' });
    expect(r.defects).toEqual([]);
    expect(r.checked['collection.rows']).toBe(2);
    expect(r.checked['section.align']).toBe(2);
  });

  test('3 items en 2 columnas es fila incompleta y la dueña es el contrato de bloque', () => {
    expect(incompleteRows([2, 1])).toBe(true);
    expect(incompleteRows([3, 3])).toBe(false);
    expect(incompleteRows([1, 1, 1])).toBe(false);
    const r = pageSensors([page([section('08-pricing', { collections: [{ items: 3, rows: [2, 1], tag: 'div', cls: 'x' }] })])]);
    expect(r.defects.map((d) => [d.field, d.owner, d.section, d.actual])).toEqual([['collection.rows', 'B', '08-pricing', '2+1']]);
  });

  test('una cabecera centrada contra el start del contrato es defecto; el marco no se afirma y el plan puede pedir center', () => {
    const sections = [section('09-faq', { header: { align: 'center', text: 'FAQ' } }), section('11-footer', { frame: true, header: { align: 'center', text: 'Product' } }), section('10-cta', { header: { align: 'center', text: 'Start' } })];
    const r = pageSensors([page(sections)], { sectionAlign: { '10-cta': 'center' } });
    expect(r.defects.map((d) => [d.field, d.section])).toEqual([['section.align', '09-faq']]);
  });

  test('una sección sin Section es section.contract; un container corrido es section.centered; el marco y v0 no', () => {
    const sections = [
      section('04-beneficios', { layout: { section: true, container: true, margins: { left: 144, right: 144 } } }),
      section('08-cierre', { layout: { section: false, container: false, margins: null } }),
      section('06-precios', { layout: { section: true, container: true, margins: { left: 20, right: 268 } } }),
      section('09-footer', { frame: true, layout: { section: false, container: false, margins: null } }),
      section('05-casos', { layout: null }),
    ];
    const r = pageSensors([page(sections)]);
    expect(r.defects.filter((d) => d.field.startsWith('section.c')).map((d) => [d.field, d.section])).toEqual([['section.contract', '08-cierre'], ['section.centered', '06-precios']]);
    expect([r.checked['section.contract'], r.checked['section.centered']]).toEqual([3, 2]);
  });

  test('una cabecera pegada al borde (cierre de cc7b8016, x=20 contra 144) es section.gutter; ±32 de v0 y el marco no', () => {
    const at = (key: string, left: number, over: Partial<MeasuredSection> = {}) => section(key, { header: { align: 'start', text: key, left }, ...over });
    const sections = [at('02-hero', 144), at('04-beneficios', 176), at('05-casos', 112), at('06-precios', 144), at('08-cierre', 20), at('09-footer', 720, { frame: true })];
    const r = pageSensors([page(sections)]);
    expect(r.defects.filter((d) => d.field === 'section.gutter').map((d) => [d.section, d.owner, d.actual])).toEqual([['08-cierre', 'B', 'x=20']]);
    expect(r.checked['section.gutter']).toBe(5);
  });

  test('un icono roto es icon.rendered del contrato de bloque; una sección sin medir iconos no se afirma', () => {
    const r = pageSensors([page([section('03-beneficios', { brokenIcons: ['Atención 24/7'] }), section('05-casos', { brokenIcons: [] }), section('06-precios')])]);
    expect(r.defects.filter((d) => d.field === 'icon.rendered').map((d) => [d.section, d.owner])).toEqual([['03-beneficios', 'B']]);
    expect(r.checked['icon.rendered']).toBe(2);
  });

  test('una página más ancha que el viewport a 375 (Figma Make: 465) es page.overflow; a 1440 sin scroll no', () => {
    const r = pageSensors([page([section('02-hero')], { overflow: { scrollWidth: 1440, clientWidth: 1440 } }), page([section('02-hero')], { viewport: 375, overflow: { scrollWidth: 465, clientWidth: 375 } })]);
    expect(r.defects.filter((d) => d.field === 'page.overflow').map((d) => [d.viewport, d.owner, d.actual])).toEqual([[375, 'B', '465px']]);
    expect(r.checked['page.overflow']).toBe(2);
  });

  test('el <title> de la plantilla o vacío es page.title; el de la página no', () => {
    const titled = (title: string) => pageSensors([page([section('02-hero')], { title })]).defects.filter((d) => d.field === 'page.title').map((d) => d.actual);
    expect([titled('Figma Make App'), titled('Vite + React + TS'), titled(''), titled('Acme — Agentes de IA para WhatsApp')]).toEqual([['Figma Make App'], ['Vite + React + TS'], ['(vacío)'], []]);
  });

  test('la FAQ narrow de Section (container a 336 a 1440) respeta su margen; sin Section a 20 sigue siendo gutter', () => {
    const at = (key: string, left: number, container?: number) => section(key, { header: { align: 'start', text: key, left }, ...(container === undefined ? {} : { layout: { section: true, container: true, margins: { left: container, right: container } } }) });
    const r = pageSensors([page([at('02-hero', 144, 144), at('05-casos', 144, 144), at('07-faq', 336, 336), at('08-cierre', 20)])]);
    expect(r.defects.filter((d) => d.field === 'section.gutter').map((d) => d.section)).toEqual(['08-cierre']);
  });

  test('section.detail: focal sin soporte (beneficios de c9c5a540) o soporte sin focal es defecto; una franja no se afirma', () => {
    const none = { photos: 0, mockups: 0, icons: 0, steps: 0, figures: 0, interactive: 0 };
    const sup = (o: Partial<NonNullable<MeasuredSection['support']>>) => ({ chips: 0, iconLabels: 0, notes: 0, action: false, ...o });
    const r = pageSensors([page([
      section('03-beneficios', { visuals: { ...none, icons: 4 }, support: sup({}) }),
      section('04-pasos', { visuals: { ...none, steps: 3 }, support: sup({ chips: 3 }) }),
      section('05-texto', { visuals: none, support: sup({ notes: 2 }) }),
      section('08-cierre', { visuals: none, support: sup({ notes: 1, action: true }) }),
      section('02-logos', { height: 100, visuals: none, support: sup({}) }),
    ])]);
    expect(r.defects.filter((d) => d.field === 'section.detail').map((d) => [d.section, d.actual])).toEqual([['03-beneficios', 'sin detalle de soporte'], ['05-texto', 'sin elemento focal']]);
    expect(r.checked['section.detail']).toBe(4);
  });

  test('lang del documento y texto de una sección en otro idioma son defectos del contrato de página', () => {
    const r = pageSensors([page([section('03-logos', { text: 'Equipos que confían en nosotros. Más de 300 empresas ya trabajan con nosotros cada día' })], { lang: 'es' })], { lang: 'en' });
    expect(r.defects.map((d) => [d.field, d.owner, d.actual])).toEqual([['page.lang', 'A', 'es'], ['section.lang', 'A', 'es']]);
  });

  test('una fuente nombrada sin @font-face cargada cae a la del sistema; una genérica no se afirma', () => {
    const r = pageSensors([page([section('02-hero')], { fonts: [{ family: 'Geist Variable', count: 5, generic: false, loaded: false, declared: false }, { family: 'system-ui', count: 3, generic: true, loaded: false, declared: false }] })], { lang: 'en' });
    expect(r.defects.map((d) => [d.field, d.actual])).toEqual([['brand.fonts', 'sin @font-face']]);
  });

  test('las entradas animadas pasan el presupuesto a partir de la segunda sección, en orden de página', () => {
    const r = pageSensors([page([section('02-hero', { revealed: 5 }), section('05-stats', { revealed: 4 }), section('10-cta', { revealed: 1 })])], { lang: 'en' });
    expect(r.defects.map((d) => [d.field, d.section])).toEqual([['page.motion', '05-stats'], ['page.motion', '10-cta']]);
  });

  test('a 375 solo se afirman colecciones y alineación: lang, fuentes y motion no se cuentan dos veces', () => {
    const narrow = page([section('08-pricing', { collections: [{ items: 3, rows: [2, 1], tag: 'div', cls: 'x' }] })], { viewport: 375, lang: 'es' });
    const r = pageSensors([page([section('08-pricing')]), narrow], { lang: 'en' });
    expect(r.defects.map((d) => [d.field, d.viewport])).toEqual([['collection.rows', 375]]);
  });

  test('el texto que el composer decidió y no llega a la página es defecto: L6 si el runner no lo emitió, B si el bloque no lo pinta', () => {
    const section = { role: 'pricing', children: [{ component: 'card', props: { title: 'Free', variant: 'secondary', action: { $slot: { component: 'button', props: { size: 'md' }, children: { $slot: { text: 'body', value: 'Start for free' } } } } } }, { component: 'stat', props: { label: 'Per member, per month' } }] };
    const leaves = textLeaves(section);
    expect(leaves).toEqual(['Free', 'Start for free', 'Per member, per month']);
    const measured = page([section0('08-pricing', 'Free $0', 'Free $0')]);
    const r = pageSensors([measured], { lang: 'en' }, [{ key: '08-pricing', leaves, source: '<Card title={"Free"} action={<Button size={"md"} />} /><Stat label={"Per member, per month"} />' }]);
    expect(r.defects.filter((d) => d.field === 'content.emitted').map((d) => [d.owner, d.actual])).toEqual([['L6', 'no está en el TSX'], ['B', 'en el TSX, no en el DOM']]);
  });

  test('texto en un aria-label o en un desplegable cerrado ya está en domText y no es defecto', () => {
    const r = pageSensors([page([section0('01-navbar', 'Home', 'Home Main navigation')])], { lang: 'en' }, [{ key: '01-navbar', leaves: ['Main navigation'], source: 'label={"Main navigation"}' }]);
    expect(r.defects.filter((d) => d.field === 'content.emitted')).toEqual([]);
  });
});

const section0 = (key: string, text: string, domText: string): MeasuredSection => ({ key, role: key.replace(/^\d+-/, ''), frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text, domText });
