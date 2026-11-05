// Cohesión: puntúa una COMBINACIÓN de strips como página, no cada strip por separado. Aquí vive el
// criterio de diseño entre secciones: no apilar fondos oscuros, variar columnas y geometrías, abrir
// claro. El finding óptimo maximiza (suma de encajes individuales + esta cohesión), no es greedy.
//
// El ritmo NO es universal: Relume alterna banda/claro y castiga la página toda blanca; Arc es
// "quiet" (casi todo neutro, como mucho un backdrop, sin repetir geometría entre vecinas). Cada
// librería declara un PERFIL; los pesos de cada perfil viven aquí, testeables, y el adaptador solo
// elige. Se evalúa en light y dark y se promedia (la superficie se clasifica por tema).

import type { Brief, Candidate, RhythmProfile, Theme } from './types';
import { columns, intensity, isBand, THEMES } from './rank';

export interface CohesionWeights {
  darkAdjacent: number; // dos bandas de fondo pesado (intensidad 3) seguidas
  heavyAdjacent: number; // dos superficies pesadas (intensidad ≥2) seguidas, no ambas 3
  columnVariety: number; // por cada nº de columnas distinto (más allá del primero)
  geometryVariety: number; // por cada geometría distinta (más allá de la primera)
  sameGeometryAdjacent: number; // por cada par de vecinas con la MISMA geometría
  heroOpenClean: number; // tono clean y el primer strip abre liviano (intensidad ≤1)
  rhythm: number; // por cada par adyacente banda ↔ no-banda (alternar da ritmo)
  flatPenalty: number; // página de ≥4 strips sin NINGUNA banda real: jerarquía plana, todo blanco
  bandPresent: number; // tener 1..maxBands bandas rompe el blanco
  maxBands: number; // más bandas que esto es exceso
  bandExcess: number; // exceso de bandas: demasiado pesado, pierde el contraste
}

const COMMON = {
  darkAdjacent: -6,
  heavyAdjacent: -3,
  columnVariety: 1,
  geometryVariety: 1,
  heroOpenClean: 2,
  rhythm: 1,
  bandExcess: -2,
} as const;

export const PROFILES: Record<RhythmProfile, CohesionWeights> = {
  // Relume: 1-2 bandas reales rompen el blanco; una landing larga sin ninguna es plana.
  banded: { ...COMMON, sameGeometryAdjacent: 0, flatPenalty: -5, bandPresent: 3, maxBands: 2 },
  // Arc: "most of the screen stays neutral", un backdrop como mucho, y "no two adjacent sections
  // share a layout". Una banda no se exige: una penalización que ningún candidato puede evitar no
  // informa nada.
  quiet: { ...COMMON, sameGeometryAdjacent: -3, flatPenalty: 0, bandPresent: 0, maxBands: 1 },
  // Default cuando el adaptador no declara perfil (decisión de Karen 2026-10-15).
  neutral: { ...COMMON, sameGeometryAdjacent: 0, flatPenalty: 0, bandPresent: 0, maxBands: 2 },
};

export const DEFAULT_PROFILE: RhythmProfile = 'neutral';

/** Si el perfil exige contraste, select.ts reserva una banda en el top-K de cada rol. */
export const wantsBand = (profile: RhythmProfile): boolean => PROFILES[profile].bandPresent > 0;

export interface CohesionResult {
  score: number;
  reasons: string[];
}

const MIN_STRIPS_FOR_FLAT = 4;

