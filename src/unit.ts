// Decisión A (Arc es la unidad): qué candidato es "unidad de página". Un organismo Arc, o un shell
// (kind layout) que lo envuelve vía el 2-capas, es la unidad; un bloque Relume plano solo entra como
// FALLBACK cuando el rol no tiene ninguna de esas dos cosas. Predicado puro compartido por el router
// (shortlist) y select (eligible), para que la regla sea una sola en los dos puntos de corte.

import type { Candidate } from './types';

/** true si el candidato es una unidad de página (organismo Arc o shell que envuelve uno). Candidatos
 * sin `library` (hechos a mano en tests) cuentan como unidad, para no alterarlos. */
export const isUnit = (c: Candidate): boolean => c.library !== 'relume' || c.kind === 'layout';

/** Organism-first: el subconjunto de unidades del pool, o el pool entero si no hay ninguna (fallback
 * al Relume plano). No reordena: solo recorta. */
export function unitsFirst(pool: Candidate[]): Candidate[] {
  const units = pool.filter(isUnit);
  return units.length ? units : pool;
}
