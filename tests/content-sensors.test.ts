import { describe, expect, test } from 'bun:test';
import { contentDemo, contentRepeat, ctaBudget, factsDisclosed, fragmentLang } from '../src/content-sensors';
import type { MeasuredSection, PageMeasure } from '../src/page-sensors';

const sec = (key: string, fragments: string[], links: { href: string; text: string }[] = []): MeasuredSection => ({
  key, role: key.replace(/^\d+-/, ''), frame: /navbar|header|footer/.test(key), height: 400, header: null, collections: [],
  hiddenBefore: 0, revealed: 0, text: fragments.join(' '), fragments, links: links.map((l) => ({ ...l, target: null })),
});
const page = (...sections: MeasuredSection[]): PageMeasure => ({ viewport: 1440, lang: 'es', title: 'Acme', fonts: [], animations: 0, sections });
const WA = 'https://wa.me/5215500000000?text=Hola';
const fields = (d: { field: string }[]): string[] => d.map((x) => x.field);

describe('content.repeat', () => {
  test('la persona de los casos que vuelve como cita en el cierre es un defecto (Acme final5)', () => {
    const m = page(
      sec('05-cases', ['Mariana Cordero, Gerente de Ventas en Casa Rumbo']),
      sec('08-cta', ['"Con Acme dejamos de perder consultas"', 'Mariana Cordero, Gerente de Ventas en Casa Rumbo']),
    );
    expect(contentRepeat(m).map((d) => d.message.split('"')[1]).sort()).toEqual(['Casa Rumbo', 'Mariana Cordero']);
  });

  test('2 cifras repetidas están en el rango de v0 (j049: 4,000+ y 80+); la tercera es defecto', () => {
    const two = page(sec('03-logos', ['4,000+ teams', '80+ integrations']), sec('10-cta', ['Join 4,000+ teams', 'All 80+ integrations']));
    expect(contentRepeat(two)).toEqual([]);
    const three = page(sec('02-hero', ['62% resueltas', '5 días', '8 seg']), sec('03-features', ['62%', '5 días', '8 seg']));
    expect(fields(contentRepeat(three))).toEqual(['content.repeat']);
  });

  test('un nombre en Title Case que es la etiqueta de un botón no es una persona', () => {
    const m = page(sec('02-hero', ['Start Free'], [{ href: '#pricing', text: 'Start Free' }]), sec('10-cta', ['Start Free'], [{ href: '#pricing', text: 'Start Free' }]));
    expect(contentRepeat(m)).toEqual([]);
  });
});

describe('cta.budget', () => {
  test('la acción en steps y footer, 6 secciones y 5 veces la misma etiqueta (Acme final5)', () => {
    const cta = { href: WA, text: 'Agenda tu demo por WhatsApp' };
    const m = page(sec('01-navbar', [], [cta]), sec('02-hero', [], [cta]), sec('04-steps', [], [cta]), sec('06-pricing', [], [{ href: WA, text: 'Agenda tu demo del plan Inicio' }]), sec('08-cta', [], [cta]), sec('09-footer', [], [cta]));
    const msgs = ctaBudget(m).map((d) => `${d.section}:${d.actual}`);
    expect(msgs).toEqual(['-:6', '-:5', '04-steps:presente', '09-footer:presente']);
  });

  test('el patrón de la página de v0 de referencia pasa: header, hero, precios y cierre con etiquetas que varían', () => {
    const m = page(
      sec('01-header', [], [{ href: '#precios', text: 'Precios' }, { href: WA, text: 'Agendar demo' }]),
      sec('02-hero', [], [{ href: WA, text: 'Agendar demo por WhatsApp' }]),
      sec('07-precios', [], [{ href: WA, text: 'Agendar demo' }, { href: WA, text: 'Agendar demo' }, { href: WA, text: 'Hablar con ventas' }]),
      sec('09-final-cta', [], [{ href: WA, text: 'Agendar demo por WhatsApp' }]),
    );
    expect(ctaBudget(m)).toEqual([]);
  });
});

describe('content.demo', () => {
  const corpus = new Set(['q3 launch plan', 'start free trial', '$10 per seat']);
  test('una tarjeta que ES la demo del bloque es un defecto (features en Acme)', () => {
    expect(contentDemo(page(sec('03-features', ['Q3 launch plan', 'Un agente que vende'])), corpus).map((d) => d.actual)).toEqual(['"q3 launch plan"']);
  });

  test('una frase genérica de la demo o una coincidencia dentro de un texto más largo no lo es', () => {
    const m = page(sec('02-hero', ['Start free trial']), sec('08-pricing', ['$10 per seat each month when billed yearly']));
    expect(contentDemo(m, corpus)).toEqual([]);
  });

  test('lo que pide el brief no cuenta como demo', () => {
    expect(contentDemo(page(sec('03-features', ['Q3 launch plan'])), corpus, 'Incluye el Q3 launch plan')).toEqual([]);
  });
});

