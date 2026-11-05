// Puente de tamaño del preview al builder: el lienzo muestra cada página como un frame a su alto real, y desde otro
// origen ese alto no se puede leer. Mismo contrato que wt-error-bridge: solo al origen fijo que llega por env.

export const WT_SIZE_MESSAGE = 'wt:page-size';
export interface PageSizeMessage {
  type: typeof WT_SIZE_MESSAGE;
  height: number;
  /** Alto del viewport con el que se midió: el builder lo usa para notar que su propio resize hizo crecer la página. */
  viewport: number;
  /** Secciones visibles. El load del iframe llega con el scaffold vacío; el placeholder del frame espera a la primera. */
  sections: number;
}

// Una página con un bug de layout puede medir millones de px; el builder no necesita más que esto para el frame.
export const HEIGHT_MAX = 40000;

/** Lo mínimo de un elemento que hace falta para decidir si una sección se ve. */
export interface SectionNode {
  tagName: string;
  children: ArrayLike<SectionNode>;
  textContent: string | null;
  getBoundingClientRect(): { height: number };
  querySelector(selector: string): unknown;
}

// Misma definición que A1 del arnés (docs/programa-ronda-extracts/arnes.md:34): hijo de #root, o de #root main, con
// alto y con texto o imagen. App monta navbar, main con las secciones y footer, así que main se abre en su lugar. Un
// wrapper vacío o un boundary que falló (hidden) no cuentan.
export function countSections(root: SectionNode | null): number {
  if (!root) return 0;
  const list = Array.from(root.children).flatMap((el) => (el.tagName === 'MAIN' ? Array.from(el.children) : [el]));
  return list.filter((el) => el.getBoundingClientRect().height > 0 && (Boolean(el.textContent?.trim()) || Boolean(el.querySelector('img')))).length;
}

interface SizeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  innerHeight: number;
  document: { documentElement: { scrollHeight: number }; getElementById(id: string): SectionNode | null };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
type Observe = (target: unknown, onChange: () => void) => () => void;

// Las mutaciones se entregan aunque el navegador no esté pintando el iframe; el ResizeObserver depende del render.
const observeMutations: Observe = (target, onChange) => {
  const observer = new MutationObserver(onChange);
  observer.observe(target as Node, { childList: true, subtree: true });
  return () => observer.disconnect();
};

const observeResize: Observe = (target, onChange) => {
  const observer = new ResizeObserver(onChange);
  observer.observe(target as Element);
  return () => observer.disconnect();
};

/** Instala el puente y devuelve cómo quitarlo. Inerte si no hay origen o si la página no está dentro de un iframe. */
export function installSizeBridge(win: SizeWindow, origin: string | undefined, observe: Observe = observeResize, mutate: Observe = observeMutations): () => void {
  if (!origin || (win.parent as unknown) === win) return () => {};
  let last = '';
  const root = win.document.getElementById('root');
  const send = (): void => {
    const height = Math.min(HEIGHT_MAX, Math.ceil(win.document.documentElement.scrollHeight));
    const sections = countSections(root);
    // ResizeObserver dispara por cambios de ancho que no mueven el alto: no se repite el mismo valor.
    const key = `${height}:${sections}`;
    if (key === last) return;
    last = key;
    try {
      win.parent.postMessage({ type: WT_SIZE_MESSAGE, height, viewport: win.innerHeight, sections } satisfies PageSizeMessage, origin);
    } catch {
      // El builder cerró o el origen no coincide: el preview sigue igual.
    }
  };
  const stop = observe(win.document.documentElement, send);
  // Una primera sección más baja que el viewport no mueve el scrollHeight del documento, pero sí el alto de #root.
  const stopRoot = root ? observe(root, send) : () => {};
  const stopMutations = root ? mutate(root, send) : () => {};
  win.addEventListener('load', send);
  send();
  return () => {
    stop();
    stopRoot();
    stopMutations();
    win.removeEventListener('load', send);
  };
}
