import { expect, test } from 'bun:test';
import { pageSensors, type MeasuredSection, type PageMeasure } from '../src/page-sensors';
import { parsePagePlanMd } from '../src/page-plan-md';
import { BLOCK_CANDIDATES, DIRECTIONS } from '../src/directions';

const d = DIRECTIONS.find((x) => x.id === 'editorial-serif')!;
const cand = (id: string) => BLOCK_CANDIDATES.find((c) => c.id === id)!;
const sec = (key: string, role: string, extra: Partial<MeasuredSection>): MeasuredSection =>
  ({ key, role, frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: 'texto de la sección en español para el sensor de idioma', ...extra });
const page = (s: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: 'Acme', animations: 0, sections: s, fonts: [] });
const of = (r: ReturnType<typeof pageSensors>, field: string) => r.defects.filter((x) => x.field === field).map((x) => x.section);

// 3fc160a7: el bloque elegido para el cierre era CtaSection centered y el contrato general marcaba el titular centrado.
test('section.align mide contra la variante del bloque elegido cuando la sección lo importa', () => {
  const cta = cand('arc/cta-section:centered');
  const cierre = sec('08-cierre', 'cta', { header: { align: 'center', text: 'Agenda tu demo' } });
  const blocks = { direction: { direction: d, brandFonts: true, blocks: { cta } } };
  const uses = `import { CtaSection } from "${cta.importPath}";\n<CtaSection variant="centered" />`;
  expect(of(pageSensors([page([cierre])], { ...blocks, sources: { '08-cierre': uses } }), 'section.align')).toEqual([]);
  expect(of(pageSensors([page([cierre])], { ...blocks, sources: { '08-cierre': '<section />' } }), 'section.align')).toEqual(['08-cierre']);
});

// 3fc160a7: FaqSection columns muestra una categoría por vez; el plan pedía 5 y el DOM contaba 3.
test('plan.count cuenta los items del código en un bloque que pinta una parte', () => {
  const faq = cand('arc/faq-section:columns');
  const s = sec('07-preguntas', 'faq', { collections: [{ items: 3, rows: [3], tag: 'div', cls: 'q' }] });
  const plan = parsePagePlanMd('# Plan\n\n## 07-preguntas · #preguntas\n- conteo: 5 preguntas');
  const items = Array.from({ length: 5 }, (_, i) => `{ question: "P${i}", answer: "R${i}" }`).join(', ');
  const e = { plan, direction: { direction: d, brandFonts: true, blocks: { faq } } };
  expect(of(pageSensors([page([s])], { ...e, sources: { '07-preguntas': `import { FaqSection } from "${faq.importPath}";\n<FaqSection variant="columns" items={[${items}]} />` } }), 'plan.count')).toEqual([]);
  expect(of(pageSensors([page([s])], { ...e, sources: { '07-preguntas': `const items = [${items}];` } }), 'plan.count')).toEqual(['07-preguntas']);
});

// c734443f: PricingTable de Morphin trae su contenedor y su cabecera arranca en 232 con el margen en 160.
test('section.gutter cede ante el bloque importado', () => {
  const pricing = cand('morphin/morphin-pricing-table');
  const at = (key: string, role: string, left: number) => sec(key, role, { header: { align: 'start', text: role, left } });
  const s = [at('03-beneficios', 'features', 160), at('04-pasos', 'steps', 160), at('05-casos', 'testimonials', 160), at('06-precios', 'pricing', 232)];
  const blocks = { direction: { direction: d, brandFonts: true, blocks: { pricing } } };
  expect(of(pageSensors([page(s)], { ...blocks, sources: { '06-precios': `import { PricingTable } from "${pricing.importPath}";` } }), 'section.gutter')).toEqual([]);
  expect(of(pageSensors([page(s)], { ...blocks, sources: { '06-precios': '<section />' } }), 'section.gutter')).toEqual(['06-precios']);
});
