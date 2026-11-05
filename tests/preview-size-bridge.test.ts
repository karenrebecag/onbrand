import { expect, test } from 'bun:test';
import { countSections, HEIGHT_MAX, installSizeBridge, WT_SIZE_MESSAGE, type SectionNode } from '../templates/base-scaffold/src/wt-size-bridge';
import { nextFrameHeight, parsePageSize } from '../apps/builder/src/lib/page-size';

const BUILDER = 'http://localhost:5320';

function fakeWindow(framed = true) {
  const posted: { message: Record<string, unknown>; origin: string }[] = [];
  const listeners = new Map<string, () => void>();
  const doc = { documentElement: { scrollHeight: 3200 }, getElementById: (): SectionNode | null => null };
  const win = {
    parent: { postMessage: (message: unknown, origin: string) => posted.push({ message: message as Record<string, unknown>, origin }) },
    innerHeight: 900,
    document: doc,
    addEventListener: (t: string, l: () => void) => listeners.set(t, l),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  if (!framed) win.parent = win as never;
  let resize = () => {};
  let observing = false;
  const observe = (_: unknown, onChange: () => void) => { resize = onChange; observing = true; return () => { observing = false; }; };
  return { win, doc, posted, listeners, observe, resize: () => resize(), observing: () => observing };
}

test('manda el alto solo al origen del builder, sin repetir el mismo valor y con tope', () => {
  const f = fakeWindow();
  const off = installSizeBridge(f.win, BUILDER, f.observe);
  f.resize();
  f.doc.documentElement.scrollHeight = 10_000_000;
  f.resize();
  expect(f.posted.map((p) => [p.origin, p.message.type, p.message.height, p.message.viewport])).toEqual([
    [BUILDER, WT_SIZE_MESSAGE, 3200, 900],
    [BUILDER, WT_SIZE_MESSAGE, HEIGHT_MAX, 900],
  ]);
  off();
  expect(f.observing()).toBe(false);
  expect(f.listeners.size).toBe(0);
});

// Un postMessage con '*' le diría el alto de la página a cualquiera que la embeba.
test('sin origen o sin iframe queda inerte', () => {
  for (const [f, origin] of [[fakeWindow(), undefined], [fakeWindow(false), BUILDER]] as const) {
    installSizeBridge(f.win, origin, f.observe);
    expect(f.posted).toHaveLength(0);
    expect(f.observing()).toBe(false);
  }
});

test('el builder descarta mensajes que no son un alto válido', () => {
  expect(parsePageSize({ type: 'wt:page-size', height: 4719.2, viewport: 900 })).toEqual({ height: 4720, viewport: 900 });
  for (const bad of [null, 'x', { type: 'wt:runtime-error', height: 10, viewport: 10 }, { type: 'wt:page-size', height: -1, viewport: 900 },
    { type: 'wt:page-size', height: Infinity, viewport: 900 }, { type: 'wt:page-size', height: 99_999_999, viewport: 900 }, { type: 'wt:page-size', height: 900 }]) {
    expect(parsePageSize(bad)).toBeNull();
  }
});

// Una sección de 100vh crece con el frame; sin freno, frame y página se persiguen hasta el tope.
test('el frame toma el alto de la página y frena el crecimiento que causa su propio resize', () => {
  const rest = 3000;
  let prev = 900, cur = 900;
  for (let i = 0; i < 5; i += 1) {
    const next = nextFrameHeight(cur, prev, { height: rest + cur, viewport: cur });
    // Como el estado del canvas: un frame que no cambia no mueve su alto anterior.
    if (next !== cur) { prev = cur; cur = next; }
  }
  expect(cur).toBe(rest + 900);
  // Un cambio de contenido real (una imagen que carga) sí mueve el frame.
  expect(nextFrameHeight(3900, 3900, { height: 4400, viewport: 3900 })).toBe(4400);
  expect(nextFrameHeight(5000, 900, { height: 4200, viewport: 5000 })).toBe(4200);
});

const node = (tagName: string, height: number, text = '', children: SectionNode[] = [], img = false): SectionNode =>
  ({ tagName, children, textContent: text, getBoundingClientRect: () => ({ height }), querySelector: () => (img ? {} : null) });

// Fila 22 de A4: el load del iframe llega con el scaffold vacío; el placeholder espera a que A1 vea una sección.
test('cuenta como sección el hijo de #root o de #root main con alto y con texto o imagen', () => {
  expect(countSections(null)).toBe(0);
  expect(countSections(node('DIV', 0))).toBe(0);
  const hero = node('SECTION', 600, 'Hola');
  expect(countSections(node('DIV', 600, 'Hola', [node('MAIN', 600, 'Hola', [hero, node('SECTION', 400, '', [], true), node('DIV', 0, 'oculto'), node('DIV', 50, '  ')])]))).toBe(2);
  expect(countSections(node('DIV', 600, 'Hola', [hero]))).toBe(1);
  expect(parsePageSize({ type: 'wt:page-size', height: 900, viewport: 900, sections: 2 })).toEqual({ height: 900, viewport: 900, sections: 2 });
  expect(parsePageSize({ type: 'wt:page-size', height: 900, viewport: 900, sections: -1 })).toEqual({ height: 900, viewport: 900 });
});

// Regresión de c0d326b en c7c7ec26: #root es header + main + footer (DOM medido en el preview :5310), y el iframe
// tapado no corre su ResizeObserver; la mutación tiene que alcanzar para reportar la primera sección.
test('cuenta las secciones dentro de main junto a navbar y footer, y reporta por mutación sin resize', () => {
  const sections = [824, 968, 985, 591, 517, 824, 622, 102].map((h, i) => node(i % 2 ? 'DIV' : 'SECTION', h, 'texto'));
  const main = { ...node('MAIN', 5434, 'texto'), children: [] as SectionNode[] };
  const root = { ...node('DIV', 0), children: [] as SectionNode[] };
  expect(countSections(root)).toBe(0);
  const f = fakeWindow();
  f.doc.getElementById = () => root;
  let mutated = () => {};
  installSizeBridge(f.win, BUILDER, () => () => {}, (_, onChange) => { mutated = onChange; return () => {}; });
  root.children = [node('HEADER', 65, 'Acme'), main];
  mutated();
  main.children = sections;
  root.children = [...root.children, node('FOOTER', 268, 'pie')];
  mutated();
  expect(f.posted.map((p) => p.message.sections)).toEqual([0, 1, 10]);
});
