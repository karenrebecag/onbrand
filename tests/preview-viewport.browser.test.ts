import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium, type Browser } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DOM_BYTES, saveDom, serializeDom } from '../src/dom-snapshot';
import { checkViewport, type ViewportContext } from '../src/preview-viewport';

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
// A 375 la página tira sin parar; a 1440 un botón tira y otro no. Con un sink compartido, el ruido de 375 que cae
// mientras dura el clic de "Ver video" lo haría fallar.
const PAGE = `<!doctype html><html><body>
  <section data-wt-slug="02-hero"><button onclick="null.boton">Calcular ahorro</button><button onclick="this.textContent = 'ok'">Ver video</button></section>
  <div id="largo"></div>
  <script>if (innerWidth < 500) {
    // Larga a 375 para que su recorrido siga vivo mientras 1440 pulsa.
    document.getElementById('largo').style.height = '40000px';
    setInterval(() => { throw new Error('ruido-375'); }, 20);
  }</script>
</body></html>`;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
});
afterAll(async () => {
  await browser.close();
  server.stop(true);
});

describe('preview-check con los anchos en paralelo', () => {
  test('cada ancho junta sus errores: lo que tira 375 no cae en los clics de 1440 ni en sus issues', async () => {
    const ctx: ViewportContext = { url: `http://127.0.0.1:${server.port}/`, ws: '.', changed: ['02-hero'], headShots: null, scope: null, prev: null, head: null, prevTexts: null };
    const [wide, narrow] = await Promise.all([checkViewport(browser, 1440, ctx), checkViewport(browser, 375, ctx)]);
    expect(wide?.interaction.map((d) => d.message)).toEqual([expect.stringMatching(/^al pulsar "Calcular ahorro": .*boton/)]);
    expect(wide?.interaction[0]?.message).not.toContain('ruido-375');
    expect(wide?.issues.some((i) => i.message.includes('ruido-375'))).toBe(false);
    expect(narrow?.issues.some((i) => i.kind === 'pageerror' && i.message.includes('ruido-375') && i.viewport === 375)).toBe(true);
    expect(narrow?.interaction).toEqual([]);
  }, 60000);
});

describe('snapshot del DOM por versión (H12)', () => {
  test('a 1440 guarda dom@1440.html con el DOM visible y sin scripts; a 375 no guarda nada', async () => {
    // saveDom poda los hermanos de la versión: la versión va dentro de un wt-visual/ propio (la guarda de pruneVersions), nunca directo en tmpdir.
    const store = mkdtempSync(join(tmpdir(), 'dom-snapshot-'));
    const shots = join(store, 'wt-visual', 'sha-1');
    try {
      const ctx: ViewportContext = { url: `http://127.0.0.1:${server.port}/`, ws: '.', changed: [], headShots: shots, scope: null, prev: null, head: null, prevTexts: null };
      await checkViewport(browser, 375, ctx);
      expect(existsSync(join(shots, 'dom@375.html'))).toBe(false);
      await checkViewport(browser, 1440, ctx);
      const html = readFileSync(join(shots, 'dom@1440.html'), 'utf8');
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('data-wt-slug="02-hero"');
      expect(html).toContain('Calcular ahorro');
      expect(html).not.toContain('<script');
      // El PAGE de arriba pone onclick en los botones: el snapshot conserva el botón y pierde el handler.
      expect(html).not.toMatch(/\sonclick=/i);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }, 60000);

  test('saveDom corta un DOM patológico al tope y lo marca', () => {
    const store = mkdtempSync(join(tmpdir(), 'dom-snapshot-cap-'));
    const dir = join(store, 'wt-visual', 'sha-1');
    try {
      const file = saveDom(dir, 1440, 'x'.repeat(MAX_DOM_BYTES + 10));
      const out = readFileSync(file, 'utf8');
      expect(out.length).toBeLessThan(MAX_DOM_BYTES + 200);
      expect(out).toContain('cortado');
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});

// Arq (revisión #744): el snapshot se abre como archivo; serializeDom no debe dejar vectores que ejecuten o naveguen.
describe('serializeDom neutraliza vectores de ejecución y navegación', () => {
  async function snapshot(doc: string): Promise<string> {
    const page = await browser.newPage();
    try {
      await page.setContent(doc, { waitUntil: 'domcontentloaded' });
      return await page.evaluate(serializeDom);
    } finally {
      await page.close();
    }
  }
  const body = (inner: string) => `<!doctype html><html><head></head><body>${inner}</body></html>`;
  const head = (inner: string) => `<!doctype html><html><head>${inner}</head><body><main id="keep">x</main></body></html>`;

  test('quita href="javascript:" y conserva el elemento', async () => {
    const html = await snapshot(body('<a id="x" href="javascript:void(0)">y</a>'));
    expect(html).toContain('id="x"');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('quita src="javascript:" y conserva el elemento', async () => {
    const html = await snapshot(body('<img id="x" alt="z" src="javascript:void(0)">'));
    expect(html).toContain('alt="z"');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('quita action="javascript:" y conserva el form', async () => {
    const html = await snapshot(body('<form id="x" action="javascript:void(0)"></form>'));
    expect(html).toContain('id="x"');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('quita xlink:href="javascript:" del <a> de SVG y conserva el elemento', async () => {
    const html = await snapshot(body('<svg><a id="x" xlink:href="javascript:void(0)"><text>y</text></a></svg>'));
    expect(html).toContain('id="x"');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('quita formaction="javascript:" del botón y conserva el elemento', async () => {
    const html = await snapshot(body('<form><button id="x" formaction="javascript:void(0)">go</button></form>'));
    expect(html).toContain('id="x"');
    expect(html).not.toMatch(/javascript:/i);
  });

  test('elimina iframe[srcdoc]', async () => {
    const html = await snapshot(body('<iframe srcdoc="<p>hi</p>"></iframe><main id="keep">x</main>'));
    expect(html).toContain('id="keep"');
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/srcdoc/i);
  });

  test('elimina meta[http-equiv=refresh]', async () => {
    const html = await snapshot(head('<meta http-equiv="refresh" content="99;url=http://evil.example/">'));
    expect(html).toContain('id="keep"');
    expect(html).not.toMatch(/http-equiv/i);
  });

  test('elimina base', async () => {
    const html = await snapshot(head('<base href="http://evil.example/">'));
    expect(html).toContain('id="keep"');
    expect(html).not.toMatch(/<base/i);
  });

  test('elimina object', async () => {
    const html = await snapshot(body('<object data="x.swf"></object><main id="keep">x</main>'));
    expect(html).toContain('id="keep"');
    expect(html).not.toMatch(/<object/i);
  });

  test('elimina embed', async () => {
    const html = await snapshot(body('<embed src="x.swf"><main id="keep">x</main>'));
    expect(html).toContain('id="keep"');
    expect(html).not.toMatch(/<embed/i);
  });
});
