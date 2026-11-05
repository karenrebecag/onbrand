import { expect, test } from 'bun:test';
import { admit, changedElements, createImageRevealer, deferredSrc, drawPath, parseGenerating, parseImagesReady, PLACEHOLDER_IMG, takeDue, takeTwin, topLevel } from '../templates/base-scaffold/src/wt-reveal-bridge';

const BUILDER = 'http://localhost:5350';

// Cualquier página que embeba el preview podría mandar el aviso; solo el builder enciende el cursor.
test('el aviso de generación solo cuenta desde el origen del builder y con la forma exacta', () => {
  expect(parseGenerating({ type: 'wt:generating', active: true }, BUILDER, BUILDER)).toBe(true);
  expect(parseGenerating({ type: 'wt:generating', active: false }, BUILDER, BUILDER)).toBe(false);
  expect(parseGenerating({ type: 'wt:generating', active: true }, 'https://evil.example', BUILDER)).toBeNull();
  expect(parseGenerating({ type: 'wt:generating', active: 'yes' }, BUILDER, BUILDER)).toBeNull();
  expect(parseGenerating({ type: 'wt:page-size', active: true }, BUILDER, BUILDER)).toBeNull();
  expect(parseGenerating(null, BUILDER, BUILDER)).toBeNull();
});

test('de un lote de nodos nuevos anima solo los de más arriba', () => {
  const tree: Record<string, string[]> = { section: ['card', 'title'], card: ['price'], footer: [] };
  const contains = (o: string, i: string): boolean => (tree[o] ?? []).some((c) => c === i || contains(c, i));
  expect(topLevel(['section', 'card', 'price', 'title', 'footer'], contains)).toEqual(['section', 'footer']);
});

// processFadeIn de Stitch: nada se dibuja antes de sus 300 ms, se dibuja uno a la vez y la cola se recorre desde el final.
test('la cola dibuja de a un elemento, solo cuando cumplió su espera y empezando por el último', () => {
  const queue = [{ el: 'nav', time: 100 }, { el: 'hero', time: 150 }, { el: 'footer', time: 400 }];
  expect(takeDue(queue, 50, false).draw).toBeNull();
  const first = takeDue(queue, 200, false);
  expect(first.draw?.el).toBe('hero');
  expect(first.rest.map((p) => p.el)).toEqual(['nav', 'footer']);
  expect(takeDue(first.rest, 200, true)).toEqual({ draw: null, rest: first.rest });
  expect(takeDue(first.rest, 200, false).draw?.el).toBe('nav');
});

test('el cursor recorre el rectángulo por sus esquinas, 6 px adentro', () => {
  expect(drawPath({ left: 10, top: 20, right: 110, bottom: 70 })).toEqual([{ x: 104, y: 26 }, { x: 104, y: 64 }, { x: 16, y: 64 }]);
});

// elementAnimationCounts de Stitch: un nodo que el HMR vuelve a insertar no se redibuja más de dos veces ni se encola dos.
test('un elemento entra a la cola dos veces como mucho y nunca si ya está en ella', () => {
  const el = {};
  const counts = new WeakMap<object, number>();
  expect(admit(counts, [{ el, time: 0 }], el)).toBe(false);
  expect(admit(counts, [], el)).toBe(true);
  expect(admit(counts, [], el)).toBe(true);
  expect(admit(counts, [], el)).toBe(false);
});

// Diferido de Stitch (vr-runtime :583-604): solo una imagen de sección, en dev, mientras el agente escribe y sin haber
// cargado antes; cualquier otra pinta su src real, así un follow-up no devuelve al placeholder lo que ya se veía.
test('el shim difiere el src solo de imágenes de sección nuevas mientras el agente escribe en dev', () => {
  const on = { dataAlt: true, dev: true, generating: true, loaded: false };
  expect(deferredSrc('/images/hero.png', on)).toEqual({ src: PLACEHOLDER_IMG, pending: '/images/hero.png' });
  expect(deferredSrc('/images/hero.png', { ...on, loaded: true })).toEqual({ src: '/images/hero.png' });
  expect(deferredSrc('/images/hero.png', { ...on, generating: false })).toEqual({ src: '/images/hero.png' });
  expect(deferredSrc('/images/hero.png', { ...on, dev: false })).toEqual({ src: '/images/hero.png' });
  expect(deferredSrc('/brand/logo.svg', { ...on, dataAlt: false })).toEqual({ src: '/brand/logo.svg' });
  expect(deferredSrc(undefined, on)).toEqual({ src: undefined });
});

test('el aviso de imágenes listas solo cuenta desde el origen del builder', () => {
  expect(parseImagesReady({ type: 'wt:images-ready' }, BUILDER, BUILDER)).toEqual({});
  expect(parseImagesReady({ type: 'wt:images-ready' }, 'https://evil.example', BUILDER)).toBe(false);
  expect(parseImagesReady({ type: 'wt:generating' }, BUILDER, BUILDER)).toBe(false);
});

