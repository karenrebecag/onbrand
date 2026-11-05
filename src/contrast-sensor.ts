// contrast.wcag (Q4, RE de iteración 2026-10-29): ninguna herramienta mide el contraste. Tras un fondo oscuro global,
// Stitch pasó de 1 a 13 textos ilegibles sin decirlo, y v0 dejó 34 de 109 bajo AA desde el primer turno. Corre dentro
// del preview-check, así que cada versión trae su medida. El kind `contrast` queda fuera de RUNTIME_KINDS: no dispara
// auto-repair, se reporta al builder como un "preview issue" con su par de colores y razón, y el arreglo lo pide la
// persona con un botón (patrón v0, HALLAZGOS-secondary-autofix-sandbox.md:33-35). Calibración: las páginas del agente de
// QA dan 0 fallos (152 y 165 textos), y Stitch tras el fondo oscuro da 13.

import type { RuntimeDefect } from './runtime-sensors';

export type Rgb = readonly [number, number, number];

export interface ContrastSample {
  slug: string | null;
  text: string;
  fg: Rgb;
  bg: Rgb;
  large: boolean;
}

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Razón de contraste WCAG 2.x entre dos colores opacos (1 a 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA: 4,5 para texto normal y 3 para grande (≥24 px, o ≥18,66 px en negrita). */
export const minimumRatio = (large: boolean): number => (large ? 3 : 4.5);

/** rgb [0-255] a hex `#rrggbb`, para que el aviso muestre el par de colores sin arrastrar el tipo Rgb. */
const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Un defecto por sección, con cuántos textos fallan y el peor: treinta líneas iguales no ayudan a arreglar nada. Lleva
 * el par de colores y la razón del peor texto para que el aviso del builder los muestre sin volver a medir. */
export function contrastDefects(samples: readonly ContrastSample[], viewport: number): RuntimeDefect[] {
  const bySlug = new Map<string | null, { n: number; worst: number; text: string; fg: Rgb; bg: Rgb }>();
  for (const s of samples) {
    const ratio = contrastRatio(s.fg, s.bg);
    if (ratio >= minimumRatio(s.large)) continue;
    const cur = bySlug.get(s.slug);
    if (!cur) bySlug.set(s.slug, { n: 1, worst: ratio, text: s.text, fg: s.fg, bg: s.bg });
    else if (ratio < cur.worst) bySlug.set(s.slug, { n: cur.n + 1, worst: ratio, text: s.text, fg: s.fg, bg: s.bg });
    else bySlug.set(s.slug, { ...cur, n: cur.n + 1 });
  }
  return [...bySlug].map(([slug, f]) => ({
    field: 'preview.runtime',
    owner: 'L6',
    kind: 'contrast',
    slug,
    viewport,
    message: `${f.n} ${f.n === 1 ? 'texto' : 'textos'} bajo WCAG AA; el peor, ${f.worst.toFixed(2)}:1 en "${f.text.slice(0, 60)}"`,
    text: f.text,
    ratio: Number(f.worst.toFixed(2)),
    colors: { fg: hex(f.fg), bg: hex(f.bg) },
  }));
}

/** Corre en el navegador (page.evaluate): sin imports ni cierres. Los colores pasan por un canvas para leer
 * oklch/lab como rgb; un fondo con imagen no se puede medir y se salta. */
export function collectContrastSamples(): ContrastSample[] {
  const cx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!cx) return [];
  const rgb = (c: string): { c: [number, number, number]; a: number } | null => {
    if (!c || c === 'transparent') return null;
    const a = (c.match(/\/\s*([\d.]+%?)\s*\)$/) ?? c.match(/rgba\([^)]*,\s*([\d.]+)\)$/) ?? [])[1];
    const alpha = a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : Number(a);
    if (alpha === 0) return { c: [0, 0, 0], a: 0 };
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
    return { c: [r ?? 0, g ?? 0, b ?? 0], a: alpha };
  };
  const bgOf = (el: Element): [number, number, number] | null => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = rgb(s.backgroundColor);
      if (c && c.a > 0.5) return c.c;
    }
    return [255, 255, 255];
  };
  const textOf = (n: Element): string => ((n as HTMLElement).innerText ?? n.textContent ?? '').trim();
  const out: ContrastSample[] = [];
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,a,button,span,label,td,th,dt,dd,blockquote')) {
    const text = textOf(el);
    if (!text || [...el.children].some((c) => textOf(c))) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const fg = rgb(s.color);
    const bg = bgOf(el);
    if (!fg || fg.a <= 0.5 || !bg) continue;
    const size = parseFloat(s.fontSize);
    out.push({ slug: el.closest('[data-wt-slug]')?.getAttribute('data-wt-slug') ?? null, text: text.replace(/\s+/g, ' '), fg: fg.c, bg, large: size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700) });
  }
  return out;
}
