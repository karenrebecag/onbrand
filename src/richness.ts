// Riqueza por forma (Q3, re-comparativa/QA.md): cuánto trae cada sección además de texto, contado por lo que se ve
// y no por atributos. La medición vive en scripts/page-sensors.browser.js (visualsOf); aquí solo se decide qué
// cuenta como sección con visual. No es un gate: es el puntaje que el banco (Q5) compara entre fixes y herramientas.

import type { PageMeasure } from './page-sensors';

export interface SectionVisuals {
  photos: number;
  /** Chat del producto: 3 burbujas apiladas con dos bordes distintos. */
  mockups: number;
  /** Iconos de 16 a 64 px junto a texto. */
  icons: number;
  /** Marcadores de secuencia ("01", "Paso 2"); 0 si son menos de 3. */
  steps: number;
  /** Hojas con dígito al doble del cuerpo o más. */
  figures: number;
  interactive: number;
}

export type VisualKind = 'photo' | 'mockup' | 'iconography' | 'steps' | 'figures';

// Un icono suelto o una cifra sola (el precio de un plan) no hacen una sección visual; una fila de tres sí.
const MIN_ICONS = 3;
const MIN_FIGURES = 2;

export function visualKinds(v: SectionVisuals | undefined): VisualKind[] {
  if (!v) return [];
  const out: VisualKind[] = [];
  if (v.photos > 0) out.push('photo');
  if (v.mockups > 0) out.push('mockup');
  if (v.icons >= MIN_ICONS) out.push('iconography');
  if (v.steps > 0) out.push('steps');
  if (v.figures >= MIN_FIGURES) out.push('figures');
  return out;
}

export interface Richness {
  sections: number;
  withVisual: number;
  interactive: number;
  bySection: { key: string; kinds: VisualKind[] }[];
}

/** El marco (navbar, footer) no cuenta: sus iconos sociales no son riqueza de contenido. */
export function richness(m: PageMeasure): Richness {
  const content = m.sections.filter((s) => !s.frame);
  const bySection = content.map((s) => ({ key: s.key, kinds: visualKinds(s.visuals) }));
  return {
    sections: content.length,
    withVisual: bySection.filter((s) => s.kinds.length > 0).length,
    interactive: content.reduce((n, s) => n + (s.visuals?.interactive ?? 0), 0),
    bySection,
  };
}
