// Puente de selección para la edición directa, con el protocolo de Stitch (re-iteracion/stitch-ui/static-editor.md
// §2.2-2.3): el builder activa el modo, el hover marca el elemento y el clic manda su selector, etiqueta, texto y caja.
// Solo escucha y responde al origen del builder que llega por env; sin él (deploy, build propio) no hace nada.

import { sourceOf, type WtSource } from './wt-source';

export const WT_SELECT_MODE = 'wt:select-mode';
export const WT_SELECT_CLEAR = 'wt:select-clear';
export const WT_ELEMENT_CLICKED = 'wt:element-clicked';
export const WT_WHEEL = 'wt:wheel';
export const WT_EDIT_TEXT = 'wt:edit-text';
export const WT_EDIT_REVERT = 'wt:edit-revert';
export const WT_HIDE_SELECTED = 'wt:hide-selected';
export const WT_TEXT_CHANGED = 'wt:text-changed';
export const WT_REPLACE_IMAGE = 'wt:replace-image';
/** Marco del rail (H14, Mark de Stitch `stitch:tool-mark`): el builder manda una región de la página y el puente
 * contesta con los elementos que caen en ella, con la misma forma que un clic. */
export const WT_SELECT_RECT = 'wt:select-rect';
export const WT_RECT_ELEMENTS = 'wt:rect-elements';
/** Tope de elementos por región: un marco sobre una sección entera no le manda la página al agente. */
export const RECT_MAX = 8;

export type ElementKind = 'text' | 'image';
export interface ElementClicked {
  type: typeof WT_ELEMENT_CLICKED;
  kind: ElementKind;
  selector: string;
  tagName: string;
  label: string;
  /** Texto visible (texto) o src (imagen), cortado: viaja al agente como "Current text". */
  text: string;
  src?: string;
  /** Texto sin elementos dentro: el único que Editar texto puede buscar tal cual en el código. */
  editable: boolean;
  rect: { x: number; y: number; width: number; height: number };
  /** Dónde hizo clic la persona, en coordenadas de la página: el popover de Stitch se ancla a esa altura (clickY). */
  click?: { x: number; y: number };
  /** La sección de <main> que contiene al elemento y su posición: el builder ofrece subirla, bajarla, duplicarla o
   * quitarla sin modelo. Navbar y footer van fuera de <main> y no se mueven. */
  section?: { slug: string; index: number; count: number };
  /** archivo:línea:col del JSX que lo pintó, solo en dev (wt-source.ts): el agente recibe slug y ancla, y la línea sirve
   * para el salto de UI y para acotar la edición de un elemento (ADR E, decisión 3). */
  source?: WtSource;
}

function sectionOf(el: Element): ElementClicked['section'] {
  if (typeof el.closest !== 'function' || typeof document === 'undefined') return undefined;
  const own = el.closest('main [data-wt-slug]');
  const slug = own?.getAttribute('data-wt-slug');
  if (!own || !slug) return undefined;
  const all = [...document.querySelectorAll('main [data-wt-slug]')].filter((s) => !s.parentElement?.closest('main [data-wt-slug]'));
  const index = all.indexOf(own);
  return index < 0 ? undefined : { slug, index, count: all.length };
}

export interface Area { x: number; y: number; width: number; height: number }
export type SelectMessage = { mode: boolean } | { clear: true } | { editText: true } | { hide: true } | { revert: true } | { replaceSrc: string } | { rect: Area };

const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'A', 'BUTTON', 'LI', 'TD', 'TH', 'LABEL', 'BLOCKQUOTE', 'FIGCAPTION', 'SUMMARY', 'LEGEND', 'CAPTION', 'SPAN', 'STRONG', 'EM', 'SMALL', 'INPUT', 'TEXTAREA', 'SELECT']);
const TEXT_MAX = 500;
const CLASSES_PER_STEP = 3;

