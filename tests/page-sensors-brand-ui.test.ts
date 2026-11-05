import { expect, test } from 'bun:test';
import { pageSensors, type MeasuredSection, type PageMeasure } from '../src/page-sensors';

const sec = (key: string, role: string, extra: Partial<MeasuredSection>): MeasuredSection =>
  ({ key, role, frame: false, height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: 'texto de la sección en español para el sensor de idioma', ...extra });
const page = (s: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: 'Acme', animations: 0, sections: s, fonts: [] });
const of = (s: MeasuredSection[], field: string) => pageSensors([page(s)]).defects.filter((x) => x.field === field).map((x) => x.section);
const green = 'rgb(37, 211, 102)';
const btn = (border: string, radius = 8, bg = green) => ({ text: 'Agendar demo', bg, border, radius });

// c20c9574: el CTA verde del navbar lleva borde negro y los del hero, precios y cierre no.
test('button.unified marca la acción que se aparta del estilo de las demás con el mismo fondo', () => {
  const s = [sec('01-navbar', 'navbar', { actions: [btn('1px rgb(10, 10, 10)')] }), sec('02-hero', 'hero', { actions: [btn('none'), btn('1px rgb(229, 229, 229)', 8, 'rgb(255, 255, 255)')] }), sec('07-precios', 'pricing', { actions: [btn('none'), btn('none')] }), sec('09-cierre', 'cta', { actions: [btn('none', 9)] })];
  expect(of(s, 'button.unified')).toEqual(['01-navbar']);
});

// c20c9574: TestimonialStage sin `photo` pinta "VM" en el panel del retrato.
test('portrait.empty marca un retrato con iniciales y no una sección sin ellas', () => {
  expect(of([sec('06-testimonios', 'testimonials', { initials: ['VM'] }), sec('05-casos', 'stats', { initials: [] })], 'portrait.empty')).toEqual(['06-testimonios']);
});