describe('section.lang.fragment', () => {
  test('una tarjeta en inglés dentro de una sección en español es un defecto aunque la mayoría sea español', () => {
    const m = page(sec('03-features', ['Un solo agente en todos tus canales comparte el mismo contexto', 'Pricing review with the finance team']));
    expect(fragmentLang(m, 'es').map((d) => d.actual)).toEqual(['en']);
  });
});

describe('facts.disclosed', () => {
  const m = page(sec('05-cases', ['"Hoy el agente cierra pedidos"', 'Laura Gómez, Gerente Comercial', '+38% ventas']), sec('07-precios', ['US$99 /mes'], [{ href: '#', text: 'Términos' }]));

  test('sin resumen que declare lo inventado es un defecto (nuestro stream de hoy)', () => {
    expect(factsDisclosed(m, '').map((d) => d.actual)).toEqual(['sin declaración']);
  });

  test('el resumen de v0 j049 cubre las 4 clases', () => {
    const v0 = 'Placeholder content: all customer names, quotes, stats and prices are invented, and the footer links don\'t go anywhere yet.';
    expect(factsDisclosed(m, v0)).toEqual([]);
  });

  test('la sección "Datos de ejemplo" del agente declara cada dato en su viñeta', () => {
    const agent = '**3. Datos de ejemplo**\n- **WhatsApp `5215500000000`:** en el navbar.\n- **Casos:** empresas, personas, citas y métricas.\n- **Precios:** US$ 79 y US$ 249.\n\n**4. Pendiente**\n- Menú móvil.';
    expect(factsDisclosed(m, agent)).toEqual([]);
  });

  test('la frase de Lovable que abre una lista con dos puntos declara cada viñeta de la lista', () => {
    const lovable = 'Inventé algunos datos para tener contenido de ejemplo, así que necesito los reales:\n- **Número de WhatsApp:** puse uno de prueba.\n- **Casos de éxito:** las métricas, los giros y las citas son ejemplos.\n- **Precios y planes:** $99 y $299 son inventados.\n\nTodavía no he revisado la página.';
    expect(factsDisclosed(m, lovable)).toEqual([]);
  });

  test('un follow-up solo declara lo que agrega: lo del mensaje base ya se declaró', () => {
    expect(factsDisclosed(m, 'Agregué el menú móvil.', m)).toEqual([]);
  });

  test('las credenciales de Stitch (auditado, G2, ISO, SLA, partner) son inventadas si no se declaran', () => {
    const stitch = page(sec('02-hero', ['4.9/5 en G2 Enterprise']), sec('05-casos', ['Auditado', '+210% citas agendadas']), sec('09-footer', ['Meta Business Partner', 'GDPR & ISO 27001 Ready', '99.9% SLA Uptime']));
    const msg = 'Casos de éxito con métricas auditadas en LATAM. Las cifras de los casos son de ejemplo.';
    expect(factsDisclosed(stitch, msg).map((d) => d.expected)).toEqual(['declarar credentials']);
    expect(factsDisclosed(stitch, 'Las cifras y las certificaciones son de ejemplo.')).toEqual([]);
  });

  test('una credencial que trae el brief no es inventada; "API oficial" no es credencial', () => {
    const p = page(sec('02-hero', ['Conexión con la API oficial de Meta', 'Certificados ISO 27001']));
    expect(factsDisclosed(p, 'Listo.', undefined, 'Somos ISO 27001 desde 2023.')).toEqual([]);
  });

  test('el resumen de Figma Make declara con "ilustrativo": los casos cubren cifras y personas, y el WhatsApp va en la misma nota', () => {
    const figma = 'Nota: el enlace de WhatsApp tiene el mensaje precargado, pero falta reemplazarlo por el número oficial. Los casos y precios son contenido ilustrativo y deben validarse antes de publicar.';
    expect(factsDisclosed(m, figma)).toEqual([]);
    expect(factsDisclosed(m, 'Los precios son ilustrativos.').map((d) => d.expected).sort()).toEqual(['declarar figures', 'declarar links', 'declarar people']);
  });

  test('un resumen que declara solo los nombres deja sin nombrar cifras, precios y enlaces', () => {
    expect(factsDisclosed(m, 'Los nombres de clientes son ficticios.').map((d) => d.expected).sort()).toEqual(['declarar figures', 'declarar links', 'declarar prices']);
  });
});
