import { describe, expect, test } from 'bun:test';
import { pageSensors, type MeasuredSection, type PageMeasure } from '../src/page-sensors';
import { parsePagePlanMd } from '../src/page-plan-md';

const ES = 'Agentes de IA que responden, califican y agendan a tus clientes por WhatsApp las veinticuatro horas';
const section = (key: string, over: Partial<MeasuredSection> = {}): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame: false, height: 400, header: { align: 'start', text: 'x' }, collections: [], hiddenBefore: 0, revealed: 0, text: ES, ...over });
const page = (sections: MeasuredSection[]): PageMeasure =>
  ({ viewport: 1440, lang: 'es', title: 'Acme', fonts: [{ family: 'Inter', count: 40, generic: false, loaded: true, declared: true }], animations: 0, sections });
const entry = (slug: string, f: Record<string, string>): string => `## ${slug} · #a\n${Object.entries(f).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
const FULL = { titular: 'Cero leads perdidos', apoyo: 'a', cta: 'ninguno', conteo: '4 tarjetas', focal: 'iconos', detalle: 'chip con el dato', superficie: 'muted', inventado: 'nada' };
const plan = (...entries: string[]) => parsePagePlanMd(`# Plan\nNegocio: Acme\n\n${entries.join('\n\n')}`);
const plans = (r: ReturnType<typeof pageSensors>) => r.defects.filter((d) => d.field.startsWith('plan.')).map((d) => [d.field, d.section, d.actual]);
const obeys = (over: Partial<MeasuredSection> = {}) => section('03-features', {
  domText: 'Cero leads <perdidos> y cuatro tarjetas', collections: [{ items: 4, rows: [4], tag: 'li', cls: 'g' }],
  surface: { declared: 'muted', bg: 'x', page: 'y' }, support: { chips: 4, iconLabels: 0, notes: 0, action: false }, ...over,
});

describe('plan.*: la página obedece a page-plan.md (ADR 0012)', () => {
  test('sin campo plan no se afirma nada; un workspace del agente sin plan es plan.exists', () => {
    expect(pageSensors([page([obeys()])]).checked['plan.exists']).toBe(0);
    expect(plans(pageSensors([page([obeys()])], { plan: null }))).toEqual([['plan.exists', '-', 'no está']]);
    expect(plans(pageSensors([page([obeys()])], { plan: parsePagePlanMd('solo prosa') }))).toEqual([['plan.exists', '-', '0']]);
  });

  test('una entrada sin campos obligatorios es plan.exists; navbar y footer sin sección medida no se afirman', () => {
    const { detalle: _d, ...noDetail } = FULL;
    const r = pageSensors([page([obeys()])], { plan: plan(entry('00-navbar', { ...FULL, focal: 'ninguno' }), entry('03-features', noDetail)) });
    expect(plans(r)).toEqual([['plan.exists', '03-features', 'falta detalle']]);
  });

  test('plan.copy: el titular aparece en el DOM aunque lo partan spans o comillas; si no, o si falta la sección, es defecto', () => {
    expect(plans(pageSensors([page([obeys()])], { plan: plan(entry('03-features', { ...FULL, titular: '"Cero leads perdidos"' })) }))).toEqual([]);
    const r = pageSensors([page([obeys({ domText: 'Nunca pierdas un lead' })])], { plan: plan(entry('03-features', FULL), entry('05-precios', FULL)) });
    expect(plans(r)).toEqual([['plan.copy', '03-features', '(no está en el DOM)'], ['plan.copy', '05-precios', 'no está']]);
  });

  test('plan.count: 4 tarjetas contra una colección de 3 es defecto; una lista sin grid no se afirma', () => {
    expect(plans(pageSensors([page([obeys({ collections: [{ items: 3, rows: [3], tag: 'li', cls: 'g' }] })])], { plan: plan(entry('03-features', FULL)) }))).toEqual([['plan.count', '03-features', '3']]);
    const r = pageSensors([page([obeys({ collections: [] })])], { plan: plan(entry('03-features', FULL)) });
    expect([plans(r), r.checked['plan.count']]).toEqual([[], 0]);
  });

  test('plan.surface: el plan pide muted y la sección no declara superficie (base) es defecto', () => {
    expect(plans(pageSensors([page([obeys({ surface: { declared: null, bg: 'x', page: 'x' } })])], { plan: plan(entry('03-features', FULL)) }))).toEqual([['plan.surface', '03-features', 'base']]);
  });

  test('plan.detail: lo citado entre comillas debe estar en el DOM; sin cita, basta un soporte medido', () => {
    const quoted = plan(entry('03-features', { ...FULL, detalle: 'nota bajo el CTA: "Sin tarjeta de crédito"' }));
    expect(plans(pageSensors([page([obeys({ domText: 'Cero leads perdidos. Sin tarjeta de crédito' })])], { plan: quoted }))).toEqual([]);
    expect(plans(pageSensors([page([obeys()])], { plan: quoted }))).toEqual([['plan.detail', '03-features', '(no está en el DOM)']]);
    expect(plans(pageSensors([page([obeys({ support: { chips: 0, iconLabels: 0, notes: 0, action: true } })])], { plan: plan(entry('03-features', FULL)) }))).toEqual([['plan.detail', '03-features', 'sin chip, etiqueta ni nota']]);
  });

  test('plan.detail descriptivo no se exige en la FAQ ni en el marco: ahí solo cuenta lo citado', () => {
    const faq = section('07-preguntas', { domText: 'Preguntas frecuentes', support: { chips: 0, iconLabels: 0, notes: 0, action: false } });
    const r = pageSensors([page([faq])], { plan: plan(entry('07-preguntas', { ...FULL, titular: 'Preguntas frecuentes', detalle: 'respuestas concretas', conteo: 'ninguno' })) });
    expect([plans(r), r.checked['plan.detail']]).toEqual([[], 0]);
  });

  test('plan.copy no se afirma en navbar ni footer: su titular es la marca, a menudo un logo', () => {
    const nav = section('01-navbar', { domText: 'Beneficios Precios' });
    const r = pageSensors([page([nav])], { plan: plan(entry('01-navbar', { ...FULL, titular: 'Acme (wordmark)', conteo: 'ninguno', focal: 'ninguno' })) });
    expect([plans(r), r.checked['plan.copy']]).toEqual([[], 0]);
  });
});

