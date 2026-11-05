import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { PageMeasure } from '../src/page-sensors';

const SENSORS_JS = readFileSync(join(import.meta.dir, '..', 'scripts', 'page-sensors.browser.js'), 'utf8');
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

async function measure(html: string, width: number): Promise<PageMeasure> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(`<!doctype html><html lang="en"><body style="margin:0">${html}</body></html>`);
    await page.evaluate(SENSORS_JS);
    return await page.evaluate(() => (window as unknown as { __wtSensors: { post(): PageMeasure } }).__wtSensors.post());
  } finally {
    await page.close();
  }
}

const links = (style: string): string =>
  `<footer data-wt-role="footer" data-wt-slug="11-footer"><div style="display:flex;flex-wrap:wrap;gap:16px;width:240px">${
    ['Privacy policy', 'Terms of use', 'Cookie policy'].map((t) => `<a href="#" style="${style}">${t}</a>`).join('')
  }</div></footer>`;

describe('page-sensors.browser: qué cuenta como colección', () => {
  test('3 enlaces legales en flex-wrap a 375 son texto que fluye, no una colección en 2+1', async () => {
    const m = await measure(links(''), 375);
    expect(m.sections[0].collections).toEqual([]);
  });

  test('el mismo flex-wrap con items de ancho fijado por el contenedor sí es colección y se ve el 2+1', async () => {
    const m = await measure(links('flex:0 0 100px'), 375);
    expect(m.sections[0].collections.map((c) => c.rows)).toEqual([[2, 1]]);
  });
});

// Acordeón de uno abierto: abrir una pregunta desmonta la respuesta de la que estaba abierta.
const accordion = `<section data-wt-role="faq" data-wt-slug="09-faq"><h2>FAQ</h2>${
  [['a', 'Is my data secure?', 'Everything is encrypted in transit and at rest.', true], ['b', 'Can I cancel?', 'Cancel any time from settings.', false]]
    .map(([id, q, a, open]) => `<div><button aria-expanded="${open}" data-id="${id}" data-a="${a}">${q}</button>${open ? `<p>${a}</p>` : ''}</div>`).join('')
}</section><script>
for (const b of document.querySelectorAll('button')) b.onclick = () => {
  const opening = b.getAttribute('aria-expanded') === 'false';
  for (const o of document.querySelectorAll('button')) { o.setAttribute('aria-expanded', 'false'); o.nextElementSibling?.remove(); }
  if (opening) { b.setAttribute('aria-expanded', 'true'); b.insertAdjacentHTML('afterend', '<p>' + b.dataset.a + '</p>'); }
};
</script>`;

describe('page-sensors.browser: texto de desplegables', () => {
  test('la respuesta abierta por defecto sigue en domText aunque abrir otra la desmonte', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await page.setContent(`<!doctype html><html lang="en"><body>${accordion}</body></html>`);
      await page.evaluate(SENSORS_JS);
      const m = await page.evaluate(() => (window as unknown as { __wtSensors: { run(): Promise<PageMeasure> } }).__wtSensors.run());
      expect(m.sections[0].domText).toContain('Everything is encrypted in transit and at rest.');
      expect(m.sections[0].domText).toContain('Cancel any time from settings.');
    } finally {
      await page.close();
    }
  });
});

describe('page-sensors.browser: fragmentos', () => {
  test('un contador por dígitos se lee entero y cada tarjeta es su propio fragmento', async () => {
    const html = `<section data-wt-role="cases" data-wt-slug="05-cases"><h2>Casos</h2>`
      + `<p><span>3</span><span>8</span><span>%</span> más conversaciones</p>`
      + `<div><div>Un agente en todos tus canales</div><div>Pricing review with finance</div></div></section>`;
    const m = await measure(html, 1440);
    expect(m.sections[0].fragments).toEqual(['Casos', '38% más conversaciones', 'Un agente en todos tus canales', 'Pricing review with finance']);
  });
});

const L = '<style>.l-section{padding-inline:16px}.l-container{max-width:1152px;margin-inline:auto}</style>';

describe('page-sensors.browser: contrato de Section', () => {
  test('una sección con Section mide sus márgenes iguales; el cierre de cc7b8016 sin Section no tiene layout', async () => {
    const m = await measure(`${L}<section class="l-section" data-wt-role="features" data-wt-slug="04-beneficios"><div class="l-container"><h2>Beneficios</h2></div></section>
      <section data-wt-role="cta" data-wt-slug="08-cierre"><div style="padding:0 20px"><h2>Agenda</h2></div></section>`, 1440);
    expect(m.sections[0].layout).toEqual({ section: true, container: true, margins: { left: 144, right: 144 } });
    expect(m.sections[1].layout).toEqual({ section: false, container: false, margins: null });
  });

  test('sin data-wt-role (v0, Stitch) no se afirma', async () => {
    const m = await measure('<section><h2>Precios</h2></section>', 1440);
    expect(m.sections[0].layout).toBeNull();
  });
});