// processNextImage de Stitch (renderer deob l.329-452), con un reloj falso: de a una imagen, apagado a los 700 ms, src a
// los 950, encendido con onload (o a los 1750) y la siguiente a los 1400; una imagen sin caja recibe el src en el acto.
test('las imágenes se revelan de a una con los tiempos del renderer', () => {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const log: string[] = [];
  const run = (until: number) => {
    for (let t = timers.sort((a, b) => a.at - b.at)[0]; t && t.at <= until; t = timers.sort((a, b) => a.at - b.at)[0]) {
      timers.splice(timers.indexOf(t), 1);
      now = t.at;
      t.fn();
    }
    now = until;
  };
  const loads: Record<string, () => void> = {};
  const box = (w: number) => ({ left: 0, top: 0, right: w, bottom: w, width: w, height: w });
  const r = createImageRevealer<string>({
    later: (fn, ms) => { timers.push({ at: now + ms, fn }); },
    box: (el) => box(el === 'oculta' ? 0 : 100),
    pointAt: (el) => log.push(`${now} point ${el}`),
    place: () => {},
    paint: (on) => log.push(`${now} paint ${on}`),
    overlay: () => ({ fade: () => {}, remove: () => {} }),
    setSrc: (el, src, onload) => { log.push(`${now} src ${el}=${src}`); loads[el] = onload; },
    dim: (el, on) => log.push(`${now} dim ${el} ${on}`),
    reveal: (el, on) => log.push(`${now} reveal ${el} ${on}`),
  });
  r.push('hero', '/a.png');
  r.push('oculta', '/b.png');
  r.push('hero', '/a2.png');
  run(950);
  loads.hero!();
  run(5000);
  expect(log).toEqual([
    '0 point hero', '300 paint true', '700 dim hero true', '700 paint false', '950 src hero=/a.png',
    '950 dim hero false', '950 reveal hero true', '1350 reveal hero false',
    '1400 point oculta', '1700 src oculta=/b.png',
    '1700 point hero', '2000 paint true', '2400 dim hero true', '2400 paint false', '2650 src hero=/a2.png',
    '3450 dim hero false', '3450 reveal hero true', '3850 reveal hero false',
  ]);
  expect(r.busy()).toBe(false);
});

// syncNodes de Stitch (renderer deob l.654-727): un remonte con el mismo árbol no anima nada; solo la sección agregada al
// final o el nodo cuyo tag cambió.
test('del remonte solo se anima lo que cambió por posición', () => {
  type Fake = { nodeType: number; tagName: string; childNodes: Fake[]; hasAttribute: () => boolean };
  const el = (tagName: string, ...kids: Fake[]): Fake =>
    ({ nodeType: 1, tagName, childNodes: kids, hasAttribute: () => false });
  const before = el('DIV', el('HEADER', el('NAV')), el('MAIN', el('SECTION'), el('SECTION')));
  const hero = el('SECTION');
  const after = el('DIV', el('HEADER', el('NAV')), el('MAIN', el('SECTION'), el('SECTION'), hero));
  expect(changedElements(before, after)).toEqual([hero]);
  const footer = el('FOOTER');
  expect(changedElements(before, el('DIV', el('HEADER', el('NAV')), el('MAIN', el('SECTION'), el('SECTION')), footer))).toEqual([footer]);
  const swapped = el('ASIDE');
  expect(changedElements(before, el('DIV', el('HEADER', swapped), el('MAIN', el('SECTION'), el('SECTION'))))).toEqual([swapped]);
  expect(changedElements(before, el('DIV', el('HEADER', el('NAV')), el('MAIN', el('SECTION'))))).toEqual([]);
  expect(takeTwin([el('NAV'), el('DIV')], 'DIV').twin?.tagName).toBe('DIV');
  expect(takeTwin([el('NAV')], 'DIV').twin).toBeUndefined();
});

// A8: una foto reemplazada en la misma ruta se vuelve a pedir con ?wt=<n>; solo las de la página, no las de otro origen
// ni data:. El aviso trae bust solo si es un entero positivo.
test('bust recarga solo rutas de la página y reemplaza el query anterior', async () => {
  const { bustSrc } = await import('../templates/base-scaffold/src/wt-reveal-bridge');
  const page = 'http://abc.localhost:5301';
  expect(bustSrc('/images/hero.jpg', 2, page)).toBe('/images/hero.jpg?wt=2');
  expect(bustSrc('/images/hero.jpg?wt=2&w=800', 3, page)).toBe('/images/hero.jpg?wt=3&w=800');
  expect(bustSrc(`${page}/images/a.png`, 1, page)).toBe(`${page}/images/a.png?wt=1`);
  expect(bustSrc('https://images.unsplash.com/x.jpg', 1, page)).toBe('https://images.unsplash.com/x.jpg');
  expect(bustSrc(PLACEHOLDER_IMG, 1, page)).toBe(PLACEHOLDER_IMG);
  expect(parseImagesReady({ type: 'wt:images-ready', bust: 4 }, BUILDER, BUILDER)).toEqual({ bust: 4 });
  expect(parseImagesReady({ type: 'wt:images-ready', bust: -1 }, BUILDER, BUILDER)).toEqual({});
});
