import { describe, expect, test } from 'bun:test';
import { actionLinks, attachmentsUsed, brandNames, ctaTarget, deadLinks, editScope, imagesRequested, sectionActions, surfacePainted } from '../src/intent-sensors';
import type { MeasuredSection, PageMeasure } from '../src/page-sensors';

const sec = (key: string, over: Partial<MeasuredSection> = {}): MeasuredSection =>
  ({ key, role: key.replace(/^\d+-/, ''), frame: /header|navbar|footer/.test(key), height: 400, header: null, collections: [], hiddenBefore: 0, revealed: 0, text: '', ...over });
const page = (sections: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: '', fonts: [], animations: 0, sections });
const ACME = 'Quiero una landing para Acme. Objetivo: que agenden una demo por WhatsApp.';
const wa = (text: string) => ({ href: 'https://wa.me/5215500000000?text=hola', text, target: null });

describe('intent-sensors', () => {
  test('un # dentro de una sección de contenido es enlace muerto; en el marco no se afirma, como v0 j049', () => {
    const m = page([sec('02-hero', { links: [{ href: '#', text: 'Ver demo', target: null }, { href: '#steps', text: 'Pasos', target: false }] }), sec('11-footer', { links: [{ href: '#', text: 'Blog', target: null }] })]);
    expect(deadLinks(m).map((d) => [d.section, d.actual])).toEqual([['02-hero', '#'], ['02-hero', '#steps']]);
  });

  test('con WhatsApp en el brief, un enlace que lo nombra y va a #cta es defecto, y hace falta al menos un wa.me', () => {
    const ours = page([sec('02-hero', { links: [{ href: '#cta', text: 'Agenda tu demo por WhatsApp', target: true }] })]);
    expect(ctaTarget(ours, ACME).map((d) => d.section)).toEqual(['02-hero', '-']);
    expect(ctaTarget(page([sec('02-hero', { links: [wa('Agenda tu demo por WhatsApp')] })]), ACME)).toEqual([]);
    expect(ctaTarget(ours, 'Landing para Nimbus')).toEqual([]);
  });

  test('un nombre propio en un alt que no está en el brief ni en el texto visible es otra marca', () => {
    const img = (alt: string) => ({ src: '/images/x.jpg', alt, width: 1280, height: 720 });
    const m = page([sec('02-hero', { text: 'Acme vende por WhatsApp', domText: 'Conversación en la que Pulso responde', images: [img('Conversación de WhatsApp en la que Pulso responde'), img('Ejemplo de un agente de Acme en WhatsApp')] })]);
    expect(brandNames(m, ACME).map((d) => d.actual)).toEqual(['Pulso']);
    const logos = page([sec('03-logos', { text: 'Trusted by 4,000+ remote teams', images: [img('Tandem Harbor'), img('Fernwick Labs')] })]);
    expect(brandNames(logos, 'Landing for Nimbus')).toEqual([]);
  });

  test('un adjunto cuenta como usado si hay una imagen cargada con sus dimensiones, aunque cambie el nombre', () => {
    const att = [{ name: 'image.png', width: 2048, height: 1450 }];
    expect(attachmentsUsed(page([sec('05-steps')]), att).map((d) => d.field)).toEqual(['attachments.used']);
    expect(attachmentsUsed(page([sec('05-como-funciona', { images: [{ src: 'https://blob/x.png', alt: 'Infografía', width: 2048, height: 1450 }] })]), att)).toEqual([]);
  });

  test('el follow-up que nombra cómo funciona y beneficios solo puede cambiar esas; header y footer no se confunden', () => {
    const before = page([sec('01-header', { text: 'Acme Precios' }), sec('04-beneficios', { text: 'a' }), sec('05-como-funciona', { text: 'b' }), sec('07-precios', { text: 'c' }), sec('10-footer', { text: 'Acme 2026' })]);
    const after = page([sec('01-header', { text: 'Acme Precios' }), sec('04-beneficios', { text: 'a2' }), sec('05-como-funciona', { text: 'b2' }), sec('07-precios', { text: 'c2' }), sec('10-footer', { text: 'Acme 2026' })]);
    const d = editScope(before, after, 'Agrega la infografía en "Cómo funciona" y una imagen en beneficios.');
    expect(d.map((x) => x.section)).toEqual(['07-precios']);
  });

  test('un follow-up que cambia el título principal nombra el hero', () => {
    const before = page([sec('02-hero', { text: 'Atiende por WhatsApp' }), sec('04-features', { text: 'a' })]);
    const after = page([sec('02-hero', { text: 'Vende por WhatsApp mientras duermes' }), sec('04-features', { text: 'a' }), sec('05-integrations', { text: 'Shopify' })]);
    expect(editScope(before, after, 'Cambia el título principal a "Vende por WhatsApp mientras duermes" y agrega una sección de integraciones.')).toEqual([]);
  });

  test('el follow-up que pide generar una imagen para beneficios necesita una imagen nueva ahí; la infografía adjunta no cuenta', () => {
    const fu = 'Agrega esta infografía en la sección "Cómo funciona". Y genera otra imagen nueva para la sección de beneficios.';
    const att = [{ name: 'i.png', width: 2048, height: 1450 }];
    const info = { src: '/x.png', alt: 'Infografía', width: 2048, height: 1450 };
    const before = page([sec('03-features'), sec('04-steps')]);
    const ours = page([sec('03-features', { text: 'otro texto' }), sec('04-steps', { images: [info] })]);
    expect(imagesRequested(before, ours, fu, att).map((d) => d.section)).toEqual(['03-features']);
    const v0 = page([sec('03-features', { images: [{ src: '/p.jpg', alt: 'Persona', width: 1200, height: 800 }] }), sec('04-steps', { images: [info] })]);
    expect(imagesRequested(before, v0, fu, att)).toEqual([]);
  });

  test('una sección que pide muted y pinta el mismo fondo que la página es defecto; sin data-wt-surface no se afirma', () => {
    const white = 'rgb(255, 255, 255)';
    const m = page([sec('03-logos', { surface: { declared: 'muted', bg: white, page: white } }), sec('07-precios', { surface: { declared: 'muted', bg: 'rgb(244, 244, 244)', page: white } }), sec('08-faq', { surface: { declared: null, bg: white, page: white } })]);
    expect(surfacePainted(m).map((d) => d.section)).toEqual(['03-logos']);
  });

  test('una acción de page.json (texto + href) tiene que salir como <a> con ese destino; un <button> sin enlace es defecto', () => {
    const pricing = { role: 'pricing', children: [{ component: 'pricing10_block', props: { plans: [{ planName: 'Free', button: { title: 'Start free', href: '#cta' } }], cta: { label: 'Hablar con ventas', href: 'https://wa.me/1' }, legal: { label: 'Términos', href: '#' } } }] };
    const actions = sectionActions('08-pricing', pricing);
    expect(actions.map((a) => [a.label, a.href])).toEqual([['Start free', '#cta'], ['Hablar con ventas', 'https://wa.me/1']]);
    const m = page([sec('08-pricing', { links: [{ href: 'https://wa.me/1', text: 'Hablar con ventas', target: null }] })]);
    expect(actionLinks(m, actions).map((d) => [d.field, d.owner, d.actual])).toEqual([['cta.link', 'B', 'sin <a>']]);
  });
});

describe('edit.scope con ids que escribe el agente', () => {
  test('dos secciones fuera del vocabulario ("preguntas", "cierre") no se comparan entre sí', () => {
    const before = page([sec('06-preguntas', { text: '¿Necesito programar?' }), sec('07-cierre', { text: 'Agenda tu demo' })]);
    const after = page([sec('06-preguntas', { text: '¿Necesito programar?' }), sec('07-cierre', { text: 'Agenda tu demo' })]);
    expect(editScope(before, after, 'Agrega esta infografía en "Cómo funciona"')).toEqual([]);
  });
});
