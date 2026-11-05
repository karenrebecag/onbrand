// Core del transformer: brief + candidatos por rol -> selección óptima de ≤3 strips.
// Junta plan (qué roles) + rank (encaje por strip) + cohesión (criterio entre strips) en una
// optimización conjunta: enumera combinaciones de los top-K por rol y elige la de mayor
// (suma de encajes + cohesión). No es greedy — un hero ligeramente peor puede ganar si cohesiona
// mejor con el resto. El perfil de ritmo lo declara la librería (adaptador); el core no lo adivina.

import type { BrandComposition } from './brand';
import { planFrame, planSections } from './plan';
import { isBand, isBandInAnyTheme, rankCandidates, THEMES } from './rank';
import { cohesionScore, DEFAULT_PROFILE, wantsBand } from './cohesion';
import { unitsFirst } from './unit';
import type { Brief, Candidate, FrameRole, RhythmProfile, RoleSpec, Scored, Selection, Theme } from './types';

const TOP_K = 4; // candidatos por rol que entran a la optimización (acota el producto cartesiano)

/** Top-K por score, PERO reservando una banda si el perfil exige contraste: si el top-K no trae
 * ningún candidato con banda y existe uno, se añade el mejor. Sin esto, el tono clean hunde a las
 * bandas por debajo del corte y la optimización conjunta nunca puede meter contraste (D1 del QA). */
/** Recorta el pool de un rol: primero organism-first (decisión A, unitsFirst), luego las categorías
 * que la marca permite (spec.allowedCategories). Lee el SPEC (el sesgo ya resuelto en specFor), no la
 * composición: el punto único sigue en plan.ts. */
function eligible(spec: RoleSpec, pool: Candidate[]): Candidate[] {
  const organismFirst = unitsFirst(pool);
  if (!spec.allowedCategories?.length) return organismFirst;
  const allow = new Set(spec.allowedCategories);
  return organismFirst.filter((c) => allow.has(c.category));
}

function topKWithBand(ranked: Scored[], profile: RhythmProfile): Scored[] {
  const top = ranked.slice(0, TOP_K);
  if (!wantsBand(profile) || top.some((s) => isBandInAnyTheme(s.candidate))) return top;
  const band = ranked.find((s) => isBandInAnyTheme(s.candidate));
  return band ? [...top, band] : top;
}

/** Producto cartesiano de listas (acotado por TOP_K por lista). */
function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((combo) => list.map((item) => [...combo, item])), [[]]);
}

export interface PageSelection {
  selections: Selection[];
  total: number;
  cohesionReasons: string[];
  /** Perfil EFECTIVO: el pedido salvo que haya degradado en ambos temas; si difiere por tema, el pedido. */
  profile: RhythmProfile;
  /** Perfil efectivo por tema (degrada a neutral donde el pool no tiene banda). */
  effective: Record<Theme, RhythmProfile>;
}

/**
 * Elige la mejor página. `candidatesByRole` lo alimenta el runner con lo que devuelve el adaptador.
 * Un rol sin candidatos se omite (no se inventa un strip vacío).
 */