/** Mensajes del builder: solo los de su origen y con la forma exacta. */
export function parseSelectMessage(data: unknown, eventOrigin: string, builderOrigin: string): SelectMessage | null {
  if (eventOrigin !== builderOrigin || typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type === WT_SELECT_MODE && typeof d.active === 'boolean') return { mode: d.active };
  if (d.type === WT_SELECT_CLEAR) return { clear: true };
  if (d.type === WT_EDIT_TEXT) return { editText: true };
  if (d.type === WT_HIDE_SELECTED) return { hide: true };
  if (d.type === WT_EDIT_REVERT) return { revert: true };
  // Solo https o un archivo de la página: un javascript: o data: no entra a un img aunque el builder lo mande.
  if (d.type === WT_REPLACE_IMAGE && typeof d.src === 'string' && /^(https:\/\/|\/uploads\/)/.test(d.src) && d.src.length <= 2000) return { replaceSrc: d.src };
  if (d.type === WT_SELECT_RECT && typeof d.rect === 'object' && d.rect !== null) {
    const r = d.rect as Record<string, unknown>;
    const ok = [r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v)) && (r.width as number) > 0 && (r.height as number) > 0;
    if (ok) return { rect: { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number } };
  }
  return null;
}

const overlap = (a: Area, b: Area): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Qué elementos de la lista (en orden del documento) entran en la región: primero los que quedan enteros adentro, en
 * orden de lectura; después los que solo la tocan, por la fracción de su caja que cae dentro. Hasta `max`. */
export function pickInRect<T extends { rect: Area }>(items: readonly T[], area: Area, max = RECT_MAX): T[] {
  const scored = items
    .map((item, i) => ({ item, i, size: item.rect.width * item.rect.height, hit: overlap(item.rect, area) }))
    .filter((s) => s.size > 0 && s.hit > 0);
  const inside = scored.filter((s) => s.hit >= s.size * 0.999);
  const partial = scored.filter((s) => s.hit < s.size * 0.999).sort((a, b) => b.hit / b.size - a.hit / a.size || a.i - b.i);
  return [...inside, ...partial].slice(0, max).map((s) => s.item);
}

/** El texto como lo busca el transport: los saltos y sangrías de JSX colapsados en un espacio. */
export const plainText = (s: string): string => s.replace(/\s+/g, ' ').trim();

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** La etiqueta que Stitch pone sobre el elemento (mg): Image, Icon, Heading, Button, Link, Input, List item, Text o Container. */
export function labelOf(tag: string, isIcon = false): string {
  const t = tag.toUpperCase();
  if (isIcon) return 'Icono';
  if (t === 'IMG' || t === 'PICTURE') return 'Imagen';
  if (/^H[1-6]$/.test(t)) return 'Título';
  if (t === 'BUTTON') return 'Botón';
  if (t === 'A') return 'Enlace';
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return 'Campo';
  if (t === 'LI') return 'Elemento de lista';
  if (TEXT_TAGS.has(t)) return 'Texto';
  return 'Contenedor';
}

interface SelectorNode {
  tagName: string;
  classList: Iterable<string>;
  parentElement: SelectorNode | null;
  previousElementSibling: SelectorNode | null;
  nextElementSibling: SelectorNode | null;
}

const escapeCss = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, '\\$1'));

/** Selector como el de Stitch (Qo): sube hasta body; cada paso es etiqueta, hasta 3 clases y :nth-of-type si hay
 * hermanos con la misma etiqueta. Las clases del puente se saltan para que el selector siga sirviendo sin él. */
export function selectorOf(el: SelectorNode): string {
  const steps: string[] = [];
  for (let node: SelectorNode | null = el; node && node.tagName.toUpperCase() !== 'BODY' && node.tagName.toUpperCase() !== 'HTML'; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    const classes = [...node.classList].filter((c) => !c.startsWith('wt-')).slice(0, CLASSES_PER_STEP).map((c) => `.${escapeCss(c)}`).join('');
    let index = 1;
    let same = false;
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === node.tagName) { index += 1; same = true; }
    for (let s = node.nextElementSibling; s && !same; s = s.nextElementSibling) if (s.tagName === node.tagName) same = true;
    steps.unshift(`${tag}${classes}${same ? `:nth-of-type(${index})` : ''}`);
  }
  return steps.join(' > ');
}

const cut = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s);

/** Qué se puede elegir: la imagen o el bloque de texto más cercano, no el contenedor de toda la sección. */
function pickable(target: Element | null): Element | null {
  for (let el = target; el && el.tagName !== 'BODY'; el = el.parentElement) {
    if (el.id === 'wt-select-ui' || el.closest('#wt-select-ui')) return null;
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'SVG' || tag === 'PICTURE' || TEXT_TAGS.has(tag)) return el;
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (direct) return el;
  }
  return null;
}

