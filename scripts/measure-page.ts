// Medición de una página construida (brecha #5): alto a 1440 px, secciones y marco en el DOM.
//   bun scripts/measure-page.ts <distDir> [--width 1440] [--json out.json]
// Sirve <distDir> en estático (mismo criterio que scripts/render-gate.ts: asset ausente = 404), abre
// con playwright, baja hasta el fondo (los bloques aparecen al entrar en vista) y lee scrollHeight,
// los `data-wt-role` en orden, los landmarks (header/main/footer) y los hrefs que no resuelven en el DOM.

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const distDir = resolve(args[0] ?? '');
if (!args[0] || !existsSync(join(distDir, 'index.html'))) throw new Error('uso: bun scripts/measure-page.ts <distDir con index.html>');
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const width = Number(flag('--width', '1440'));

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = path === '/' ? join(distDir, 'index.html') : join(distDir, path);
    if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 });
    return new Response(Bun.file(file), { headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' } });
  },
});

export interface PageMeasure {
  width: number;
  height: number;
  roles: string[];
  landmarks: { header: number; main: number; footer: number; nav: number };
  /** hrefs del DOM que no son ancla existente, externo, mailto/tel ni ruta con destino en el dist. */
  unresolvedHrefs: string[];
  /** Links con `#` a secas: placeholders explícitos, a confirmar. */
  placeholders: number;
  errors: string[];
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${server.port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.evaluate(async () => {
    for (let y = 0; y <= document.documentElement.scrollHeight; y += 300) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
  });
  await page.waitForTimeout(800);
  const m = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('[id]')].map((e) => `#${e.id}`));
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
    // `#` a secas es placeholder explícito (regla de QA): se cuenta aparte, no como roto.
    const placeholders = hrefs.filter((h) => h.trim() === '#').length;
    const unresolved = hrefs.filter((h) => {
      if (!h) return true;
      if (h.trim() === '#') return false;
      if (h.startsWith('#')) return !ids.has(h);
      return !/^(https?:\/\/|mailto:|tel:)/i.test(h) && !h.startsWith('/');
    });
    return {
      height: document.documentElement.scrollHeight,
      roles: [...document.querySelectorAll('[data-wt-role]')].map((e) => e.getAttribute('data-wt-role') ?? ''),
      landmarks: { header: document.querySelectorAll('header').length, main: document.querySelectorAll('main').length, footer: document.querySelectorAll('footer').length, nav: document.querySelectorAll('nav').length },
      unresolvedHrefs: [...new Set(unresolved)],
      placeholders,
      rootHrefs: [...new Set(hrefs.filter((h) => h.startsWith('/')))],
    };
  });
  // Una ruta `/x` resuelve solo si existe en el dist (ruta legal del starter); si no, es link roto.
  const brokenRoutes = m.rootHrefs.filter((h) => h !== '/' && !existsSync(join(distDir, h)) && !existsSync(join(distDir, h, 'index.html')) && !existsSync(join(distDir, `${h}.html`)));
  const out: PageMeasure = { width, height: m.height, roles: m.roles, landmarks: m.landmarks, unresolvedHrefs: [...m.unresolvedHrefs, ...brokenRoutes], placeholders: m.placeholders, errors };
  const jsonFlag = args.indexOf('--json');
  if (jsonFlag >= 0 && args[jsonFlag + 1]) writeFileSync(args[jsonFlag + 1], `${JSON.stringify(out, null, 2)}\n`);
  console.log(`alto ${out.height}px a ${width}px | ${out.roles.length} secciones: ${out.roles.join(' > ')} | landmarks header=${out.landmarks.header} nav=${out.landmarks.nav} main=${out.landmarks.main} footer=${out.landmarks.footer} | hrefs sin resolver: ${out.unresolvedHrefs.length ? out.unresolvedHrefs.join(', ') : 'ninguno'} | placeholders "#": ${out.placeholders}${errors.length ? ` | errores: ${errors.length}` : ''}`);
} finally {
  await browser.close();
  server.stop(true);
}
