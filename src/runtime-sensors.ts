// preview.runtime (P2, Secondary + QA): lo que falla al cargar el preview vivo y hoy no llega ni al repair ni al
// builder (vite corre con stdio:'ignore'). Cuenta errores de página, console.error, respuestas ≥400 del mismo
// origen y secciones de page.json que no quedaron montadas: una sección que tira sin boundary desmonta la página
// entera. Calibración: el preview vivo de abbcfe51 da 0 (solo un warning de motion.dev, que no cuenta).

import type { Owner } from './page-sensors';

export type RuntimeKind = 'pageerror' | 'console' | 'request' | 'broken-image' | 'broken-image-external' | 'unmounted' | 'contrast' | 'interaction' | 'overflow' | 'cta-wrap' | 'visual' | 'preserve-files' | 'preserve-text';

/** Lo que recoge el navegador; el contrato del evento preview.issue de Secondary. */
export interface RuntimeIssue {
  kind: Exclude<RuntimeKind, 'unmounted' | 'contrast' | 'interaction' | 'overflow' | 'cta-wrap' | 'visual' | 'preserve-files' | 'preserve-text'>;
  message: string;
  /** Stack o URL de origen, para atribuir la sección. */
  source?: string;
  /** Sección ya resuelta en el navegador (imagen rota: su `[data-wt-slug]`), cuando no sale de una ruta de src/sections. */
  slug?: string | null;
  viewport: number;
}

export interface RuntimeDefect {
  field: 'preview.runtime';
  owner: Owner;
  kind: RuntimeKind;
  /** Sección a la que se atribuye; null si el error no trae una ruta de src/sections. */
  slug: string | null;
  viewport: number;
  message: string;
  /** Texto exacto del nodo con el defecto (contraste): deja ver si el texto lo escribió el agente en su sección o vino de
   * un componente del DS (`src/components/**`). */
  text?: string;
  /** Contraste: razón del peor texto de la sección, para que el aviso del builder la muestre sin volver a medir. */
  ratio?: number;
  /** Contraste: par de colores (hex) del peor texto, para que el aviso muestre texto sobre fondo. */
  colors?: { fg: string; bg: string };
}

/** La sección de un stack de dev: `/src/sections/05-stats.tsx` → `05-stats`. */
export function slugOfSource(source: string | undefined): string | null {
  const m = source ? /\/src\/sections\/(\d+-[\w-]+)\.tsx/.exec(source) : null;
  return m ? m[1] : null;
}

export function runtimeDefects(issues: readonly RuntimeIssue[], expectedSlugs: readonly string[], mounted: ReadonlyMap<number, readonly string[]>): RuntimeDefect[] {
  const seen = new Set<string>();
  const out: RuntimeDefect[] = [];
  for (const i of issues) {
    const slug = i.slug ?? slugOfSource(i.source) ?? slugOfSource(i.message);
    const key = `${i.kind}|${i.message}|${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field: 'preview.runtime', owner: 'L6', kind: i.kind, slug, viewport: i.viewport, message: i.message.slice(0, 300) });
  }
  for (const [viewport, slugs] of mounted) {
    for (const slug of expectedSlugs.filter((s) => !slugs.includes(s))) {
      out.push({ field: 'preview.runtime', owner: 'L6', kind: 'unmounted', slug, viewport, message: `${slug} está en page.json y no quedó montada en el preview` });
    }
  }
  return out;
}
