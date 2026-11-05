import { describe, expect, test } from 'bun:test';
import { parsePagePlan, planUserJson } from '../src/runtime/page-plan';

// ADR 0008, entrega 2: el plan ES el contrato de página. Antes el composer tiraba lang/surface/emphasis y
// nunca pedía title/facts, así que page.json llegaba sin `page` y el documento quedaba con el lang y el
// título del scaffold (8ae26d51: <html lang="es"> + "Acme Pulse" en una página EN).
const facts = {
  brand: 'Nimbus',
  cta: { label: 'Start free trial', href: '#cta' },
  figures: [{ value: '4,000+', claim: 'remote teams' }],
  companies: ['Hexabyte', 'Solstice'],
  people: [{ name: 'Priya Raman', role: 'VP Engineering', company: 'Hexabyte' }],
  prices: [{ plan: 'Team', monthly: '$12', yearly: '$10' }],
};
const sec = (role: string, over: Record<string, unknown> = {}) => ({ role, objective: `objetivo de ${role}`, proof: 'none', avoid: [], density: 'normal', surface: 'base', emphasis: 'medium', ...over });

describe('plan como contrato de página', () => {
  test('acepta title, description, facts y motion; el nombre largo del idioma se mapea al código', () => {
    const r = parsePagePlan({ lang: 'English', title: 'Nimbus — Project management for remote teams', description: 'Plan, track and ship.', arc: 'x', facts, sections: [sec('hero', { motion: 'entrance' }), sec('cta')] }, ['hero', 'cta']);
    expect(r.errors).toEqual([]);
    expect(r.plan?.lang).toBe('en');
    expect(r.plan?.title).toBe('Nimbus — Project management for remote teams');
    expect(r.plan?.facts).toEqual(facts);
    expect(r.plan?.sections.map((s) => s.motion)).toEqual(['entrance', 'none']); // default none
  });

  test('rechaza facts incompletos, title largo y motion fuera del enum; un idioma desconocido no pasa', () => {
    const r = parsePagePlan({ lang: 'fr', title: 'x'.repeat(121), arc: 'x', facts: { brand: 'N', cta: { label: 'Go' }, figures: [{ value: '1' }], companies: 'Hexabyte', people: [] }, sections: [sec('hero', { motion: 'bounce' })] }, ['hero']);
    expect(r.plan).toBeUndefined();
    const all = r.errors.join(' | ');
    for (const e of ['lang:', 'title:', 'facts.cta', 'facts.figures', 'facts.companies', 'sections[0].motion']) expect(all).toContain(e);
  });
});

// ADR 0010: el plan decide las secciones. El parser valida contra el vocabulario, no contra una lista recibida.
describe('plan decide las secciones', () => {
  const vocab = ['hero', 'features', 'cases', 'cta'];
  test('acepta roles repetidos del vocabulario y conserva el orden del plan', () => {
    const r = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero'), sec('features'), sec('features'), sec('cta')] }, vocab);
    expect(r.errors).toEqual([]);
    expect(r.plan?.sections.map((s) => s.role)).toEqual(['hero', 'features', 'features', 'cta']);
  });
  test('rechaza un rol fuera del vocabulario, un plan sin hero y uno de más de 10 secciones', () => {
    expect(parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero'), sec('gallery')] }, vocab).errors.join(' ')).toContain('gallery no está en el vocabulario');
    expect(parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('features'), sec('cta')] }, vocab).errors).toContain('sections: falta hero');
    const many = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero'), ...Array.from({ length: 10 }, () => sec('features'))] }, vocab);
    expect(many.errors.join(' ')).toContain('entre 1 y 10 secciones, llegaron 11');
  });
  test('con lista cerrada (--role-set) exige las requeridas: "faltan secciones"', () => {
    const r = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero')] }, ['hero', 'cta'], ['hero', 'cta']);
    expect(r.errors).toContain('faltan secciones: cta');
  });
});

// (c) con Arq (#165/#168): el plan elige la forma de cada sección entre los bloques maduros ofrecidos.
describe('plan elige el bloque por su forma', () => {
  const vocab = ['hero', 'features', 'cta'];
  const forms = { features: [{ slug: 'feat-a', form: '3 Columns, Cards' }, { slug: 'feat-b', form: 'split, Image' }] };
  test('conserva un block ofrecido para su rol y descarta en silencio uno que no lo está', () => {
    const r = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero', { block: 'hero-x' }), sec('features', { block: 'feat-b' }), sec('cta', { block: 'feat-a' })] }, vocab, [], forms);
    expect(r.errors).toEqual([]);
    expect(r.plan?.sections.map((s) => s.block)).toEqual([undefined, 'feat-b', undefined]);
  });
  test('planUserJson solo manda forms cuando hay algo que elegir', () => {
    expect(JSON.parse(planUserJson({ summary: 'b' }, vocab))).toEqual({ brief: { summary: 'b' }, vocabulary: vocab });
    expect(JSON.parse(planUserJson({ summary: 'b' }, vocab, forms)).forms).toEqual(forms);
  });
});

// P1 (QA cta.target / links.dead): los destinos externos viven en facts.links; WhatsApp es wa.me con número.
describe('facts.links', () => {
  const base = { lang: 'es', arc: 'x', sections: [sec('hero'), sec('cta')] };
  test('acepta whatsapp wa.me, correo, teléfono y redes https; sin links sigue valiendo', () => {
    const r = parsePagePlan({ ...base, facts: { ...facts, links: { whatsapp: 'https://wa.me/5215512345678', email: 'hola@acme.test', phone: '+52 55 1234 5678', social: [{ name: 'Instagram', href: 'https://instagram.com/acme' }] } } }, ['hero', 'cta']);
    expect(r.errors).toEqual([]);
    expect(r.plan?.facts?.links?.whatsapp).toBe('https://wa.me/5215512345678');
    expect(parsePagePlan({ ...base, facts }, ['hero', 'cta']).errors).toEqual([]);
  });
  test('rechaza un whatsapp que no es wa.me con número y una red sin https', () => {
    const r = parsePagePlan({ ...base, facts: { ...facts, links: { whatsapp: 'https://api.whatsapp.com/send?phone=1', social: [{ name: 'X', href: 'x.com/acme' }] } } }, ['hero', 'cta']);
    expect(r.plan).toBeUndefined();
    expect(r.errors.join(' ')).toContain('facts.links.whatsapp');
    expect(r.errors.join(' ')).toContain('facts.links.social');
  });
});

// Adjuntos en el plan (P1): el plan asigna cada imagen adjunta a una sección con alt honesto; un id ajeno se descarta.
describe('adjuntos en el plan', () => {
  const attachments = [{ id: 'captura-panel', name: 'captura-panel.png', width: 1600, height: 1000 }];
  test('conserva image de un adjunto real y descarta uno inventado; planUserJson los manda', () => {
    const r = parsePagePlan({ lang: 'es', arc: 'x', sections: [sec('hero', { image: { id: 'captura-panel', alt: 'Panel de Acme con conversaciones de WhatsApp' } }), sec('cta', { image: { id: 'foto-equipo', alt: 'x' } })] }, ['hero', 'cta'], [], {}, attachments);
    expect(r.errors).toEqual([]);
    expect(r.plan?.sections[0].image).toEqual({ id: 'captura-panel', alt: 'Panel de Acme con conversaciones de WhatsApp' });
    expect(r.plan?.sections[1].image).toBeUndefined();
    expect(JSON.parse(planUserJson({ summary: 'b' }, ['hero'], {}, attachments)).attachments).toEqual(attachments);
  });
});
