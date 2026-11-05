// Origen archivo:línea:col de cada nodo del preview, solo en dev (S6, ADR E decisión 3). Es el mecanismo de
// lovable-tagger@1.3.5 (dist/index.js:7 devRuntimeCode, :10-17 el módulo virtual que reemplaza react/jsx-dev-runtime):
// envolver jsxDEV, que en dev recibe {fileName, lineNumber, columnNumber} como 5º argumento (vite 8.3.4 activa
// jsx.development fuera de producción, node.js:28118), y guardar el origen en el nodo bajo un Symbol, con un mapa inverso
// en window. No va al HTML: el plugin de vite.config.ts solo corre en serve. React 19 ya no expone _debugSource en la
// fibra, así que no se puede leer después como hace Make (iframe deob :45692-45705).

export const WT_SOURCE = Symbol.for('__wtSource__');

/** Sin line/col: solo se sabe el archivo (la sección cuyo bloque del DS no pasa la ref; ver sourceOf). */
export interface WtSource { file: string; line?: number; col?: number }

interface JsxSource { fileName?: string; lineNumber?: number; columnNumber?: number }
type Props = Record<string, unknown> | null | undefined;
export type JsxDev = (type: unknown, props: Props, key: unknown, isStatic: boolean, source?: JsxSource, self?: unknown) => unknown;
export interface SourceWindow { wtSourceMap?: Map<string, Set<WeakRef<object>>> }
type Tagged = object & { [WT_SOURCE]?: WtSource };

// El DS no es lo que la persona edita: un nodo que solo conoce su línea dentro de src/components/ toma la del JSX de la
// sección que lo usa (el `<Action>` del hero, no el `<a>` de action.tsx).
const DS_DIR = 'src/components/';

export function keyOf(s: WtSource): string {
  return `${s.file}:${s.line}:${s.col}`;
}

export function isDs(s: WtSource): boolean {
  return s.file.startsWith(DS_DIR);
}

function relative(root: string, fileName: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return fileName.startsWith(base) ? fileName.slice(base.length) : fileName;
}

export function createJsxDEV(base: JsxDev, fragment: unknown, root: string, win?: SourceWindow): JsxDev {
  const map = win ? (win.wtSourceMap ??= new Map()) : undefined;
  const register = (node: Tagged, s: WtSource): void => {
    const old = node[WT_SOURCE];
    if (old && map) {
      const refs = map.get(keyOf(old));
      for (const r of refs ?? []) if (r.deref() === node) refs!.delete(r);
      if (refs?.size === 0) map.delete(keyOf(old));
    }
    node[WT_SOURCE] = s;
    if (!map) return;
    const k = keyOf(s);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(new WeakRef(node));
  };
  return (type, props, key, isStatic, source, self) => {
    // Un Fragment no acepta ref (lovable-tagger lo excluye igual, `type !== Fragment`).
    if (!map || type === fragment || !source?.fileName || source.lineNumber === undefined || source.columnNumber === undefined) return base(type, props, key, isStatic, source, self);
    const s: WtSource = { file: relative(root, source.fileName), line: source.lineNumber, col: source.columnNumber };
    const host = typeof type === 'string';
    const original = props?.ref;
    // Las refs se enganchan de adentro hacia afuera: el nodo host ya trae su línea cuando llega la del componente que lo
    // envuelve, que solo la reemplaza si la que trae es del DS.
    const ref = (node: Tagged | null): unknown => {
      if (node && (host || !node[WT_SOURCE] || (isDs(node[WT_SOURCE]!) && !isDs(s)))) register(node, s);
      if (typeof original === 'function') return (original as (n: unknown) => unknown)(node);
      if (original && typeof original === 'object') (original as { current: unknown }).current = node;
      return undefined;
    };
    return base(type, { ...props, ref }, key, isStatic, source, self);
  };
}

// La sección `<slug>` vive en src/sections/<slug>.tsx: App.tsx la importa así y la envuelve en WtSection.
const SECTION_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** El origen editable de un nodo: el suyo, o el del ancestro más cercano fuera del DS. Un componente del DS que no pasa
 * la ref a su nodo deja el origen de adentro (action.tsx); subir hasta el JSX de la sección da la línea que sí se edita.
 * Si la sección entera la pinta un bloque del DS, su JSX nunca queda en el DOM: al llegar al borde de la sección se
 * devuelve su archivo sin línea, en vez de seguir subiendo hasta el <main> de App.tsx (QA H5: el h1 del hero decía
 * App.tsx:17). */
export function sourceOf(el: Element | null): WtSource | undefined {
  let first: WtSource | undefined;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = (n as Tagged)[WT_SOURCE];
    if (s) {
      first ??= s;
      if (!isDs(s)) return s;
    }
    const slug = typeof n.getAttribute === 'function' ? n.getAttribute('data-wt-slug') : null;
    if (slug && SECTION_SLUG.test(slug)) return { file: `src/sections/${slug}.tsx` };
  }
  return first;
}
