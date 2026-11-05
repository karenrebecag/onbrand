// Revisión de render (RE-verificacion-visual §4, aprobado por QA 2026-10-22): lo que v0 mira después
// de escribir, en versión de regla y sin LLM. Nuestro motor no escribe CSS ni interacción, así que la
// superficie de defecto es componente del DS × contenido real × viewport: desborde horizontal, errores
// de página y controles que no cambian de estado. Aquí solo se decide qué es defecto; la medición en
// navegador vive en scripts/render-gate.ts (--review), para probar esto sin chromium.

import { slugOfSource } from './runtime-sensors';

export const REVIEW_VIEWPORTS = [1440, 375] as const;
/** Los marcos del lienzo del builder (`artboard-canvas.tsx`): lo que la persona mira. El agente verifica a 1440 y 375;
 * el preview-check, sin modelo, mide también a estos anchos para que un layout roto entre ambos no pase (Q6b). */
export const CANVAS_VIEWPORTS = [1280, 390] as const;
export const PREVIEW_CHECK_VIEWPORTS = [...REVIEW_VIEWPORTS, ...CANVAS_VIEWPORTS] as const;
/** Anchos que mide el preview-check: los fijos más el de la persona (Q6) si no coincide con uno; sin repetir ninguno (un 1280 de la
 * persona sobre el marco de 1280 mediría dos veces la misma página). */
export const previewCheckWidths = (person?: number): number[] => [...new Set<number>([...PREVIEW_CHECK_VIEWPORTS, ...(person !== undefined && Number.isInteger(person) && person > 0 ? [person] : [])])];
/** Medio píxel de redondeo de subpíxel no es un desborde que una persona vea. */
const OVERFLOW_TOLERANCE_PX = 1;

/** Lo que el navegador midió en un viewport. */
export interface ViewportMeasure {
  width: number;
  /** scrollWidth - clientWidth del documento: el scroll horizontal real. */
  pageOverflowPx: number;
  /** Por sección, cuánto pasa del viewport su descendiente más saliente sin un ancestro que lo recorte. */
  sections: { slug: string; role: string; overflowPx: number }[];
  errors: string[];
}

export interface ControlProbe {
  slug: string;
  role: string;
  /** tab, switch o expanded. */
  control: string;
  name: string;
  changed: boolean;
  error?: string;
}

export interface ReviewDefect {
  kind: 'overflow' | 'page-error' | 'control';
  slug: string;
  role: string;
  viewport?: number;
  px?: number;
  message: string;
}

export interface Review {
  viewports: ViewportMeasure[];
  controls: ControlProbe[];
  defects: ReviewDefect[];
  ms: number;
}

// Un 404 de asset ya lo cuenta brokenImages: repetirlo como error de página duplicaría el defecto.
const COVERED = /^Failed to load resource: the server responded with a status of 404/;

/** Defectos de la revisión. El desborde de una sección se acota al scroll real de la página: un hijo
 * que sale 30 px pero solo agrega 26 de scroll es un desborde de 26. */
export function reviewDefects(viewports: readonly ViewportMeasure[], controls: readonly ControlProbe[]): ReviewDefect[] {
  const out: ReviewDefect[] = [];
  for (const v of viewports) {
    for (const s of v.sections) {
      const px = Math.round(Math.min(s.overflowPx, v.pageOverflowPx));
      if (px > OVERFLOW_TOLERANCE_PX) out.push({ kind: 'overflow', slug: s.slug, role: s.role, viewport: v.width, px, message: `a ${v.width} px la sección ${s.role} desborda ${px} px` });
    }
    for (const e of v.errors) {
      if (COVERED.test(e)) continue;
      // El boundary por sección nombra su archivo en el error: así el defecto vuelve a esa sección y no a la página.
      const slug = slugOfSource(e);
      const role = slug ? v.sections.find((x) => x.slug === slug)?.role : undefined;
      out.push({ kind: 'page-error', slug: role && slug ? slug : '-', role: role ?? '-', viewport: v.width, message: e.slice(0, 300) });
    }
  }
  for (const c of controls) {
    if (c.changed && !c.error) continue;
    out.push({ kind: 'control', slug: c.slug, role: c.role, message: c.error ? `${c.control} "${c.name}" falla: ${c.error.slice(0, 200)}` : `${c.control} "${c.name}" no cambia de estado al activarlo` });
  }
  return out;
}
