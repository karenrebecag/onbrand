// El gate sin navegador (src/brand-aa.ts bandRatios) contra chromium: Stats del base trae surface="muted" de fábrica y
// QA midió su caption a 4.31:1. Aquí se monta el bloque con las hojas reales del base y se mide lo que pinta el
// navegador, con y sin un pack que fija --text-secondary.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import contract from '../src/theme/contract.json';
import { bandRatios } from '../src/brand-aa';
import { contrast, type Rgb } from '../src/color-contrast';

const SRC = join(import.meta.dir, '..', 'templates', 'base-scaffold', 'src');
const SHEETS = ['theme/tokens.css', 'components/layout/layout.css', 'components/blocks/blocks.css'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
const MODULES = join(SRC, '..', 'node_modules');
let markup = '';

let browser: Browser;
// Rutas calculadas: react y sus tipos solo existen dentro del scaffold (como tests/arc/landing-blocks-content.test.ts).
beforeAll(async () => {
  if (!existsSync(join(MODULES, 'react'))) return;
  const { createElement } = await import(join(MODULES, 'react'));
  const { renderToStaticMarkup } = await import(join(MODULES, 'react-dom', 'server'));
  const { Stats } = await import(join(SRC, 'components', 'blocks', 'stats'));
  markup = renderToStaticMarkup(createElement(Stats, { id: 'cifras', slug: '06-cifras', items: [{ value: '12', label: 'Familias productoras' }] }));
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

/** Color del caption y fondo de la banda, pasados por un canvas: chromium devuelve el color-mix como oklab(), no rgb. */
async function measure(theme: 'light' | 'dark', rootStyle = ''): Promise<{ text: Rgb; band: Rgb }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<!doctype html><html data-theme="${theme}" style="${rootStyle}"><head><style>${SHEETS}</style></head><body>${markup}</body></html>`);
    return await page.evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
      const rgb = (css: string): [number, number, number] => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!]; };
      const caption = document.querySelector('.l-text--caption')!;
      const band = caption.closest('[data-wt-surface]')!;
      return { text: rgb(getComputedStyle(caption).color), band: rgb(getComputedStyle(band).backgroundColor) };
    });
  } finally {
    await page.close();
  }
}

describe.skipIf(!existsSync(join(MODULES, 'react')))('banda muted de Stats en chromium', () => {
  for (const mode of ['light', 'dark'] as const) {
    test(`el caption pasa AA y el gate mide lo mismo (${mode === 'light' ? 'claro' : 'oscuro'})`, async () => {
      const { text, band } = await measure(mode);
      const browserRatio = contrast(text, band);
      const table = mode === 'light' ? contract.light : { ...contract.light, ...contract.dark };
      const gate = bandRatios(table as Record<string, string>, mode)['--text-muted / band:muted']!;
      expect(browserRatio).toBeGreaterThanOrEqual(4.5);
      expect(Math.abs(browserRatio - gate) / gate).toBeLessThan(0.02);
    }, 30_000);
  }

  test('en oscuro el caption de la banda conserva el muted del tema y el del pack', async () => {
    expect((await measure('dark')).text).toEqual([0x9e, 0x9e, 0x9e]);
    expect((await measure('dark', '--text-muted: #8a8a8a')).text).toEqual([0x8a, 0x8a, 0x8a]);
  }, 30_000);

  test('con un pack que fija --text-secondary, el caption de la banda usa ese valor', async () => {
    const { text } = await measure('light', '--text-secondary: #4a4a4a');
    expect(text).toEqual([0x4a, 0x4a, 0x4a]);
  }, 30_000);
});
