// Interfaz del motor agnóstico de librería. Cada librería (Arc, Relume) implementa esto:
// el finding (plan/rank/cohesión/select) corre igual sobre cualquier adaptador.

import type { Candidate, RhythmProfile, Role } from '../types';
import type { RoleCopy } from '../copy';

export interface LintResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

/** Metadata que el emit necesita para generar los imports y el JSX de App.tsx. */
export interface EmitEntry {
  slug: string;
  /** Ausente en un componente (átomo/molécula): no es sección, lo emite un slot de organismo. */
  role?: Role;
  /** Nombre del export del componente: el nombrado, o el binding si `exportDefault`. */
  export: string;
  exportDefault?: boolean;
  /** Import path tal como el scaffold lo resuelve (alias @/...). */
  importPath: string;
  /** Fuente prístina en disco (relativa a la raíz del repo), para lintear. null si todavía no se
   * trajo al scaffold (un bloque gate-ok sin vendorizar: `materialize` lo materializa al emitir). */
  source: string | null;
  verified: boolean;
  /** false = propless: no porta copy, todo lo que pinta es su demo horneado. */
  emittable?: boolean;
}

export interface LibraryAdapter {
  /** Identificador de la librería (arc, relume). */
  readonly id: string;
  /** Nombre del template scaffold que emit copia para esta librería. */
  readonly scaffold: string;
  /** Perfil de ritmo de la librería: la cohesión lo consume, el adaptador solo lo declara. */
  readonly rhythm: RhythmProfile;
  /** Pool verificado por rol para el finding (solo verified:true), ya traducido a superficie +
   * geometría del core. */
  verifiedCandidatesByRole(roles: Role[]): Record<string, Candidate[]>;
  /** Pool por rol para el finding. Con `unverified` incluye los bloques gate-ok (ingestados,
   * buildeables, sin render firmado): es lo que da variedad entre secciones. Sin él, equivale a
   * `verifiedCandidatesByRole`. */
  candidatesByRole(roles: Role[], opts?: { unverified?: boolean; innerSlot?: boolean; showcases?: readonly string[] }): Record<string, Candidate[]>;
  /** Materializa un slug elegido dentro del scaffold generado `outDir`: un item Arc se trae del vault
   * (fetch), un bloque Relume se transforma (tailwind->CSS modules) y se escribe. Un bloque ya
   * vendorizado (source no null) es no-op. Devuelve false si el slug no se pudo materializar. */
  materialize(slug: string, outDir: string): Promise<boolean>;
  /** Metadata de emit de un slug elegido. */
  entry(slug: string): EmitEntry | undefined;
  /** Lintea la fuente PRÍSTINA de un slug (no el output generado). */
  lint(slug: string): LintResult;
  /** Mapea el copy agnóstico del rol del slug a los props reales de ese bloque. undefined si no hay
   * copy para ese rol (el bloque se emite con sus defaults). Es específico de la librería. */
  propsFor(slug: string, copy: RoleCopy): Record<string, unknown> | undefined;
  /** Props con default visible que ni el copy canónico llena (spec politica-slots-visibles, RF5): lo
   * que el router usa para preferir otro bloque. `undefined` = sin opinión: el core aplica su propia
   * fórmula (Relume genérico por Defaults). Opcional para que un adaptador sin política no cambie. */
  unboundFor?(slug: string): string[] | undefined;
}
