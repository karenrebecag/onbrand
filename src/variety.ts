// Variedad entre corridas del mismo brief (ronda de marca y semilla de dirección): N generaciones que salen con la
// misma estructura, el mismo acento, la misma tipografía display y las mismas cifras son una sola página repetida.
// Decide sobre la medida del navegador (page-sensors.browser.js), así que se corre igual sobre v0, Stitch y Figma.
// Calibrado: el agente (cc7b8016, c9c5a540, 3c12e988, 97fd95dc, 999ea0e0) converge en los cuatro ejes; v0, Stitch y
// Figma Make sobre el mismo brief no convergen entre sí en ninguno.

import type { Owner, PageMeasure } from './page-sensors';
import { OTHER, roleOfKey } from './plan-sensors';
import { visualKinds } from './richness';
import { TYPICAL_FIGURES } from './directions';

export type VarietyField = 'variety.structure' | 'variety.color' | 'variety.type' | 'variety.figures' | 'variety.typical';

export interface RunSignature {
  run: string;
  /** `rol:focales` por sección de contenido, en orden; sin las secciones de rol desconocido. */
  structure: string[];
  accent: number[] | null;
  /** La familia display: la menos usada de las dos más usadas (el cuerpo pinta más texto que los titulares). */
  display: string | null;
  figures: string[];
}

export interface VarietyDefect { field: VarietyField; owner: Owner; section: string; expected: string; actual: string; message: string }

export interface VarietyReport {
  pairs: number;
  converged: Record<VarietyField, number>;
  defects: VarietyDefect[];
}

// Misma secuencia de rol y foco en 4 de cada 5 secciones.
const STRUCTURE_SIMILAR = 0.8;
// 3c12e988 resuelve rgb(11,93,87) y 999ea0e0 rgb(15,107,92): el mismo verde con otro redondeo de la identidad.
const ACCENT_SAME = 24;
// Una cifra compartida puede ser casualidad ("$149"); dos ya son el mismo caso de éxito.
const FIGURES_SAME = 2;
const FIGURE_RE = /(?:[$€]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|x\b|\+|h\b|min\b|s\b))/gi;

const normFigure = (f: string): string => f.replace(/\s/g, '').replace(',', '.').toLowerCase();
// Las cifras de plantilla que direction.md prohíbe: aparecen en corridas distintas sin que ningún par converja.
const TYPICAL = new Set(TYPICAL_FIGURES.map(normFigure));
const rgb = (c: string): number[] => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);

function sectionRole(key: string, role: string): string {
  const byKey = roleOfKey(key);
  return byKey !== OTHER ? byKey : roleOfKey(`00-${role}`);
}

export function runSignature(run: string, m: PageMeasure): RunSignature {
  const structure = m.sections.filter((s) => !s.frame).flatMap((s) => {
    const role = sectionRole(s.key, s.role);
    return role === OTHER ? [] : [`${role}:${visualKinds(s.visuals).sort().join('+')}`];
  });
  const top = m.fonts.filter((f) => !f.generic && f.count > 0).sort((a, b) => b.count - a.count).slice(0, 2);
  const display = top.length ? top[top.length - 1]!.family.replace(/ Variable$/, '') : null;
  const figures = [...new Set(m.sections.flatMap((s) => [...s.text.matchAll(FIGURE_RE)].map((x) => normFigure(x[0]))))];
  return { run, structure, accent: m.accent?.rgb ? rgb(m.accent.rgb) : null, display, figures };
}

function lcs(a: readonly string[], b: readonly string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = x === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!);
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Lo que dos corridas comparten en cada eje, o null si en ese eje son distintas (o no se puede afirmar). */
// variety.typical no sale de comparar dos corridas: se mide aparte contra el típico del rol.
function shared(a: RunSignature, b: RunSignature): Record<Exclude<VarietyField, 'variety.typical'>, string | null> {
  const len = Math.max(a.structure.length, b.structure.length);
  const sim = len ? lcs(a.structure, b.structure) / len : 0;
  const accent = a.accent && b.accent && Math.max(...a.accent.map((v, i) => Math.abs(v - b.accent![i]!))) <= ACCENT_SAME;
  const figures = a.figures.filter((f) => b.figures.includes(f));
  return {
    'variety.structure': sim >= STRUCTURE_SIMILAR ? `${Math.round(sim * 100)} % de rol y foco en el mismo orden` : null,
    'variety.color': accent ? `acento rgb(${a.accent!.join(', ')}) ~ rgb(${b.accent!.join(', ')})` : null,
    'variety.type': a.display && a.display === b.display ? a.display : null,
    'variety.figures': figures.length >= FIGURES_SAME ? figures.join(' ') : null,
  };
}

/** Un defecto por par de corridas y eje en que convergen. Con menos de dos corridas no hay nada que afirmar. */
export function varietySensors(sigs: readonly RunSignature[]): VarietyReport {
  const converged: Record<VarietyField, number> = { 'variety.structure': 0, 'variety.color': 0, 'variety.type': 0, 'variety.figures': 0, 'variety.typical': 0 };
  const defects: VarietyDefect[] = [];
  let pairs = 0;
  sigs.forEach((a, i) => sigs.slice(i + 1).forEach((b) => {
    pairs += 1;
    for (const [field, what] of Object.entries(shared(a, b)) as [VarietyField, string | null][]) {
      if (!what) continue;
      converged[field] += 1;
      defects.push({ field, owner: 'A', section: `${a.run}~${b.run}`, expected: 'otra dirección', actual: what, message: `${a.run} y ${b.run} repiten ${what}` });
    }
  }));
  // Por corrida, no por par: una sola corrida con "38 %" ya repite la plantilla.
  for (const s of sigs) {
    const typical = s.figures.filter((f) => TYPICAL.has(f.replace(/^\+/, '')));
    if (!typical.length) continue;
    converged['variety.typical'] += 1;
    defects.push({ field: 'variety.typical', owner: 'A', section: s.run, expected: 'cifras propias del sector', actual: typical.join(' '), message: `${s.run} usa cifras de plantilla: ${typical.join(' ')}` });
  }
  return { pairs, converged, defects };
}
