import { describe, expect, test } from 'bun:test';
import type { CatalogEntry } from '../src/catalog/schema';
import { deterministicCopy } from '../src/copy';
import { deterministicGenerator, headlinePicker } from '../src/copygen/deterministic';
import { extractFacts } from '../src/copygen/facts';
import { generatePageCopy } from '../src/copygen/generate';
import { llmCopyGenerator, parsePageContentOutput, type PageContentInput } from '../src/copygen/generator';

const SUMMARY = 'Acme Pulse: agente de IA que responde el WhatsApp de un e-commerce, recupera carritos y convierte chats en ventas. Landing completa: logos, features, cómo funciona, métricas, testimonios, planes y preguntas frecuentes.';

// Entrada mínima del catálogo: sin source ni origin legible, el modelo de slot cae al canon.
const entry = (role: NonNullable<CatalogEntry['role']>, slug = `${role}_x`): CatalogEntry => ({
  library: 'relume', kind: 'block', slug, name: slug, role, category: role, tags: [],
  surface: { light: 'base', dark: 'base' }, geometry: 'g', verified: false, source: null,
  origin: { kind: 'vault', path: `nope/${slug}.tsx`, sha256: '0'.repeat(64) },
  export: 'X', importPath: `@/x/${slug}`, manifest: null,
});

describe('facts — hechos del brief', () => {
  test('separa nombre, descriptor, beneficios (verbos) y audiencia; descarta la frase que lista secciones', () => {
    const f = extractFacts(SUMMARY, 'agendar una demo', 'es');
    expect(f.name).toBe('Acme Pulse');
    expect(f.descriptor).toBe('agente de IA');
    expect(f.benefits).toEqual(['responde el WhatsApp de un e-commerce', 'recupera carritos', 'convierte chats en ventas']);
    expect(f.audience).toBe('e-commerce');
    expect(f.goal).toBe('agendar una demo');
    expect(f.extras).toEqual([]);
  });

  test('sin relativo todo es descriptor y la audiencia sale de "para"', () => {
    const f = extractFacts('Nimbus: copiloto de IA para equipos de producto. Súmate a la lista de espera.', undefined, 'es');
    expect(f.descriptor).toBe('copiloto de IA para equipos de producto');
    expect(f.benefits).toEqual([]);
    expect(f.audience).toBe('equipos de producto');
    expect(f.goal).toBe('empezar');
  });
});

