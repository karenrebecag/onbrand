import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { changedSlugs, clickControls, interactionDefects } from '../src/interaction-sensor';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

describe('preview.interaction', () => {
  test('las secciones cambiadas salen del diff: el tsx y su module.css son la misma sección; el resto no cuenta', () => {
    expect(changedSlugs(['src/sections/02-hero.tsx', 'src/sections/02-hero.module.css', 'src/App.tsx', 'src/sections/10-cierre.tsx', ''])).toEqual(['02-hero', '10-cierre']);
  });

  // QA 2026-10-29: "Calcular ahorro" llamaba a window.atomCalc.open() sin script y la verificación del turno no lo vio.
  test('pulsa los botones de las secciones cambiadas y nombra el que tira; no toca submits ni secciones sin cambios', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const sink: { errors: string[] | null } = { errors: null };
    const outside: string[] = [];
    page.on('pageerror', (e) => (sink.errors ? sink.errors.push(e.message) : outside.push(e.message)));
    try {
      await page.setContent(`<!doctype html><html><body>
        <section data-wt-slug="02-hero">
          <button onclick="window.atomCalc.open()">Calcular ahorro</button>
          <button onclick="this.textContent = 'ok'">Ver video</button>
          <button style="display:none" onclick="null.x">Menú</button>
          <form><button type="button" onclick="null.lead">Enviar lead</button></form>
          <button type="submit" onclick="null.submit">Enviar</button>
        </section>
        <section data-wt-slug="05-precios"><button onclick="null.precios">Plan</button></section>
      </body></html>`);
      const failures = await clickControls(page, ['02-hero'], sink);
      expect(failures.map((f) => [f.slug, f.label])).toEqual([['02-hero', 'Calcular ahorro']]);
      const [d] = interactionDefects(failures, 1440);
      expect(d).toMatchObject({ field: 'preview.runtime', kind: 'interaction', slug: '02-hero', viewport: 1440 });
      expect(d?.message).toMatch(/^al pulsar "Calcular ahorro": .*reading 'open'/);
      expect(outside).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
