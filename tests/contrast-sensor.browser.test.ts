import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { collectContrastSamples, contrastDefects, contrastRatio } from '../src/contrast-sensor';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

async function defects(html: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
    return contrastDefects(await page.evaluate(collectContrastSamples), 1440);
  } finally {
    await page.close();
  }
}

describe('contrast.wcag', () => {
  test('razón WCAG: negro sobre blanco es 21 y el gris de v0 (#8AA0AA) sobre blanco no llega a AA', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([0x8a, 0xa0, 0xaa], [255, 255, 255])).toBeLessThan(4.5);
  });

  // RE de iteración: Stitch pasó a fondo #0B1B3F y dejó texto oscuro fijo; Lovable usa oklch, que antes no se leía.
  test('un defecto por sección con el peor texto; oklch se mide, el texto claro sobre navy pasa y un fondo con imagen se salta', async () => {
    const out = await defects(`
      <section data-wt-slug="02-hero" style="background:#0B1B3F">
        <h1 style="color:oklch(0.97 0.01 250);font-size:48px">Titular claro</h1>
        <p style="color:#1e293b">Agendar demo</p>
        <span style="color:#334155">23:45</span>
      </section>
      <section data-wt-slug="03-beneficios" style="background:#fff"><p style="color:#111">Se lee bien</p></section>
      <section data-wt-slug="04-foto" style="background-image:linear-gradient(#000,#000)"><p style="color:#000">Sobre imagen</p></section>`);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: 'preview.runtime', kind: 'contrast', slug: '02-hero', viewport: 1440 });
    expect(out[0]?.message).toMatch(/^2 textos bajo WCAG AA; el peor, 1\.\d\d:1 en "Agendar demo"$/);
  });
});
