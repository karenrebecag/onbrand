// Composición de dos capas (ADR 0001, spec RF12): si el finding eligió un `kind: layout` para un
// strip, aquí se resuelve su `inner` corriendo router + selectPage sobre el pool de la librería
// inner acotado al `allow` del slot, y el resultado se guarda EN LOS PROPS del layout
// (`props.inner = { slug, props }`, patrón Puck), no en un árbol aparte. selectPage/composePage no
// cambian de firma: esto corre después, sobre su resultado.

import type { LibraryAdapter } from './adapters/types';
import type { BrandComposition } from './brand';
import type { CatalogEntry } from './catalog/schema';
import type { RoleCopy } from './copy';
import { routeCandidates } from './router';
import { selectPage, type PageResult } from './select';
import type { Brief, Role, SectionRole, Selection } from './types';

export interface InnerPick {
  slug: string;
  props?: Record<string, unknown>;
}

/** Metadata de emit de una capa (layout o inner): lo que App.tsx necesita para importarla. */
export interface LayerRef {
  slug: string;
  export: string;
  importPath: string;
}

export interface Layer {
  role: Role;
  layout: LayerRef;
  /** Props del layout (los suyos, desde el copy vía propsFor) y el inner dentro (Puck). */
  props: Record<string, unknown> & { inner: InnerPick };
  inner: LayerRef;
  innerSelection: Selection;
}

export interface LayeredPage extends PageResult {
  layers: Layer[];
}

export interface ComposeLayersOptions {
  /** Índice de donde el router lee manifiestos (tests lo inyectan). */
  catalog?: CatalogEntry[];
  copy?: RoleCopy;
  /** Inners del pool gate-ok (como las secciones), no solo verified. */
  unverified?: boolean;
  /** Sesgo de marca (ADR 0003): llega al inner igual que a las secciones, para que la marca pueda
   * preferir un showcase arc en el slot. La intención del brief gana en conflicto. */
  composition?: BrandComposition;
}

export const isLayout = (e: CatalogEntry): boolean => e.kind === 'layout' && e.slots !== undefined;

/** Elige el inner de un rol: pool del adaptador inner filtrado por el router y rankeado por
 * selectPage con un brief acotado a ese único rol. */
export function pickInner(brief: Brief, role: Role, innerAdapter: LibraryAdapter, exclude: ReadonlySet<string>, options: ComposeLayersOptions = {}): Selection | undefined {
  // El slot solo admite roles de sección (allow se valida en el schema); el marco nunca anida.
  const scoped: Brief = { ...brief, sections: [role as SectionRole], maxStrips: 1 };
  const routed = routeCandidates(scoped, innerAdapter, {
    innerSlot: true,
    ...(options.unverified ? { unverified: true } : {}),
    ...(options.catalog ? { catalog: options.catalog } : {}),
    ...(options.composition ? { composition: options.composition } : {}),
  });
  // Los layouts compiten en el mismo pool (ADR 0001 §1); un layout nunca es inner de otro (max 1 nivel).
  const pool = (routed.candidatesByRole[role] ?? []).filter((c) => !exclude.has(c.slug));
  if (!pool.length) return undefined;
  return selectPage(scoped, { [role]: pool }, innerAdapter.rhythm, options.composition).selections[0];
}

/** Resuelve el inner de cada strip cuyo pick es un layout. Falla con el slug si el slot no admite
 * el rol del strip (CA15) o si no hay inner verificado para ese rol. */
export function composeLayers(brief: Brief, page: PageResult, layouts: CatalogEntry[], innerAdapter: LibraryAdapter, options: ComposeLayersOptions = {}): LayeredPage {
  const bySlug = new Map(layouts.filter(isLayout).map((e) => [e.slug, e]));
  const layoutSlugs = new Set(bySlug.keys());
  const layers = page.strips.flatMap((strip): Layer[] => {
    const layout = bySlug.get(strip.pick.slug);
    if (!layout?.slots) return [];
    const allow = layout.slots.inner.allow;
    if (!allow.includes(strip.role)) {
      throw new Error(`composeLayers (${layout.slug}): el slot inner no admite el rol "${strip.role}" (allow: ${allow.join(', ')})`);
    }
    const innerSelection = pickInner(brief, strip.role, innerAdapter, layoutSlugs, options);
    if (!innerSelection) throw new Error(`composeLayers (${layout.slug}): sin inner verificado de ${innerAdapter.id} para el rol "${strip.role}"`);
    const innerEntry = innerAdapter.entry(innerSelection.pick.slug);
    if (!innerEntry) throw new Error(`composeLayers (${layout.slug}): el inner ${innerSelection.pick.slug} no tiene source para emitir`);
    const innerProps = options.copy ? innerAdapter.propsFor(innerSelection.pick.slug, options.copy) : undefined;
    // El layout está hosteado en el scaffold del adaptador inner, así que sus props salen del mismo propsFor.
    const layoutProps = options.copy ? innerAdapter.propsFor(layout.slug, options.copy) : undefined;
    return [{
      role: strip.role,
      layout: { slug: layout.slug, export: layout.export, importPath: layout.importPath },
      props: { ...(layoutProps ?? {}), inner: { slug: innerSelection.pick.slug, ...(innerProps ? { props: innerProps } : {}) } },
      inner: { slug: innerEntry.slug, export: innerEntry.export, importPath: innerEntry.importPath },
      innerSelection,
    }];
  });
  return { ...page, layers };
}
