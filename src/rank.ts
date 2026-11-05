// Ranking por candidato: puntúa qué tan bien encaja un ejemplar en su rol, según señales
// estructuradas (overlap de tags + intensidad de superficie vs tono del brief). No es fuzzy: es
// explicable. La superficie llega ya traducida por el adaptador; aquí no hay vocabulario de librería.

import { roleQuery, semanticMatch } from './semantic';
import type { Brief, Candidate, RoleSpec, Scored, Surface, Theme } from './types';

/** Intensidad ordinal de una superficie: 0 claro/neutro … 3 fondo pesado. Gobierna la claridad
 * (tono clean) y la regla de no apilar bandas (cohesión). dark y media pesan igual: ambas rompen
 * el blanco por completo. */
export const INTENSITY: Record<Surface, number> = {
  base: 0,
  tinted: 1,
  dark: 3,
  media: 3,
};

/** Una banda REAL: intensidad 3. Un tinte (1) es visualmente casi blanco y NO cuenta — así el
 * optimizador no puede "esquivar" la planicie sin añadir contraste de verdad. */
export const BAND_INTENSITY = 3;

/** Temas en los que se evalúa toda página (decisión de Karen 2026-10-15: ambos, no solo light). */
export const THEMES: readonly Theme[] = ['light', 'dark'];

export const intensity = (c: Candidate, theme: Theme): number => INTENSITY[c.surface[theme]];

export const isBand = (c: Candidate, theme: Theme): boolean => intensity(c, theme) >= BAND_INTENSITY;

/** Banda en cualquiera de los temas: lo que la reserva de top-K necesita saber. */
export const isBandInAnyTheme = (c: Candidate): boolean => THEMES.some((t) => isBand(c, t));

/** Nº de columnas declarado en los tags ("3 Columns" -> 3), o 0 si no lo dice. */
export function columns(c: Candidate): number {
  for (const t of c.tags) {
    const m = /^(\d+)\s+Columns?$/i.exec(t.trim());
    if (m) return Number(m[1]);
  }
  return 0;
}

const TAG_WEIGHT = 2;
const UNDESIRED_WEIGHT = 3; // una señal que contradice la intención pesa más que un parecido
const SEM_WEIGHT = 2; // un token de dominio compartido pesa como un tag deseado: el eje semántico compite de igual a igual con el estructural
const norm = (s: string): string => s.trim().toLowerCase();

/** Afinidad de superficie al tono, promediada en los temas: clean premia liviandad (3-h), bold
 * premia pesadez (h). Escala 0..3; en una librería cuya superficie no cambia con el tema es
 * exactamente el valor de un tema. */
function styleScore(c: Candidate, bold: boolean): number {
  const perTheme = THEMES.map((t) => (bold ? intensity(c, t) : 3 - intensity(c, t)));
  return perTheme.reduce((s, v) => s + v, 0) / perTheme.length;
}

/** Puntúa un candidato para su rol. Señales: overlap de tags deseados (estructura), overlap semántico
 * del brief contra el manifiesto (dominio), penalización por tags que contradicen la intención, y
 * afinidad de superficie al tono. `query` es la consulta semántica del rol; si se omite se deriva del
 * brief (recalcularla por candidato es barato, pero rankCandidates la pasa una vez). */
export function scoreCandidate(brief: Brief, spec: RoleSpec, c: Candidate, query?: ReadonlySet<string>): Scored {
  const reasons: string[] = [];
  const has = new Set(c.tags.map(norm));

  const want = new Set(spec.desiredTags.map(norm));
  const overlap = [...want].filter((t) => has.has(t));
  const tagScore = overlap.length * TAG_WEIGHT;
  if (overlap.length) reasons.push(`tags+${overlap.length} (${overlap.join(', ')})`);

  const sem = semanticMatch(query ?? roleQuery(brief, spec.role), c);
  const semScore = sem.score * SEM_WEIGHT;
  if (sem.score) reasons.push(`semántica+${sem.score} (${sem.overlap.join(', ')})`);

  const avoid = new Set((spec.undesiredTags ?? []).map(norm));
  const clash = [...avoid].filter((t) => has.has(t));
  const clashScore = clash.length * UNDESIRED_WEIGHT;
  if (clash.length) reasons.push(`contra-intención-${clash.length} (${clash.join(', ')})`);

  const bold = brief.tone === 'bold';
  const style = styleScore(c, bold);
  const surfaces = THEMES.map((t) => c.surface[t]);
  const label = surfaces.every((s) => s === surfaces[0]) ? surfaces[0] : surfaces.join('/');
  reasons.push(bold ? `estilo pesado ${style}/3 (${label})` : `claridad ${style}/3 (${label})`);

  return { candidate: c, score: tagScore + semScore - clashScore + style, reasons };
}

/** Rankea los candidatos de un rol, de mejor a peor. Desempate estable por slug. */
export function rankCandidates(brief: Brief, spec: RoleSpec, candidates: Candidate[]): Scored[] {
  const query = roleQuery(brief, spec.role);
  return candidates
    .map((c) => scoreCandidate(brief, spec, c, query))
    .sort((a, b) => b.score - a.score || a.candidate.slug.localeCompare(b.candidate.slug));
}
