// Regla de hrefs (QA, brecha #5): un href que emite el modelo en cualquier componente solo puede ser
// (a) un ancla `#id` a una sección que existe en la página, (b) una ruta legal del starter, (c) un
// `mailto:`/`tel:`/URL absoluta (socials, ficticios marcados en provenance), o (d) `#` a secas como
// placeholder EXPLÍCITO, que no se rebota pero se marca en provenance con claims vacío para que salga en
// "datos a confirmar" (v0 hace lo mismo: 24 `#` en el dump de j049, nunca rutas inventadas). Todo lo
// demás es un link roto en la página publicada y se rebota. Puro: no sabe de schemas; recorre props y slots.

export interface HrefPolicy {
  /** Anclas válidas con su `#`: `anchorsOf(sectionIds(roles))`, una por sección de la página. */
  anchors: readonly string[];
  /** Rutas fijas del starter (`/privacidad`, `/terminos`...). */
  legalRoutes: readonly string[];
}

export interface HrefViolation {
  /** Ruta dentro de la sección hasta la prop: `children[1].props.items[0].href`. */
  path: string;
  href: string;
  code: 'href-unresolved';
  detail: string;
}

/** Un `#` a secas: no es violación, es un hecho sin fuente que la provenance marca como claim vacío. */
export interface HrefPlaceholder {
  path: string;
}

export const PLACEHOLDER_HREF = '#';

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Nombres de prop que llevan un destino de navegación. */
const HREF_KEYS = new Set(['href', 'to', 'url', 'link']);
const EXTERNAL = /^(https?:\/\/|mailto:|tel:)/i;

/** Un href resuelve si es ancla de la página, ruta legal del starter, destino externo/contacto o el
 * placeholder `#` (aceptado, pero a marcar: ver hrefPlaceholders). */
export function hrefResolves(href: string, policy: HrefPolicy): boolean {
  const h = href.trim();
  if (!h) return false;
  if (h.startsWith('#')) return h === PLACEHOLDER_HREF || policy.anchors.includes(h);
  if (EXTERNAL.test(h)) return true;
  return policy.legalRoutes.includes(h);
}

/** Todos los hrefs de una sección con su ruta: recorre props (incluidos arrays y slots) sin tocar los textos. */
export function hrefsOf(section: unknown): { path: string; href: string }[] {
  const out: { path: string; href: string }[] = [];
  const walk = (n: unknown, path: string, inProps: boolean): void => {
    if (Array.isArray(n)) return n.forEach((c, i) => walk(c, `${path}[${i}]`, inProps));
    if (!isObj(n)) return;
    for (const [k, v] of Object.entries(n)) {
      const p = path ? `${path}.${k}` : k;
      if (inProps && HREF_KEYS.has(k) && typeof v === 'string') {
        out.push({ path: p, href: v });
        continue;
      }
      walk(v, p, inProps || k === 'props');
    }
  };
  walk(section, '', false);
  return out;
}

/** Violaciones de href en una sección: lo que no resuelve. El `#` no está aquí (ver hrefPlaceholders). */
export function hrefViolations(section: unknown, policy: HrefPolicy): HrefViolation[] {
  return hrefsOf(section)
    .filter(({ href }) => !hrefResolves(href, policy))
    .map(({ path, href }) => ({ path, href, code: 'href-unresolved' as const, detail: `"${href}" no es ancla de la página (${policy.anchors.join(', ') || 'ninguna'}), ruta legal, destino externo ni el placeholder "#"` }));
}

/** Placeholders `#` de una sección: aceptados por el verify, pero cada uno es un claim vacío en provenance. */
export function hrefPlaceholders(section: unknown): HrefPlaceholder[] {
  return hrefsOf(section).filter(({ href }) => href.trim() === PLACEHOLDER_HREF).map(({ path }) => ({ path }));
}

/** Anclas a partir de los ids de sección. Los ids los da `sectionIds(roles)` de src/runtime/layout.ts
 * (feat/v0-transport b5f4fd5), la única fuente que comparten el runner (que escribe el `id`) y el
 * composer; este módulo no los recalcula para que un `#features` no pueda dejar de resolver. */
export const anchorsOf = (sectionIds: readonly string[]): string[] => sectionIds.map((id) => `#${id}`);
