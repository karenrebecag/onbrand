import { expect, test } from 'bun:test';
import { browse } from '../src/runtime/browser';

const PAGE = `<!doctype html><body style="margin:0">${['01-hero', '02-beneficios', '03-precios', '04-faq'].map((s) => `<section data-wt-role="${s.slice(3)}" data-wt-slug="${s}" style="height:900px">${s}</section>`).join('')}</body>`;

// #403 (9cab1be0): a 375 la visión de la página entera (11 tramos) no respondió en 40 s; con `section` mira solo esa sección.
test('con section se capturan solo los tramos de esa sección, a la escala pedida', async () => {
  const url = `data:text/html,${encodeURIComponent(PAGE)}`;
  const r = await browse({ url, viewport: 375, full: true, actions: [], section: 'precios', scale: 0.75 });
  expect(r.from).toBe(1800);
  expect(r.shownHeight).toBe(2700);
  expect(r.pngs).toHaveLength(2);
  expect(r.pngs[0].readUInt32BE(16)).toBe(281);
  const all = await browse({ url, viewport: 375, full: true, actions: [], section: 'contacto' });
  expect(all.actionErrors[0]).toContain('sección "contacto" no encontrada');
  expect(all.pngs).toHaveLength(5);
}, 60_000);