const bubble = (side: 'left' | 'right', text: string): string =>
  `<div style="align-self:${side === 'left' ? 'flex-start' : 'flex-end'};width:180px;padding:8px;border-radius:12px;background:#e5e5e5">${text}</div>`;
const chat = `<div style="display:flex;flex-direction:column;gap:8px;width:320px;height:240px">${
  bubble('left', 'Hola, ¿cuánto cuesta?') + bubble('right', 'El plan Pro parte en $299/mes.') + bubble('left', '¿Agendamos una demo?')
}</div>`;

describe('page-sensors.browser: riqueza por forma, no por atributos', () => {
  test('un chat de 3 burbujas sin figure ni aria-hidden es un mockup (el hero de v0, Stitch y el agente)', async () => {
    const m = await measure(`<section data-wt-role="hero" data-wt-slug="02-hero"><h1>Vende por WhatsApp</h1>${chat}</section>`, 1440);
    expect(m.sections[0].visuals?.mockups).toBe(1);
  });

  test('un acordeón sin aria-expanded (Stitch) cuenta como interactivo; su chevron no es iconografía', async () => {
    const q = (t: string) => `<div><button>${t}<svg width="20" height="20"><path d="M0 0L10 10"/></svg></button><p style="display:none">Respuesta larga a la pregunta</p></div>`;
    const m = await measure(`<section data-wt-role="faq" data-wt-slug="07-faq"><h2>Preguntas</h2>${q('¿Usa la API oficial?')}${q('¿Cuánto tarda?')}</section>`, 1440);
    expect(m.sections[0].visuals?.interactive).toBe(2);
    expect(m.sections[0].visuals?.icons).toBe(0);
  });

  test('el precio de un plan y los checks repetidos de su lista no son cifras ni iconografía', async () => {
    const check = '<div style="display:flex"><svg width="18" height="18"><circle cx="9" cy="9" r="8"/></svg><span>Incluye agentes y soporte por WhatsApp</span></div>';
    const m = await measure(`<section data-wt-role="pricing" data-wt-slug="06-precios"><h2>Planes</h2><p style="font-size:40px">$299</p><p style="font-size:40px">$149</p>${check.repeat(4)}</section>`, 1440);
    expect(m.sections[0].visuals).toMatchObject({ figures: 0, icons: 0 });
  });
});

describe('page-sensors.browser: detalle de soporte', () => {
  test('un chip al pie de la tarjeta (Stitch) cuenta como soporte; el texto de un botón no', async () => {
    const m = await measure(`<section data-wt-role="steps" data-wt-slug="04-pasos"><h2>Pasos</h2><div><h3>Conecta</h3><p>Vincula tu WhatsApp Business en minutos.</p><span style="font-size:12px;padding:2px 8px;border-radius:999px;background:#eef">Sin cambiar de número</span></div><button style="font-size:12px;background:#eef;border-radius:8px">Ver</button></section>`, 1440);
    expect(m.sections[0].support).toMatchObject({ chips: 1 });
  });
});

describe('page-sensors.browser: iconos que se pintan', () => {
  const card = (svg: string, title: string) => `<div><span>${svg}</span><h3>${title}</h3><p>Texto de la tarjeta con más de veinte letras.</p></div>`;
  test('un icono de trazo sin fill="none" (el reloj de c9c5a540) es glifo roto; con fill="none" o de relleno a propósito no', async () => {
    const clock = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M11.5 6V12.5L16.5 15" stroke="black"/><path d="M12 22a10 10 0 1 0 0-20a10 10 0 1 0 0 20Z" stroke="black"/></svg>';
    const outline = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/></svg>';
    const solid = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M13 3L4 14H12L11 21L20 10H12L13 3Z" fill="currentColor"/></svg>';
    const empty = '<svg viewBox="0 0 24 24" width="24" height="24"></svg>';
    const m = await measure(`<section data-wt-role="features" data-wt-slug="03-beneficios"><h2>Beneficios</h2>${card(clock, 'Atención 24/7')}${card(outline, 'Respuesta')}${card(solid, 'Rayo')}${card(empty, 'Vacío')}</section>`, 1440);
    expect(m.sections[0].brokenIcons?.map((t) => t.slice(0, 13))).toEqual(['Atención 24/7', 'VacíoTexto de']);
  });
});

describe('page-sensors.browser: ancho del documento', () => {
  test('un bloque de ancho fijo más ancho que 375 deja el documento con scroll horizontal', async () => {
    const m = await measure('<section data-wt-role="hero" data-wt-slug="02-hero"><h1>Acme</h1><div style="width:465px;height:10px"></div></section>', 375);
    expect(m.overflow).toEqual({ scrollWidth: 465, clientWidth: 375 });
  });
});
