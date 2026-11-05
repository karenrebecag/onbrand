// preview.layout (Q6): con la verificación proporcional, un follow-up de copy ya no pide capturas al agente, así que lo que
// un texto más largo rompe tiene que medirlo el preview-check: desborde horizontal y CTA partido en dos líneas, sobre todo
// a 375. Corre en cada versión, no solo en las de copy.

import type { RuntimeDefect } from './runtime-sensors';

export interface LayoutSample {
  overflow: { scrollWidth: number; clientWidth: number; offenders: { slug: string | null; what: string }[] };
  wrappedCtas: { slug: string | null; text: string; lines: number }[];
}

export function layoutDefects(s: LayoutSample, viewport: number): RuntimeDefect[] {
  const out: RuntimeDefect[] = [];
  if (s.overflow.scrollWidth > s.overflow.clientWidth + 1) {
    const bySlug = new Map<string | null, string[]>();
    for (const o of s.overflow.offenders) bySlug.set(o.slug, [...(bySlug.get(o.slug) ?? []), o.what]);
    if (!bySlug.size) bySlug.set(null, []);
    for (const [slug, what] of bySlug) out.push({ field: 'preview.runtime', owner: 'L6', kind: 'overflow', slug, viewport, message: `desborde horizontal: ${s.overflow.scrollWidth} px en ${s.overflow.clientWidth}${what.length ? `; ${what.join(', ')}` : ''}`.slice(0, 300) });
  }
  for (const c of s.wrappedCtas) out.push({ field: 'preview.runtime', owner: 'L6', kind: 'cta-wrap', slug: c.slug, viewport, message: `el botón "${c.text.slice(0, 60)}" se parte en ${c.lines} líneas` });
  return out;
}

/** Corre en el navegador (page.evaluate): sin imports ni cierres. Un CTA es un `button` o un enlace con fondo o borde de
 * botón, de texto corto; un acordeón, una pestaña o una pregunta larga no lo son (calibración: la FAQ de las páginas de QA
 * daba 5 falsos por página). Las líneas salen de los nodos de texto, agrupadas con tolerancia de media línea: un contador
 * o un ícono alineado 1 px más abajo no es otra línea. */
export function collectLayout(): LayoutSample {
  const cw = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll('body *')]
    .filter((e) => e.getBoundingClientRect().right > cw + 1)
    .filter((e, _, all) => !all.some((o) => o !== e && o.contains(e)))
    .slice(0, 5)
    .map((e) => ({ slug: e.closest('[data-wt-slug]')?.getAttribute('data-wt-slug') ?? null, what: `${e.tagName.toLowerCase()} (${Math.round(e.getBoundingClientRect().right)} px)` }));
  const looksLikeButton = (e: Element): boolean => {
    if (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') return true;
    const s = getComputedStyle(e);
    const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
    return filled || parseFloat(s.borderTopWidth) > 0;
  };
  const wrappedCtas: LayoutSample['wrappedCtas'] = [];
  for (const e of document.querySelectorAll('button, a, [role=button]')) {
    const box = e.getBoundingClientRect();
    if (!box.width || !box.height || !looksLikeButton(e)) continue;
    if (e.hasAttribute('aria-expanded') || e.getAttribute('role') === 'tab' || e.closest('[role=tablist]')) continue;
    const text = ((e as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > 40) continue;
    const half = (parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.2) / 2;
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    const tops: number[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < half)) tops.push(r.top);
    }
    if (tops.length > 1) wrappedCtas.push({ slug: e.closest('[data-wt-slug]')?.getAttribute('data-wt-slug') ?? null, text, lines: tops.length });
  }
  return { overflow: { scrollWidth: document.documentElement.scrollWidth, clientWidth: cw, offenders }, wrappedCtas };
}
