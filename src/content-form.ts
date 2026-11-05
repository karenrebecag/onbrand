// Puente contenido->forma (investigación docs/notas/selector-contenido-a-forma.md): el selector
// empataba a decenas de candidatos porque consultaba tags fijos por rol e ignoraba la FORMA del
// contenido. La industria (Relume, Webflow, Wix) selecciona con la forma del plan de contenido por
// sección (nº de items, etc.) ANTES de elegir. Aquí derivamos esa forma del copy y la volvemos tags
// que el scorer YA pondera (se suman a desiredTags; no cambia el scorer). El copy es contenido puro
// (sin imágenes: "son el hueco de imágenes"), así que la señal disponible es el conteo de items y,
// en pricing, la presencia de precio anual (toggle mensual/anual = Tabs).

import type { Role } from './types';
import type { RoleCopy } from './copy';

/** Nº de items del contenido de un rol, o 0 si el rol no tiene una lista que defina su forma. */
export function itemCount(role: Role, copy: RoleCopy): number {
  switch (role) {
    case 'features': return copy.features?.items.length ?? 0;
    case 'testimonials': return copy.testimonials?.items.length ?? 0;
    case 'pricing': return copy.pricing?.plans.length ?? 0;
    case 'steps': return copy.steps?.steps.length ?? 0;
    case 'faq': return copy.faq?.items.length ?? 0;
    case 'logos': return copy.logos?.brands?.length ?? 0;
    case 'stats': return copy.stats?.stats.length ?? 0;
    default: return 0;
  }
}

/** Nº de columnas al tag del vocabulario Relume. 4+ cae a "4 Columns" (el tope del vocabulario). */
function columnsTag(n: number): string {
  const cols = Math.min(Math.max(n, 1), 4);
  return cols === 1 ? '1 Column' : `${cols} Columns`;
}

/** Roles cuyo nº de items SÍ mapea a columnas. faq (acordeón = filas), logos (marquee/fila) y steps
 * (secuencia vertical) tienen items pero no se disponen en columnas, así que un "N Columns" ahí es
 * señal falsa: no entra al overlay. */
const COLUMN_ROLES: ReadonlySet<Role> = new Set<Role>(['features', 'stats', 'testimonials', 'pricing']);

/** Tags de FORMA derivados del contenido de un rol. Vacío si el rol no aporta forma (el overlay no
 * lo toca y el rol se elige como hoy). Nunca inventa señal que el copy no tiene (p.ej. imágenes). */
export function formTagsFor(role: Role, copy: RoleCopy): string[] {
  const tags: string[] = [];
  const n = itemCount(role, copy);
  if (n > 0 && COLUMN_ROLES.has(role)) tags.push(columnsTag(n));
  // Pricing con nota de precio anual: el componente con toggle mensual/anual (Tabs) encaja.
  if (role === 'pricing' && (copy.pricing?.plans.some((p) => p.yearlyNote?.trim()) ?? false)) tags.push('Tabs');
  return tags;
}

/** Overlay de forma por rol, derivado del copy. Solo los roles con forma; el resto hereda su spec
 * base. Es lo que viaja del plan de contenido a la selección (lo que hoy no viajaba). */
export function formOverlay(copy: RoleCopy): Record<string, string[]> {
  const roles: Role[] = ['features', 'testimonials', 'pricing', 'steps', 'faq', 'logos', 'stats'];
  const out: Record<string, string[]> = {};
  for (const role of roles) {
    const tags = formTagsFor(role, copy);
    if (tags.length) out[role] = tags;
  }
  return out;
}
