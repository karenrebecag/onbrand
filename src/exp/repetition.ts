// Métrica de repetición entre secciones de una misma página (DIAGNOSTICO-calidad-v0 §1: "copy
// repetido en 5 secciones, 5 titulares que dicen lo mismo"). Para el experimento two-step + PLAN_BLOCK
// (objective/avoid por sección) vs two-step solo. Puro: recibe la página ya emitida.

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Textos de una sección: nodos `text` (value) y strings de props de componentes, recursivo por slots. */
export function textsOf(section: unknown): { titles: string[]; all: string[] } {
  const titles: string[] = [];
  const all: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObj(n)) return;
    if (typeof n.text === 'string' && typeof n.value === 'string') {
      all.push(n.value);
      if (n.text === 'title') titles.push(n.value);
    }
    if (isObj(n.props)) {
      for (const [k, v] of Object.entries(n.props)) {
        if (typeof v === 'string' && v.trim()) {
          all.push(v);
          if (k === 'title' || k === 'heading') titles.push(v);
        } else walk(v);
      }
    }
    if (Array.isArray(n.children)) walk(n.children);
    if (isObj(n.$slot) || Array.isArray(n.$slot)) walk(n.$slot);
  };
  walk(section);
  return { titles, all };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string): string[] => norm(s).split(' ').filter((w) => w.length > 2);

/** n-gramas de palabras de un texto. */
export function ngrams(s: string, n = 4): Set<string> {
  const ws = words(s);
  const out = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) out.add(ws.slice(i, i + n).join(' '));
  return out;
}

export interface Repetition {
  sections: number;
  /** Titulares (normalizados) que aparecen en más de una sección. */
  duplicateTitles: string[];
  /** Pares de secciones que comparten al menos un 4-grama, sobre el total de pares. */
  overlappingPairs: number;
  pairs: number;
  /** 4-gramas distintos compartidos entre secciones distintas. */
  sharedNgrams: string[];
}

/** Repetición entre secciones: titulares duplicados y 4-gramas compartidos entre secciones distintas. */
export function repetitionOf(sections: unknown[]): Repetition {
  const per = sections.map((s) => textsOf(s));
  const titleSections = new Map<string, number>();
  per.forEach((t) => {
    for (const title of new Set(t.titles.map(norm))) titleSections.set(title, (titleSections.get(title) ?? 0) + 1);
  });
  const grams = per.map((t) => {
    const g = new Set<string>();
    for (const text of t.all) for (const x of ngrams(text)) g.add(x);
    return g;
  });
  const shared = new Set<string>();
  let overlappingPairs = 0;
  let pairs = 0;
  for (let i = 0; i < grams.length; i++) {
    for (let j = i + 1; j < grams.length; j++) {
      pairs++;
      let hit = false;
      for (const g of grams[i]) if (grams[j].has(g)) { shared.add(g); hit = true; }
      if (hit) overlappingPairs++;
    }
  }
  return {
    sections: sections.length,
    duplicateTitles: [...titleSections.entries()].filter(([, n]) => n > 1).map(([t]) => t).sort(),
    overlappingPairs,
    pairs,
    sharedNgrams: [...shared].sort(),
  };
}
