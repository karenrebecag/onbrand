// Mientras el agente escribe la página, el builder lo avisa con 'wt:generating' y cada elemento que entra por HMR se
// pinta como en el renderer de Stitch (UgcTrustBanner-CNyuu-AW.js, processFadeIn/moveCursor, static-loading-animations.md
// b-c): espera 300 ms oculto, el cursor del agente salta a su esquina, recorre el borde mientras un rectángulo se dibuja
// alrededor y, a los 400 ms, el elemento aparece con un fundido. Uno a la vez; el resto espera su turno.
// Solo escucha al origen del builder que llega por env; sin él (deploy, build propio) no hace nada.

export const WT_GENERATING_MESSAGE = 'wt:generating';
// Handshake: sin recargas por archivo el onLoad del iframe llega una sola vez, así que el puente pide el estado al
// instalarse en vez de esperar a que el builder adivine cuándo ya puede escucharlo.
export const WT_BRIDGE_READY_MESSAGE = 'wt:bridge-ready';
// elementAnimationCounts del renderer de Stitch (renderer deob l.458-462): un elemento que el diff toca varias veces
// se anima dos como mucho.
export const MAX_ANIMATIONS = 2;
// Diferido de imágenes de Stitch (vr-runtime webcrack :182 PLACEHOLDER_IMG, :583-604 PENDING_SRC, :3129-3131 pending a
// src): mientras el agente escribe, un <img> con data-alt muestra el placeholder y guarda su src real hasta que el
// builder avisa que las imágenes de las secciones existen. Stitch no reintenta un src fallido (:586), así que el src
// real no se pide antes de tiempo.
export const WT_IMAGES_READY_MESSAGE = 'wt:images-ready';
export const PENDING_SRC_ATTR = 'data-wt-pending-src';
// Mismo rectángulo gris de 400x300 y radio 8 que el placeholder de Stitch (:182), sin su icono.
export const PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" rx="8" fill="#e8eaed"/></svg>');

declare global {
  interface Window { __wtGenerating?: boolean; __wtLoadedSrcs?: Set<string> }
}

/** Qué src pinta el <img> del shim: el diferido solo aplica a imágenes de sección (data-alt), en dev y con la
 * generación en curso; en un follow-up sin generación o en el build la imagen ya existe y carga directo. */
export function deferredSrc(src: string | undefined, o: { dataAlt: boolean; dev: boolean; generating: boolean; loaded: boolean }): { src: string | undefined; pending?: string } {
  // loaded: una imagen que ya cargó en esta página (follow-up que re-renderiza la sección) no vuelve al placeholder.
  if (!src || o.loaded || !o.dataAlt || !o.dev || !o.generating) return { src };
  return { src: PLACEHOLDER_IMG, pending: src };
}

/** El aviso de imágenes listas, con el mismo filtro de origen y forma que el de generación. `bust` (entero) pide recargar
 * las fotos de la página: el agente reemplaza una foto en la misma ruta y un <img> ya cargado no la vuelve a pedir
 * (arnés A8, ee252db7: los marcos de variante seguían con las fotos del source). */
export function parseImagesReady(data: unknown, eventOrigin: string, builderOrigin: string): false | { bust?: number } {
  if (eventOrigin !== builderOrigin || typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== WT_IMAGES_READY_MESSAGE) return false;
  const bust = (data as { bust?: unknown }).bust;
  return Number.isSafeInteger(bust) && (bust as number) > 0 ? { bust: bust as number } : {};
}

export const BROKEN_SRC_ATTR = 'data-wt-broken-src';
const BUST_PARAM = 'wt';

/** La ruta con `?wt=<n>` (reemplaza uno anterior), solo para archivos de la propia página: una URL de otro origen no
 * cambia (el query podría romperla y su caché no es de esta página), ni data: o blob:. */