export function selectPage(
  brief: Brief,
  candidatesByRole: Record<string, Candidate[]>,
  profile: RhythmProfile = DEFAULT_PROFILE,
  composition?: BrandComposition,
  formByRole?: Record<string, string[]>,
): PageSelection {
  const specs: RoleSpec[] = planSections(brief, composition, formByRole).filter((s) => eligible(s, candidatesByRole[s.role] ?? []).length > 0);

  // top-K rankeado por rol, reservando una banda por rol si el perfil la pide
  const rankedByRole: Scored[][] = specs.map((spec) =>
    topKWithBand(rankCandidates(brief, spec, eligible(spec, candidatesByRole[spec.role] ?? [])), profile),
  );

  // Invariante D2a (vive aquí: select conoce el pool): disponibilidad de banda POR TEMA sobre el pool
  // evaluado. Si el perfil pide banda y un tema no tiene ninguna, ese tema degrada a neutral — así una
  // penalización inalcanzable no puntúa. Se decide por tema porque la cohesión promedia light+dark.
  const pool = rankedByRole.flat().map((s) => s.candidate);
  const bandAvailable = Object.fromEntries(THEMES.map((t) => [t, pool.some((c) => isBand(c, t))])) as Record<Theme, boolean>;
  const effective = Object.fromEntries(
    THEMES.map((t) => [t, wantsBand(profile) && !bandAvailable[t] ? DEFAULT_PROFILE : profile]),
  ) as Record<Theme, RhythmProfile>;
  const effectiveProfile = THEMES.every((t) => effective[t] === effective[THEMES[0]]) ? effective[THEMES[0]] : profile;
  const degraded = THEMES.filter((t) => effective[t] !== profile);
  const degradeReason =
    degraded.length === 0
      ? undefined
      : degraded.length === THEMES.length
        ? `perfil ${profile} pedido, pool sin bandas → neutral`
        : degraded.map((t) => `[${t}] perfil ${profile} pedido, sin banda → neutral`).join('; ');

  // optimización conjunta sobre las combinaciones de los top-K.
  // Dedupe de slug: features y steps comparten pool (feature-sections), así que una combinación
  // podría repetir el MISMO componente en dos strips. Se descartan; si TODO repite, se cae a permitir.
  const allCombos = cartesian(rankedByRole.map((scoreds) => scoreds.map((s) => s)));
  const noDup = allCombos.filter((combo) => new Set(combo.map((s) => s.candidate.slug)).size === combo.length);
  const combos = noDup.length ? noDup : allCombos;
  let best: { combo: Scored[]; total: number; cohesionReasons: string[] } | undefined;
  for (const combo of combos) {
    const base = combo.reduce((sum, s) => sum + s.score, 0);
    const coh = cohesionScore(combo.map((s) => s.candidate), brief, profile, bandAvailable);
    const total = base + coh.score;
    const key = combo.map((s) => s.candidate.slug).join('|');
    if (!best || total > best.total || (total === best.total && key < best.combo.map((s) => s.candidate.slug).join('|'))) {
      best = { combo, total, cohesionReasons: coh.reasons };
    }
  }

  if (!best) return { selections: [], total: 0, cohesionReasons: degradeReason ? [degradeReason] : [], profile: effectiveProfile, effective };

  const selections: Selection[] = best.combo.map((scored, i) => {
    const role = specs[i].role;
    const alternates = rankedByRole[i].filter((s) => s.candidate.slug !== scored.candidate.slug).map((s) => s.candidate);
    return { role, pick: scored.candidate, score: scored.score, reasons: scored.reasons, alternates };
  });

  const cohesionReasons = degradeReason ? [...best.cohesionReasons, degradeReason] : best.cohesionReasons;
  return { selections, total: best.total, cohesionReasons, profile: effectiveProfile, effective };
}

/** Marco (chrome): elige el mejor navbar/footer/banner individualmente (no entran a la cohesión
 * de los strips: su lugar es fijo —arriba/abajo— y no compiten por ritmo con el contenido). */
export function selectFrame(brief: Brief, candidatesByRole: Record<string, Candidate[]>, composition?: BrandComposition, formByRole?: Record<string, string[]>): Selection[] {
  return planFrame(brief, composition, formByRole)
    .filter((spec) => eligible(spec, candidatesByRole[spec.role] ?? []).length > 0)
    .map((spec) => {
      const ranked = rankCandidates(brief, spec, eligible(spec, candidatesByRole[spec.role] ?? []));
      const [top, ...rest] = ranked;
      return { role: spec.role, pick: top.candidate, score: top.score, reasons: top.reasons, alternates: rest.map((s) => s.candidate) };
    });
}

export interface PageResult {
  frame: Partial<Record<FrameRole, Selection>>;
  strips: Selection[];
  total: number;
  cohesionReasons: string[];
  /** Perfil EFECTIVO (ver PageSelection.profile). */
  profile: RhythmProfile;
  /** Perfil efectivo por tema. */
  effective: Record<Theme, RhythmProfile>;
}

/** Página completa: marco (navbar/footer/banner) + contenido (≤3 strips con cohesión). */
export function composePage(
  brief: Brief,
  candidatesByRole: Record<string, Candidate[]>,
  profile: RhythmProfile = DEFAULT_PROFILE,
  composition?: BrandComposition,
  formByRole?: Record<string, string[]>,
): PageResult {
  const content = selectPage(brief, candidatesByRole, profile, composition, formByRole);
  const frame: Partial<Record<FrameRole, Selection>> = {};
  for (const sel of selectFrame(brief, candidatesByRole, composition, formByRole)) frame[sel.role as FrameRole] = sel;
  return { frame, strips: content.selections, total: content.total, cohesionReasons: content.cohesionReasons, profile: content.profile, effective: content.effective };
}