/** Puntúa una combinación ordenada en UN tema. */
function scoreTheme(combo: Candidate[], brief: Brief, w: CohesionWeights, theme: Theme): CohesionResult {
  const reasons: string[] = [];
  let score = 0;

  // penalización por bandas pesadas adyacentes
  for (let i = 1; i < combo.length; i++) {
    const a = intensity(combo[i - 1], theme);
    const b = intensity(combo[i], theme);
    if (a >= 3 && b >= 3) {
      score += w.darkAdjacent;
      reasons.push(`fondos oscuros adyacentes (${combo[i - 1].slug}/${combo[i].slug}) ${w.darkAdjacent}`);
    } else if (a >= 2 && b >= 2) {
      score += w.heavyAdjacent;
      reasons.push(`bandas pesadas adyacentes ${w.heavyAdjacent}`);
    }
  }

  // variedad de columnas
  const cols = new Set(combo.map(columns).filter((n) => n > 0));
  if (cols.size > 1) {
    const bonus = (cols.size - 1) * w.columnVariety;
    score += bonus;
    reasons.push(`variedad de columnas (${[...cols].join('/')}) +${bonus}`);
  }

  // variedad de geometrías
  const geometries = new Set(combo.map((c) => c.geometry).filter(Boolean));
  if (geometries.size > 1) {
    const bonus = (geometries.size - 1) * w.geometryVariety;
    score += bonus;
    reasons.push(`variedad de geometrías (${[...geometries].join('/')}) +${bonus}`);
  }

  // geometría repetida entre vecinas (perfil quiet)
  if (w.sameGeometryAdjacent) {
    for (let i = 1; i < combo.length; i++) {
      const g = combo[i].geometry;
      if (g && g === combo[i - 1].geometry) {
        score += w.sameGeometryAdjacent;
        reasons.push(`geometría repetida (${combo[i - 1].slug}/${combo[i].slug}: ${g}) ${w.sameGeometryAdjacent}`);
      }
    }
  }

  // apertura clara
  if (brief.tone !== 'bold' && combo.length && intensity(combo[0], theme) <= 1) {
    score += w.heroOpenClean;
    reasons.push(`apertura clara +${w.heroOpenClean}`);
  }

  // ritmo: alternar BANDA ↔ claro. Solo cuenta transiciones banda↔no-banda; una diferencia
  // tinted↔base es visualmente invisible y premiarla deja al hero "gamear" el score (C3).
  let alternations = 0;
  for (let i = 1; i < combo.length; i++) {
    if (isBand(combo[i], theme) !== isBand(combo[i - 1], theme)) alternations++;
  }
  if (alternations) {
    const bonus = alternations * w.rhythm;
    score += bonus;
    reasons.push(`ritmo (${alternations} alternancias) +${bonus}`);
  }

  // bandas reales: romper el blanco suma (si el perfil lo pide); 0 en página larga penaliza (idem);
  // más de maxBands pesa.
  const bands = combo.filter((c) => isBand(c, theme)).length;
  if (combo.length >= MIN_STRIPS_FOR_FLAT && bands === 0 && w.flatPenalty) {
    score += w.flatPenalty;
    reasons.push(`plana sin banda real ${w.flatPenalty}`);
  } else if (bands >= 1 && bands <= w.maxBands && w.bandPresent) {
    score += w.bandPresent;
    reasons.push(`banda(s) ${bands} +${w.bandPresent}`);
  } else if (bands > w.maxBands) {
    score += w.bandExcess;
    reasons.push(`exceso de bandas ${bands} ${w.bandExcess}`);
  }

  return { score, reasons };
}

/** Puntúa una combinación ordenada de strips bajo un perfil, en todos los temas. El score es el
 * promedio (mantiene la escala frente al encaje por strip); las razones se listan una vez si
 * coinciden en todos los temas, o prefijadas por tema si difieren. */
export function cohesionScore(combo: Candidate[], brief: Brief, profile: RhythmProfile = DEFAULT_PROFILE, bandAvailable?: Record<Theme, boolean>): CohesionResult {
  const perTheme = THEMES.map((theme) => {
    // Invariante por tema (select.ts decide `bandAvailable` sobre el pool): si el perfil pide banda y
    // ESTE tema no tiene ninguna, se puntúa el tema como neutral — una penalización que ningún
    // candidato puede evitar no informa nada. Sin `bandAvailable` (p.ej. test directo) nada cambia.
    const eff = bandAvailable && wantsBand(profile) && !bandAvailable[theme] ? DEFAULT_PROFILE : profile;
    return { theme, ...scoreTheme(combo, brief, PROFILES[eff], theme) };
  });
  const score = perTheme.reduce((s, r) => s + r.score, 0) / perTheme.length;
  const sameReasons = perTheme.every((r) => r.reasons.join('|') === perTheme[0].reasons.join('|'));
  const reasons = sameReasons
    ? perTheme[0].reasons
    : perTheme.flatMap((r) => r.reasons.map((x) => `[${r.theme}] ${x}`));
  return { score, reasons };
}