export function describe(el: Element, click?: { x: number; y: number }): ElementClicked {
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toUpperCase();
  const image = tag === 'IMG' || tag === 'PICTURE' || tag === 'SVG';
  const src = tag === 'IMG' ? (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src : undefined;
  return {
    type: WT_ELEMENT_CLICKED,
    kind: image ? 'image' : 'text',
    selector: selectorOf(el as unknown as SelectorNode),
    tagName: el.tagName.toLowerCase(),
    label: labelOf(tag, tag === 'SVG'),
    // textContent y no innerText: innerText aplica text-transform y el texto ya no coincide con el del código, que es
    // como lo buscan Editar texto y Eliminar.
    text: cut(plainText(el.textContent ?? '')),
    ...(src ? { src: cut(src) } : {}),
    editable: !image && !FIELD_TAGS.has(tag) && el.children.length === 0 && plainText(el.textContent ?? '') !== '',
    rect: { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height },
    ...(click ? { click } : {}),
    ...(() => { const section = sectionOf(el); return section ? { section } : {}; })(),
    ...(() => { const source = sourceOf(el); return source ? { source } : {}; })(),
  };
}

// Colores del modo edición de Stitch: contorno violeta de 1,5 px en hover y 2 px al elegir (dinamico-rail.md r-04/r-05).
const CSS_TEXT = `
#wt-select-ui{position:absolute;inset:0 auto auto 0;z-index:2147483646;pointer-events:none}
#wt-select-ui div{position:absolute;box-sizing:border-box;border-radius:3px;transition:left .08s,top .08s,width .08s,height .08s}
#wt-select-ui .h{border:1.5px solid #7168f6;background:rgb(113 104 246/.06)}
#wt-select-ui .s{border:2px solid #7168f6}
@media (prefers-reduced-motion:reduce){#wt-select-ui div{transition:none}}
html.wt-selecting,html.wt-selecting *{cursor:default!important}`;

/** Instala el puente y devuelve cómo quitarlo. Inerte si no hay origen o si la página no está dentro de un iframe. */
export function installSelectBridge(win: Window, origin: string | undefined): () => void {
  if (!origin || win.parent === win) return () => {};
  const doc = win.document;
  let ui: { root: HTMLDivElement; hover: HTMLDivElement; sel: HTMLDivElement; style: HTMLStyleElement } | null = null;
  let selected: Element | null = null;
  // Edit Text de Stitch (static-editor.md §2.4): el elemento elegido pasa a contenteditable y el cambio se manda al
  // perder el foco. Aquí plaintext-only y Enter confirma, porque un salto escrito no existe en el texto del TSX.
  let editing: { el: HTMLElement; before: string; original: string } | null = null;
  let lastEdit: { el: HTMLElement; original: string } | null = null;
  // Delete de Stitch quita el elemento del DOM en el acto (static-editor.md §2.5); aquí se oculta mientras el transport
  // lo borra del código, para poder devolverlo si no se pudo. La versión nueva recarga la página sin él.
  let hidden: { el: HTMLElement; display: string } | null = null;
  let swapped: { el: HTMLImageElement; src: string } | null = null;

  const place = (box: HTMLDivElement, el: Element | null) => {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left + win.scrollX}px`, top: `${r.top + win.scrollY}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const onMove = (e: MouseEvent) => { if (ui) place(ui.hover, pickable(e.target as Element)); };
  const onClick = (e: MouseEvent) => {
    // Dentro del texto que se edita el cursor ya se movió en el mousedown; el clic no sigue el enlace ni el botón.
    // Fuera, el foco se va y eso confirma.
    if (editing && editing.el.contains(e.target as Node)) { e.preventDefault(); return; }
    // En modo edición la página no navega ni envía formularios: el clic es para elegir.
    e.preventDefault();
    e.stopPropagation();
    const el = pickable(e.target as Element);
    if (!el || !ui) return;
    selected = el;
    place(ui.sel, el);
    try { win.parent.postMessage(describe(el, { x: e.pageX, y: e.pageY }), origin); } catch { /* el builder cerró */ }
  };
  const reflow = () => { if (ui) place(ui.sel, selected); };
  // Con la página recibiendo el puntero, la rueda ya no llega al lienzo: se reenvía, como interactive_wheel_passthrough.
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    try { win.parent.postMessage({ type: WT_WHEEL, deltaX: e.deltaX, deltaY: e.deltaY, zoom: e.ctrlKey || e.metaKey, x: e.clientX, y: e.clientY }, origin); } catch { /* el builder cerró */ }
  };

  const endEdit = (commit: boolean) => {
    if (!editing) return;
    const { el, before, original } = editing;
    editing = null;
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('input', reflow);
    el.removeAttribute('contenteditable');
    if (!commit) { el.textContent = original; reflow(); return; }
    lastEdit = { el, original };
    try { win.parent.postMessage({ type: WT_TEXT_CHANGED, before, after: plainText(el.textContent ?? '') }, origin); } catch { /* el builder cerró */ }
  };
  const onBlur = () => endEdit(true);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); editing?.el.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); const el = editing?.el; endEdit(false); el?.blur(); }
  };
  const beginEdit = () => {
    const el = selected as HTMLElement | null;
    if (!el || editing || el.children.length > 0) return;
    const original = el.textContent ?? '';
    editing = { el, before: plainText(original), original };
    el.setAttribute('contenteditable', 'plaintext-only');
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKey);
    // El texto cambia de alto mientras se escribe: el contorno lo sigue.
    el.addEventListener('input', reflow);
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    win.getSelection()?.removeAllRanges();
    win.getSelection()?.addRange(range);
  };

  const start = () => {
    if (ui) return;
    const style = doc.createElement('style');
    style.textContent = CSS_TEXT;
    const root = doc.createElement('div');
    root.id = 'wt-select-ui';
    const hover = doc.createElement('div');
    hover.className = 'h';
    const sel = doc.createElement('div');
    sel.className = 's';
    root.append(hover, sel);
    doc.head.appendChild(style);
    doc.body.appendChild(root);
    doc.documentElement.classList.add('wt-selecting');
    ui = { root, hover, sel, style };
    place(hover, null);
    place(sel, null);
    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('wheel', onWheel, { capture: true, passive: false });
    win.addEventListener('resize', reflow);
  };
  const stop = () => {
    endEdit(false);
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('wheel', onWheel, true);
    win.removeEventListener('resize', reflow);
    doc.documentElement.classList.remove('wt-selecting');
    ui?.root.remove();
    ui?.style.remove();
    ui = null;
    selected = null;
  };
  const onMessage = (event: MessageEvent) => {
    const m = parseSelectMessage(event.data, event.origin, origin);
    if (!m) return;
    if ('clear' in m) { endEdit(false); selected = null; if (ui) place(ui.sel, null); return; }
    if ('editText' in m) { beginEdit(); return; }
    if ('hide' in m) {
      const el = selected as HTMLElement | null;
      if (!el) return;
      hidden = { el, display: el.style.display };
      el.style.display = 'none';
      selected = null;
      if (ui) place(ui.sel, null);
      return;
    }
    // Como direct_edit_replace de Stitch: la imagen cambia ya en la página y el código se guarda detrás.
    if ('replaceSrc' in m) {
      const el = selected;
      if (!(el instanceof HTMLImageElement)) return;
      swapped = { el, src: el.getAttribute('src') ?? '' };
      el.src = m.replaceSrc;
      return;
    }
    // El transport no encontró el texto o el archivo no compilaba: la página vuelve a decir lo que dice el código.
    if ('revert' in m) {
      if (lastEdit) lastEdit.el.textContent = lastEdit.original;
      if (hidden) hidden.el.style.display = hidden.display;
      if (swapped) swapped.el.setAttribute('src', swapped.src);
      lastEdit = null;
      hidden = null;
      swapped = null;
      reflow();
      return;
    }
    if ('rect' in m) {
      // Lo elegible es lo mismo que en el clic; si un bloque y algo de adentro lo son, va el bloque (su texto ya lo incluye).
      const all = [...doc.body.querySelectorAll('*')].filter((el) => pickable(el) === el);
      const outer = all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
      const found = pickInRect(outer.map((el) => ({ el, rect: describe(el).rect })), m.rect).map(({ el }) => describe(el));
      try { win.parent.postMessage({ type: WT_RECT_ELEMENTS, elements: found }, origin); } catch { /* el builder cerró */ }
      return;
    }
    if (m.mode) start(); else stop();
  };
  win.addEventListener('message', onMessage);
  return () => { win.removeEventListener('message', onMessage); stop(); };
}