describe('generador determinista — escribe copy real por campo dentro del presupuesto', () => {
  test('genera el RoleCopy de la página desde el brief, sin placeholders y sin repetir titulares', async () => {
    const brief = { summary: SUMMARY, goal: 'agendar una demo' };
    const blocks = (['navbar', 'hero', 'features', 'testimonials', 'faq', 'cta', 'footer'] as const).map((r) => ({ role: r, entry: entry(r) }));
    const { copy, input, request } = await generatePageCopy({ brief, blocks, lang: 'es' });
    expect(copy.hero?.heading).toBe('Agente de IA para e-commerce');
    expect(copy.hero?.primaryCta).toBe('Agendar una demo');
    expect(copy.features?.items.map((i) => i.title)).toEqual(['Responde el WhatsApp', 'Recupera carritos', 'Convierte chats en ventas']);
    expect(copy.features?.items[1].description).toContain('Acme Pulse recupera carritos');
    expect(copy.faq?.items[0]).toEqual({ question: '¿Qué es Acme Pulse?', answer: 'Acme Pulse es un agente de IA que responde el WhatsApp de un e-commerce, recupera carritos y convierte chats en ventas.' });
    expect(copy.cta?.heading).toBe('¿Listo para agendar una demo?');
    expect(copy.testimonials?.items.length).toBe(3);
    expect(JSON.stringify(copy)).not.toMatch(/Beneficio \d|Lorem|Pregunta \d/);
    const headings = [copy.hero?.heading, copy.features?.heading, copy.testimonials?.heading, copy.faq?.heading, copy.cta?.heading];
    expect(new Set(headings).size).toBe(headings.length);
    // El inputJson tiene la forma de page-content-1: secciones con campos presupuestados e idioma.
    expect(input.sections[1]['input text fields'][0]).toMatchObject({ id: 1, 'css classes': 'heading hero.heading', 'max length': '8 words' });
    expect(request.language).toBe('Spanish');
    expect(request.languageLOTE).toBe('Spanish');
  });

  test('cada campo respeta su presupuesto (text-fit) y el idioma cambia las plantillas', async () => {
    const brief = { summary: SUMMARY, goal: 'book a demo' };
    const { copy, request } = await generatePageCopy({ brief, blocks: [{ role: 'hero', entry: entry('hero') }, { role: 'cta', entry: entry('cta') }], lang: 'en' });
    expect(request.languageLOTE).toBeUndefined();
    expect(copy.hero?.heading.split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(copy.hero?.description.split(/\s+/).length).toBeLessThanOrEqual(16);
    expect(copy.hero?.secondaryCta).toBe('See how it works');
    expect(copy.cta?.heading).toBe('Ready to book a demo?');
  });

  test('headlinePicker devuelve el primer candidato libre y cae al primero si todos están usados', () => {
    const pick = headlinePicker();
    expect(pick(['A', 'B'])).toBe('A');
    expect(pick(['a!', 'B'])).toBe('B');
    expect(pick(['A', 'B'])).toBe('A');
  });

  test('el generador acepta el inputJson crudo (contrato page-content-1) y responde por section_id', async () => {
    const input: PageContentInput = {
      'company description': 'Lumen: agenda para clínicas que confirma citas por WhatsApp.',
      'all pages': ['Inicio'], 'page name': 'Inicio', 'page sections': ['hero'], 'page additional instructions': 'probar gratis',
      sections: [{ section_id: 'section_0', category: 'hero', outline: '', 'input text fields': [
        { id: 1, 'css classes': 'heading hero.heading', 'max length': '5 words', 'placeholder text': 'x' },
        { id: 2, 'css classes': 'cta hero.primaryCta', 'max length': '1 word', 'placeholder text': 'Button' },
      ] }],
    };
    const out = await deterministicGenerator.generate({ inputJson: JSON.stringify(input), language: 'Spanish', languageLOTE: 'Spanish' });
    expect(out.sections[0].section_id).toBe('section_0');
    expect(out.sections[0].real_text_fields[0].text.split(/\s+/).length).toBeLessThanOrEqual(5);
    expect(out.sections[0].real_text_fields[1].text).toBe('Probar gratis');
  });
});

describe('frontera LLM — adaptador inyectable y parser tolerante (OQ)', () => {
  test('parsePageContentOutput ignora lo mal formado y solo acepta {id:number, text:string}', () => {
    const out = parsePageContentOutput({ sections: [{ section_id: 'section_0', real_text_fields: [{ id: 1, text: 'Hola' }, { id: '2', text: 'no' }, null] }, 'basura', { nope: 1 }] });
    expect(out.sections).toEqual([{ section_id: 'section_0', real_text_fields: [{ id: 1, text: 'Hola' }] }]);
    expect(parsePageContentOutput('x')).toEqual({ sections: [] });
  });

  test('llmCopyGenerator delega en el transporte inyectado y su salida pasa por el mismo text-fit', async () => {
    const seen: string[] = [];
    const fake = llmCopyGenerator(async (prompt, ctx) => {
      seen.push(prompt, ctx.language);
      const input = JSON.parse(ctx.inputJson) as PageContentInput;
      return { sections: input.sections.map((s) => ({ section_id: s.section_id, real_text_fields: s['input text fields'].map((f) => ({ id: f.id, text: `Texto muy largo para el campo ${f.id} que claramente excede cualquier presupuesto razonable de palabras del slot` })) })) };
    });
    const { copy, generator } = await generatePageCopy({ brief: { summary: 'X: hace cosas.' }, blocks: [{ role: 'hero', entry: entry('hero') }], generator: fake });
    expect(generator).toBe('llm');
    expect(seen).toEqual(['page-content-1', 'Spanish']);
    expect(copy.hero?.heading.split(/\s+/).length).toBeLessThanOrEqual(8);
  });
});

describe('logos — solo marcas reales del brief (D4)', () => {
  const blocks = (['hero', 'logos', 'features'] as const).map((r) => ({ role: r, entry: entry(r) }));

  test('sin brief.brands el copy no trae la clave logos, ni en es/en ni en el fallback, y no se pide la sección', async () => {
    for (const lang of ['es', 'en'] as const) {
      const { copy, input } = await generatePageCopy({ brief: { summary: SUMMARY }, blocks, lang });
      expect(copy.logos).toBeUndefined();
      expect(input['page sections']).not.toContain('logos');
    }
    expect(deterministicCopy({ summary: SUMMARY, brands: ['  '] }).logos).toBeUndefined();
  });

  test('con brief.brands el marquee lleva exactamente esas marcas y el generador no las redacta', async () => {
    const { copy, input } = await generatePageCopy({ brief: { summary: SUMMARY, brands: ['X', 'Y'] }, blocks, lang: 'es' });
    expect(copy.logos?.brands).toEqual(['X', 'Y']);
    expect(copy.logos?.heading).toBeTruthy();
    const logosFields = input.sections.find((s) => s.category === 'logos')?.['input text fields'].map((f) => f['css classes']);
    expect(logosFields).toEqual(['heading logos.heading']);
    expect(deterministicCopy({ summary: SUMMARY, brands: ['X', 'Y'] }).logos?.brands).toEqual(['X', 'Y']);
  });
});