export function bustSrc(src: string, n: number, pageOrigin: string): string {
  let u: URL;
  try { u = new URL(src, pageOrigin); } catch { return src; }
  if (u.origin !== pageOrigin || !/^https?:$/.test(u.protocol)) return src;
  u.searchParams.set(BUST_PARAM, String(n));
  return /^https?:\/\//.test(src) ? u.href : `${u.pathname}${u.search}${u.hash}`;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
const INJECTED = 'data-wt-injected';
// Tiempos del renderer de Stitch: cola revisada cada 50 ms, 300 ms de espera, dibujo de 400 ms y desvanecido de 500 ms.
const TICK_MS = 50;
const DELAY_MS = 300;
const DRAW_MS = 400;
const FADE_OUT_MS = 500;
const CORNER = 6;
// Blurple de Stitch (dist-K6rdiOFx.js): 300 rellena el cursor, 400 (base) pinta el rectángulo.
const CURSOR_FILL = '#7168f6';
const DRAW_COLOR = '#6056f0';
// Me del renderer (Blurple 500): el trazo del pincel en paint-mode.
const PAINT_STROKE = '#4f44e1';
// processNextImage (renderer deob l.329-452): cursor a la imagen, 300 ms, rectángulo y pincel; a los 400 ms se apaga la
// imagen, 250 ms después cambia el src, se enciende con onload o a los 800 ms y la siguiente arranca a los 700 ms.
const IMG_POINT_MS = 300;
const IMG_DIM_AT_MS = 400;
const IMG_SRC_AFTER_MS = 250;
const IMG_LOAD_MAX_MS = 800;
const IMG_REVEAL_MS = 400;
const IMG_NEXT_MS = 700;

/** El mensaje viene de afuera de la página: solo cuenta el del origen del builder y con la forma exacta. */
export function parseGenerating(data: unknown, eventOrigin: string, builderOrigin: string): boolean | null {
  if (eventOrigin !== builderOrigin || typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  return d.type === WT_GENERATING_MESSAGE && typeof d.active === 'boolean' ? d.active : null;
}

/** De un lote de nodos agregados, los de más arriba: animar también a sus hijos repetiría el fundido por capas. */
export function topLevel<T>(added: T[], contains: (outer: T, inner: T) => boolean): T[] {
  return added.filter((n) => !added.some((o) => o !== n && contains(o, n)));
}

/** Lo mínimo de un nodo que mira el diff; separado para probarlo sin DOM. */
export interface SyncNode { nodeType: number; tagName?: string; childNodes: ArrayLike<SyncNode>; hasAttribute?: (name: string) => boolean }

/** syncNodes del renderer (deob l.654-727): compara hijo por hijo, por posición, lo que había con lo que llegó. Solo se
 * anima un hijo agregado al final (append_child) o uno cuyo tag cambió (replace_element); un subárbol igual solo se
 * sincroniza, sin animación. Un remonte de React agrega nodos nuevos con el mismo contenido: esto los descarta. */
export function changedElements(before: SyncNode, after: SyncNode): SyncNode[] {
  const own = (n: SyncNode): SyncNode[] => Array.from(n.childNodes).filter((c) => c.nodeType !== 1 || !c.hasAttribute?.(INJECTED));
  const prev = own(before);
  return own(after).flatMap((node, i) => {
    const old = prev[i];
    if (!old || old.nodeType !== node.nodeType || old.tagName !== node.tagName) return node.nodeType === 1 ? [node] : [];
    return node.nodeType === 1 ? changedElements(old, node) : [];
  });
}

/** Saca de `pool` el primer nodo quitado con el mismo tag, para comparar contra él. */
export function takeTwin<T extends { tagName?: string }>(pool: T[], tagName: string | undefined): { twin: T | undefined; rest: T[] } {
  const i = pool.findIndex((n) => n.tagName === tagName);
  return i < 0 ? { twin: undefined, rest: pool } : { twin: pool[i], rest: pool.filter((_, j) => j !== i) };
}

export interface Pending<T> { el: T; time: number }

/** Si el elemento entra a la cola: no si ya está en ella ni si ya se animó MAX_ANIMATIONS veces. */
export function admit<T extends object>(counts: WeakMap<T, number>, queue: Pending<T>[], el: T): boolean {
  const n = counts.get(el) ?? 0;
  if (n >= MAX_ANIMATIONS || queue.some((p) => p.el === el)) return false;
  counts.set(el, n + 1);
  return true;
}

/** Un paso de processFadeIn: lo que ya cumplió su espera se dibuja de a uno; mientras hay un dibujo en curso, lo demás
 * queda en la cola. Stitch recorre la cola desde el final, así que el último en llegar es el primero en dibujarse. */
export function takeDue<T>(queue: Pending<T>[], now: number, drawing: boolean): { draw: Pending<T> | null; rest: Pending<T>[] } {
  if (drawing) return { draw: null, rest: queue };
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (now >= queue[i].time) return { draw: queue[i], rest: queue.filter((_, j) => j !== i) };
  }
  return { draw: null, rest: queue };
}

/** Recorrido del cursor sobre el rectángulo a los 100, 200 y 300 ms: esquina superior derecha, inferior derecha e
 * inferior izquierda, 6 px hacia adentro. */
export function drawPath(r: { left: number; top: number; right: number; bottom: number }): { x: number; y: number }[] {
  return [
    { x: r.right - CORNER, y: r.top + CORNER },
    { x: r.right - CORNER, y: r.bottom - CORNER },
    { x: r.left + CORNER, y: r.bottom - CORNER },
  ];
}

export interface RevealItem<T> { el: T; newSrc: string }

/** set_attribute src del renderer (deob l.583-606): una imagen que ya espera en la cola solo cambia de src nuevo. */
export function queueReveal<T>(queue: RevealItem<T>[], el: T, newSrc: string): RevealItem<T>[] {
  return queue.some((q) => q.el === el) ? queue.map((q) => (q.el === el ? { el, newSrc } : q)) : [...queue, { el, newSrc }];
}

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** Lo que el reveal le pide a la página; separado para probar la secuencia sin DOM. */
export interface RevealHost<T> {
  later: (fn: () => void, ms: number) => void;
  box: (el: T) => Box;
  pointAt: (el: T) => void;
  place: (x: number, y: number) => void;
  paint: (on: boolean) => void;
  overlay: (r: Box) => { fade: () => void; remove: () => void };
  setSrc: (el: T, src: string, onload: () => void) => void;
  dim: (el: T, on: boolean) => void;
  reveal: (el: T, on: boolean) => void;
}

/** La cola de imágenes del renderer: de a una, con imageRevealRunning como candado (deob l.329-452). */
export function createImageRevealer<T>(host: RevealHost<T>) {
  let queue: RevealItem<T>[] = [];
  let current: RevealItem<T> | null = null;
  const settle = (o: RevealItem<T>): void => {
    host.setSrc(o.el, o.newSrc, () => {});
    host.dim(o.el, false);
    host.reveal(o.el, false);
  };
  const next = (): void => {
    if (current || !queue.length) return;
    const o = queue[0]!;
    current = o;
    queue = queue.slice(1);
    host.pointAt(o.el);
    host.later(() => {
      const r = host.box(o.el);
      // Sin caja no hay nada que pintar: el src va directo y sigue la próxima (l.339-346).
      if (r.width === 0 || r.height === 0) { host.setSrc(o.el, o.newSrc, () => {}); current = null; next(); return; }
      const ov = host.overlay(r);
      host.paint(true);
      drawPath(r).forEach((p, i) => host.later(() => host.place(p.x, p.y), (i + 1) * 100));
      host.later(() => {
        host.dim(o.el, true);
        host.later(() => {
          let shown = false;
          const show = (): void => {
            if (shown) return;
            shown = true;
            host.dim(o.el, false);
            host.reveal(o.el, true);
            host.later(() => host.reveal(o.el, false), IMG_REVEAL_MS);
          };
          host.setSrc(o.el, o.newSrc, show);
          host.later(show, IMG_LOAD_MAX_MS);
        }, IMG_SRC_AFTER_MS);
        host.paint(false);
        ov.fade();
        host.later(() => ov.remove(), FADE_OUT_MS);
        host.later(() => { current = null; next(); }, IMG_NEXT_MS);
      }, IMG_DIM_AT_MS);
    }, IMG_POINT_MS);
  };
  return {
    push(el: T, newSrc: string): void { queue = queueReveal(queue, el, newSrc); next(); },
    busy: (): boolean => current !== null || queue.length > 0,
    /** Al desarmar con timers cortados: cada imagen queda con su src real y sin clases a medio camino. */
    flush(): void {
      if (current) settle(current);
      queue.forEach(settle);
      queue = [];
      current = null;
    },
  };
}

// CSS inyectado del renderer de Stitch (Jr), con sus nombres cambiados a wt-.
const CSS_TEXT = `
@keyframes wt-anim-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.wt-anim-fade-in { animation: wt-anim-fade-in 0.3s ease forwards; }
.wt-anim-draw-overlay {
  position: fixed; border: 2px solid ${DRAW_COLOR}99; border-radius: 6px; pointer-events: none; z-index: 998;
  clip-path: polygon(0% 0%, 0% 0%, 0% 0%, 0% 0%, 0% 0%, 0% 0%);
  animation: wt-anim-draw-rect 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes wt-anim-draw-rect {
  0%   { clip-path: polygon(0% 0%, 0% 0%, 0% 0%, 0% 0%, 0% 0%, 0% 0%); }
  30%  { clip-path: polygon(0% 0%, 100% 0%, 100% 0%, 100% 0%, 0% 0%, 0% 0%); }
  55%  { clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 100% 100%, 0% 0%, 0% 0%); }
  80%  { clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 100%, 0% 0%); }
  100% { clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, 0% 0%); }
}
.wt-anim-draw-overlay.fading { animation: wt-anim-border-fade 0.5s ease forwards; }
@keyframes wt-anim-border-fade { to { opacity: 0; } }
.wt-anim-img-dimming { transition: opacity 0.2s ease !important; opacity: 0.15 !important; }
.wt-anim-img-revealing { transition: opacity 0.35s ease !important; opacity: 1 !important; }
#wt-agent-cursor .cursor-paint { display: none; }
#wt-agent-cursor.paint-mode .cursor-pointer { display: none; }
#wt-agent-cursor.paint-mode .cursor-paint { display: block; }
#wt-agent-cursor {
  position: fixed; z-index: 9999; pointer-events: none; display: flex; align-items: flex-start; gap: 0px;
  transition: left 0.2s cubic-bezier(0.22, 1, 0.36, 1), top 0.2s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease;
  opacity: 0; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.18));
}
#wt-agent-cursor.working { animation: wt-anim-wobble 0.8s ease-in-out infinite; }
#wt-agent-cursor.drawing { animation: none; transition: left 0.12s linear, top 0.12s linear, opacity 0.25s ease; }
@keyframes wt-anim-wobble {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  25%  { transform: translate(1px, -1px) rotate(2deg); }
  50%  { transform: translate(-1px, 1px) rotate(-1deg); }
  75%  { transform: translate(1px, 0px) rotate(1deg); }
}
#wt-cursor-label { margin-top: 14px; margin-left: -3px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.15)); }`;

// Markup del cursor de Stitch (Dr): la flecha, el pincel del reveal de imágenes y la pastilla con dos puntos. El modo
// texto no se usa en el renderer (re-renderer-iframe.md).
const CURSOR_HTML = `
<svg class="cursor-pointer" width="20" height="20" viewBox="0 0 34 34" fill="none" aria-hidden="true">
  <path d="M15.0624 32.3549L5.16251 5.48544L32.0324 15.3848L19.3046 19.6276L15.0624 32.3549Z" fill="${CURSOR_FILL}"/>
  <path d="M4.80877 5.13207C4.94657 4.99427 5.15206 4.94886 5.33496 5.01606L32.205 14.9156C32.4041 14.9889 32.5354 15.1799 32.5323 15.392C32.529 15.6043 32.392 15.7924 32.1905 15.8595L19.6994 20.0227L15.5369 32.5131C15.4697 32.7145 15.2824 32.8509 15.0701 32.8542C14.8578 32.8575 14.6664 32.7268 14.5929 32.5276L4.69276 5.65826L4.67343 5.5892C4.63863 5.42535 4.68814 5.25283 4.80877 5.13207Z" stroke="rgba(255,255,255,0.15)" stroke-linejoin="round"/>
</svg>
<svg class="cursor-paint" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M18.5 1.5c.8-.8 2.1-.8 2.8 0 .8.8.8 2.1 0 2.8L11 14.5l-3.5 1 1-3.5L18.5 1.5z" fill="${CURSOR_FILL}" stroke="${PAINT_STROKE}" stroke-width="1" stroke-linejoin="round"/>
  <path d="M7 14.5c-2 2-3.5 4-3.5 5.5 0 1.5 1 2.5 2.5 2.5 1.5 0 3.5-1.5 5.5-3.5" stroke="${CURSOR_FILL}" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M4 20c-.5.5-1.2 1-2 1.2" stroke="${DRAW_COLOR}" stroke-width="1" stroke-linecap="round"/>
</svg>
<svg id="wt-cursor-label" width="28" height="14" viewBox="0 0 28 14" fill="none" aria-hidden="true">
  <rect width="28" height="14" rx="7" fill="${CURSOR_FILL}"/>
  <circle cx="10.5" cy="7" r="1.8" fill="white"/>
  <circle cx="17.5" cy="7" r="1.8" fill="white"/>
</svg>`;

/** Instala el puente y devuelve cómo quitarlo. Inerte si no hay origen o si la página no está dentro de un iframe. */
export function installRevealBridge(win: Window, origin: string | undefined): () => void {
  if (!origin || win.parent === win) return () => {};
  const doc = win.document;
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let observer: MutationObserver | null = null;
  let ui: { style: HTMLStyleElement; cursor: HTMLDivElement } | null = null;
  let tick: number | null = null;
  let queue: Pending<HTMLElement>[] = [];
  let drawing = false;
  // isStreaming de Stitch: con el aviso apagado la cola termina sus dibujos y recién ahí se desarma todo.
  let streaming = false;
  let counts = new WeakMap<HTMLElement, number>();
  // Lo que se quitó de cada padre y todavía no tuvo reemplazo: un App que falla y vuelve a montar ~1 s después cae en
  // otro lote del observer, y sin esto cada remonte se animaría entero.
  let removed = new WeakMap<Node, Element[]>();
  // cursorMoved: el cursor salta al primer elemento de cada lote, 300 ms antes de que empiece su dibujo.
  let cursorMoved = false;
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number) => {
    const id = win.setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };

  const show = (el: HTMLElement) => {
    el.style.opacity = '';
    el.classList.add('wt-anim-fade-in');
  };
  const place = (x: number, y: number) => {
    if (!ui) return;
    ui.cursor.style.left = `${x}px`;
    ui.cursor.style.top = `${y}px`;
  };
  const pointAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (!ui || r.width === 0 || r.height === 0) return;
    place(r.left + 12, r.top + 12);
    ui.cursor.style.opacity = '1';
    ui.cursor.classList.add('working');
  };
  // hideCursorIfIdle (renderer deob l.240-248): mientras dura el stream el cursor queda aunque la cola esté vacía.
  // Los timers pendientes son el fundido del último rectángulo: se espera a que termine antes de desarmar.
  const idle = () => !streaming && !queue.length && !drawing && !timers.size && !images.busy();

  const overlayAt = (r: Box) => {
    const box = doc.createElement('div');
    box.className = 'wt-anim-draw-overlay';
    box.setAttribute(INJECTED, '');
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    doc.body.appendChild(box);
    return box;
  };
  const images = createImageRevealer<HTMLImageElement>({
    later,
    box: (el) => el.getBoundingClientRect(),
    pointAt,
    place,
    paint: (on) => {
      ui?.cursor.classList.toggle('drawing', on);
      ui?.cursor.classList.toggle('paint-mode', on);
      ui?.cursor.classList.toggle('working', !on);
    },
    overlay: (r) => {
      const box = overlayAt(r);
      return { fade: () => box.classList.add('fading'), remove: () => box.remove() };
    },
    setSrc: (el, src, onload) => {
      el.onload = onload;
      el.setAttribute('src', src);
      el.removeAttribute(PENDING_SRC_ATTR);
    },
    dim: (el, on) => el.classList.toggle('wt-anim-img-dimming', on),
    reveal: (el, on) => el.classList.toggle('wt-anim-img-revealing', on),
  });

  const draw = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // moveCursor: a 12 px de la esquina superior izquierda; un elemento sin caja se muestra sin dibujo.
    if (!ui || r.width === 0 || r.height === 0) { show(el); return; }
    drawing = true;
    const { cursor } = ui;
    place(r.left + 12, r.top + 12);
    cursor.style.opacity = '1';
    const box = overlayAt(r);
    cursor.classList.add('drawing');
    cursor.classList.remove('working');
    drawPath(r).forEach((p, i) => later(() => place(p.x, p.y), (i + 1) * 100));
    later(() => {
      show(el);
      cursor.classList.remove('drawing');
      cursor.classList.add('working');
      box.classList.add('fading');
      later(() => box.remove(), FADE_OUT_MS);
      drawing = false;
    }, DRAW_MS);
  };

  const process = () => {
    const { draw: next, rest } = takeDue(queue, Date.now(), drawing);
    queue = rest;
    if (next) draw(next.el);
    if (idle()) teardown();
  };

  const enqueue = (el: Element) => {
    if (!(el instanceof HTMLElement) || !admit(counts, queue, el)) return;
    // Stitch lo oculta en el acto y lo deja en la cola: así no se ve a medio pintar antes de su turno.
    el.style.opacity = '0';
    queue = [...queue, { el, time: Date.now() + DELAY_MS }];
    if (!cursorMoved) { pointAt(el); cursorMoved = true; }
  };

  const mountUi = (): void => {
    const style = doc.createElement('style');
    style.textContent = CSS_TEXT;
    style.setAttribute(INJECTED, '');
    const cursor = doc.createElement('div');
    cursor.id = 'wt-agent-cursor';
    cursor.setAttribute(INJECTED, '');
    cursor.innerHTML = CURSOR_HTML;
    cursor.style.left = '-40px';
    cursor.style.top = '-40px';
    doc.head.appendChild(style);
    doc.body.appendChild(cursor);
    ui = { style, cursor };
  };

  // El paso de pending a src de Stitch (:3129-3131). Asignar src dispara la carga (HTML spec, update the image data).
  // Con movimiento, cada imagen entra por la cola de processNextImage; el aviso puede llegar con el puente ya desarmado
  // (las imágenes se generan después del turno), así que el cursor y el tick se vuelven a montar.
  const applyPending = (): void => {
    const pending = [...doc.querySelectorAll<HTMLImageElement>(`img[${PENDING_SRC_ATTR}]`)];
    if (!pending.length) return;
    if (reduced) {
      pending.forEach((img) => {
        img.src = img.getAttribute(PENDING_SRC_ATTR) ?? img.src;
        img.removeAttribute(PENDING_SRC_ATTR);
      });
      return;
    }
    if (!ui) mountUi();
    if (tick === null) tick = win.setInterval(process, TICK_MS);
    pending.forEach((img) => images.push(img, img.getAttribute(PENDING_SRC_ATTR) ?? img.src));
  };

  const start = (): void => {
    win.__wtGenerating = true;
    if (reduced) return;
    streaming = true;
    if (observer) return;
    // Una generación nueva es la ronda nueva de dom_operations de Stitch, que limpia los contadores (deob l.3993-3995).
    counts = new WeakMap();
    removed = new WeakMap();
    if (!ui) mountUi();
    observer = new MutationObserver((records) => {
      cursorMoved = false;
      const isOwn = (n: Node): n is Element => n.nodeType === 1 && !SKIP.has((n as Element).tagName) && !(n as Element).hasAttribute(INJECTED);
      records.forEach((r) => {
        const gone = [...r.removedNodes].filter(isOwn);
        if (gone.length) removed.set(r.target, [...(removed.get(r.target) ?? []), ...gone]);
      });
      const added = records.flatMap((r) => [...r.addedNodes]).filter(isOwn);
      topLevel(added, (o, i) => o.contains(i)).flatMap((el) => {
        const parent = el.parentNode;
        if (!parent) return [el];
        const { twin, rest } = takeTwin(removed.get(parent) ?? [], el.tagName);
        removed.set(parent, rest);
        // Lo que llega del DOM son Element: el diff solo devuelve hijos de `el`.
        return twin ? (changedElements(twin, el) as Element[]) : [el];
      }).forEach(enqueue);
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    if (tick === null) tick = win.setInterval(process, TICK_MS);
  };
  // handleStreamEnd (renderer deob l.1001-1017): deja de observar y esconde el cursor, pero no vacía la cola; cada
  // dibujo pendiente lo vuelve a mostrar y al terminar el último se desarma todo.
  const end = (): void => {
    win.__wtGenerating = false;
    streaming = false;
    observer?.disconnect();
    observer = null;
    if (ui) ui.cursor.style.opacity = '0';
    // Un turno sin paso de imágenes (sin generador o sin slots) no manda el aviso: lo que quedó diferido se aplica igual.
    // Va después de esconder el cursor: el reveal lo vuelve a mostrar sobre la primera imagen.
    applyPending();
    if (idle()) teardown();
  };
  const teardown = (): void => {
    observer?.disconnect();
    observer = null;
    streaming = false;
    if (tick !== null) win.clearInterval(tick);
    tick = null;
    timers.forEach((id) => win.clearTimeout(id));
    timers.clear();
    images.flush();
    queue.forEach((p) => show(p.el));
    queue = [];
    drawing = false;
    doc.querySelectorAll('.wt-anim-draw-overlay').forEach((n) => n.remove());
    ui?.cursor.remove();
    ui?.style.remove();
    ui = null;
  };
  const onMessage = (event: MessageEvent): void => {
    const active = parseGenerating(event.data, event.origin, origin);
    if (active === true) start();
    else if (active === false) end();
    else {
      const ready = parseImagesReady(event.data, event.origin, origin);
      if (!ready) return;
      applyPending();
      if (ready.bust) reloadImages(ready.bust);
    }
  };
  // Fotos reemplazadas en la misma ruta: se piden de nuevo con otro query. Las que fallaron vuelven a probar su ruta real,
  // por si el agente la creó después.
  const reloadImages = (n: number): void => {
    doc.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
      if (img.hasAttribute(PENDING_SRC_ATTR)) return;
      const broken = img.getAttribute(BROKEN_SRC_ATTR);
      const src = broken ?? img.getAttribute('src');
      if (!src) return;
      const next = bustSrc(src, n, win.location.origin);
      if (next === src && !broken) return;
      img.removeAttribute(BROKEN_SRC_ATTR);
      img.setAttribute('src', next);
    });
  };
  // Una ruta que no existe dejaba el ícono de imagen rota: queda el rectángulo neutro y la ruta guardada para reintentar.
  const onError = (event: Event): void => {
    const t = event.target;
    if (!(t instanceof HTMLImageElement) || t.hasAttribute(BROKEN_SRC_ATTR)) return;
    const src = t.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    t.setAttribute(BROKEN_SRC_ATTR, src);
    t.setAttribute('src', PLACEHOLDER_IMG);
  };
  doc.addEventListener('error', onError, true);
  win.addEventListener('message', onMessage);
  // load no burbujea: se escucha en captura para saber qué src ya existen sin tocar cada <img>.
  const loaded = new Set<string>();
  win.__wtLoadedSrcs = loaded;
  const onLoad = (event: Event): void => {
    const t = event.target;
    if (t instanceof HTMLImageElement && !t.hasAttribute(PENDING_SRC_ATTR)) loaded.add(t.getAttribute('src') ?? '');
  };
  doc.addEventListener('load', onLoad, true);
  try {
    win.parent.postMessage({ type: WT_BRIDGE_READY_MESSAGE }, origin);
  } catch {
    // El builder cerró o el origen no coincide: el aviso de onLoad sigue cubriendo el caso.
  }
  return () => {
    win.removeEventListener('message', onMessage);
    doc.removeEventListener('load', onLoad, true);
    doc.removeEventListener('error', onError, true);
    teardown();
  };
}
