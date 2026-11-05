// Lado Relume del índice unificado: el "approved set" por rol. El finding corre SOLO sobre las
// entradas `library: "relume"` con verified=true; lo roto o fuera de tema queda registrado con
// verified=false y la razón en notes, para que nadie lo vuelva a meter sin saber por qué salió.
//
// Aquí vive también la traducción del vocabulario crudo del MCP (`layoutStyle`, tags "Background
// Image/Video") a superficie + geometría del core: la usan la migración y los scripts que embeben
// resultados crudos de `search_components`. rank/cohesion nunca ven ese vocabulario. Relume declara
// perfil de ritmo `banded`.

import { catalogFor } from './catalog/load';
import type { CatalogEntry } from './catalog/schema';
import type { Candidate, RhythmProfile, Role, Surface, SurfaceByTheme } from './types';

export const RELUME_RHYTHM: RhythmProfile = 'banded';

/** Una entrada Relume del índice unificado. */
export type RegistryEntry = CatalogEntry;

/** Las entradas `library: "relume"` del índice cuyo source vive en el pipeline Relume. Lo portado a un scaffold
 * (layouts y bloques hosteados, ADR 0001) lo sirve el adaptador de ese DS, no este. */
export const loadRegistry = (): RegistryEntry[] =>
  catalogFor('relume').filter((e) => !e.source?.startsWith('templates/'));

/** Tag que delata una imagen/vídeo de fondo. Los componentes nuevos de Relume vienen SIN
 * layoutStyle, así que la superficie también se deriva de los tags, o un "Background Image" pasa
 * por el más claro. */
const MEDIA_TAG = /background\s+(image|video)/i;

/** Superficie Relume: `background` o un tag de fondo = media (imagen/vídeo de fondo). Lo demás
 * (standard, card, edge_to_edge, overlapping, off_grid) es geometría sobre fondo de página. Relume
 * no cambia con el tema. */
export function relumeSurface(tags: string[], layoutStyle: string[]): SurfaceByTheme {
  const media = layoutStyle.includes('background') || tags.some((t) => MEDIA_TAG.test(t));
  const s: Surface = media ? 'media' : 'base';
  return { light: s, dark: s };
}

/** Geometría Relume: el primer layoutStyle que no sea `background` (que es superficie, no forma). */
export const relumeGeometry = (layoutStyle: string[]): string =>
  layoutStyle.find((s) => s !== 'background') ?? 'standard';

export interface RelumeComponent {
  slug: string;
  name: string;
  category: string;
  tags: string[];
  layoutStyle: string[];
  preview?: string;
}

/** Candidate del core a partir de un resultado crudo del MCP de Relume (scripts de demo). */
export const relumeCandidate = (e: RelumeComponent): Candidate => ({
  slug: e.slug,
  name: e.name,
  category: e.category,
  tags: [...e.tags],
  surface: relumeSurface(e.tags, e.layoutStyle),
  geometry: relumeGeometry(e.layoutStyle),
  ...(e.preview !== undefined ? { preview: e.preview } : {}),
});

const toCandidate = (e: RegistryEntry): Candidate => ({
  slug: e.slug,
  name: e.name,
  category: e.category,
  tags: [...e.tags],
  surface: { ...e.surface },
  geometry: e.geometry,
});

/** Candidatos VERIFICADOS de un rol. Lo no verificado no existe para el finding. */
export function candidatesForRole(role: Role, registry: RegistryEntry[] = loadRegistry()): Candidate[] {
  return registry.filter((e) => e.role === role && e.verified && e.emittable !== false).map(toCandidate);
}

/** Pool por rol para selectPage/composePage, armado SOLO desde el índice (el gate). */
export function verifiedCandidatesByRole(roles: Role[], registry: RegistryEntry[] = loadRegistry()): Record<string, Candidate[]> {
  return Object.fromEntries(roles.map((role) => [role, candidatesForRole(role, registry)]));
}
