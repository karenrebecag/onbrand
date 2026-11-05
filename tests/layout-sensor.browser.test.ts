import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { collectLayout, layoutDefects } from '../src/layout-sensor';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

describe('preview.layout', () => {
  // Q6: un copy más largo ya no lo mira el agente; a 375 lo tiene que ver el preview-check.
  test('a 375, el desborde y el CTA partido son defectos con su sección; un botón de una línea y un enlace de texto no', async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0;font:16px sans-serif">
        <section data-wt-slug="02-hero">
          <a href="#" style="display:inline-block;width:140px;background:#1a47c9;color:#fff;padding:8px">Agendar una demo por WhatsApp hoy</a>
          <button style="padding:24px">Ver video</button>
          <a href="#">Un enlace de texto que es largo y se parte en varias líneas sin ser botón</a>
        </section>
        <section data-wt-slug="05-precios"><div style="width:520px">Tabla</div></section>
      </body></html>`);
      const d = layoutDefects(await page.evaluate(collectLayout), 375);
      expect(d.map((x) => [x.kind, x.slug])).toEqual([['overflow', '05-precios'], ['cta-wrap', '02-hero']]);
      expect(d[1]?.message).toMatch(/^el botón "Agendar una demo por WhatsApp hoy" se parte en \d líneas$/);
    } finally {
      await page.close();
    }
  });
});
