// Sensores del plan (P0 del reparto 2026-10-23, qa-atomchat/DIAG-misma-pagina-QA.md): afirman que las secciones
// de la página salen del brief y que dos briefs distintos no dan la misma página. Deciden sobre la medida del
// navegador (las keys de sección y sus colecciones, de page-sensors.browser.js), así que se corren igual sobre
// nuestro dist y sobre el preview de v0. Calibración: 0 en v0 j049, Café Lumbre y atomchat.

import type { MeasuredSection, Owner, PageMeasure } from './page-sensors';
import { roleOfSlug } from './section-slug';

/** Vocabulario de roles: cómo se nombra cada sección en un brief (en/es/pt) o en un slug. Sin acentos y en
 * minúsculas, igual que `fold`. `logos` va en plural a propósito: "un logo en el header" no pide la sección. */
const ROLE_WORDS: Record<string, readonly string[]> = {
  // Un follow-up nombra el hero por su título ("cambia el título principal"), como lo lee v0.
  hero: ['hero', 'titulo principal', 'encabezado principal', 'titulo de la pagina', 'headline', 'main title', 'main heading', 'h1'],
  logos: ['logos', 'logo cloud', 'logo wall', 'trusted by'],
  features: ['features', 'feature', 'beneficios', 'benefits', 'caracteristicas', 'funcionalidades', 'ventajas', 'recursos'],
  stats: ['stats', 'statistics', 'metrics', 'metricas', 'cifras', 'estadisticas', 'by the numbers', 'numeros'],
  steps: ['how it works', 'como funciona', 'steps', 'pasos', 'proceso', 'process'],
  testimonials: ['testimonials', 'testimonial', 'testimonios', 'reviews', 'resenas', 'customers', 'depoimentos'],
  // Casos de éxito con métricas (empresa, rubro, métricas, cita) son un rol propio, como en el plan de orq (ADR 0010).
  cases: ['casos de exito', 'casos', 'case studies', 'success stories', 'casos de sucesso'],
  pricing: ['pricing', 'prices', 'precios', 'planes', 'plans', 'precos'],
  faq: ['faq', 'faqs', 'preguntas frecuentes', 'frequently asked', 'perguntas frequentes'],
  cta: ['cta', 'call to action', 'llamada a la accion', 'pedido', 'pedidos'],
  integrations: ['integrations', 'integraciones', 'integracoes'],
  contact: ['contact', 'contacto', 'contato'],
  team: ['team section', 'equipo', 'nuestro equipo'],
  gallery: ['gallery', 'galeria'],
  blog: ['blog'],
  newsletter: ['newsletter'],
};
const FRAME = new Set(['navbar', 'header', 'footer', 'nav']);
/** Lo que v0 pone sin que el brief lo pida (j049, Lumbre y atomchat traen hero y un cierre). */
const IMPLICIT = new Set(['hero', 'cta']);
export const OTHER = 'other';

export const fold = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[-_]+/g, ' ');
const has = (text: string, word: string): boolean => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text);

/** Roles que el brief nombra. Un brief sin lista ("una landing para X") devuelve un conjunto vacío. */
export function requestedRoles(brief: string): Set<string> {
  const t = fold(brief);
  return new Set(Object.entries(ROLE_WORDS).filter(([, ws]) => ws.some((w) => has(t, w))).map(([r]) => r));
}

/** Rol de una sección por su key (`03-logos`, `05-como-funciona`, `06-section`). Lo que no está en el
 * vocabulario es `other`: un nombre propio de v0 ("nosotros", "section") que no dice qué rol cumple. */
export function roleOfKey(key: string): string {
  const name = fold(roleOfSlug(key));
  if (FRAME.has(name)) return 'frame';
  const hit = Object.entries(ROLE_WORDS).find(([r, ws]) => name === r || ws.some((w) => has(name, w)));
  return hit ? hit[0] : OTHER;
}

export type PlanField = 'plan.roles' | 'variety.sequence' | 'variety.structure';

export interface PlanDefect {
  field: PlanField;
  owner: Owner;
  page: string;
  expected: string;
  actual: string;
  message: string;
}

export interface PlannedPage {
  id: string;
  brief: string;
  measure: PageMeasure;
}

const contentRoles = (m: PageMeasure): string[] => m.sections.map((s) => roleOfKey(s.key)).filter((r) => r !== 'frame');

/** Cada rol pedido está en la página y la página no trae roles de contenido que nadie pidió.
 * HACK: un `other` cubre un rol pedido que falta (v0 nombra "nosotros" a los 3 features de Lumbre y "section" a
 * las cifras de j049): el rol sale del nombre del slug. Pasar al rol medido por contenido cuando haya un
 * clasificador de sección o cuando v0 exponga el rol. */
/** Roles que el brief nombra solo como atributo de otra sección ("casos de éxito con métricas"): la página puede
 * ponerlos aparte (v0 atomchat saca una franja de cifras) o dentro de esa sección (el plan de orq mete las
 * métricas en cases). No faltan ni sobran. */
export function softRoles(brief: string): Set<string> {
  const t = fold(brief);
  const onlyAsAttribute = (w: string): boolean => has(t, w) && !new RegExp(`(^|[^a-z])(?<!(con|with|com) (las |los |the |as |os )?)${w}([^a-z]|$)`).test(t);
  return new Set(Object.entries(ROLE_WORDS).filter(([, ws]) => ws.some(onlyAsAttribute) && !ws.some((w) => has(t, w) && !onlyAsAttribute(w))).map(([r]) => r));
}

// Un brief sin lista ("landing para una taquería") deja elegir al plan: hero, entre 2 y 5 secciones de contenido
// y un cierre (ADR 0010). Calibración: la Lumbre de v0 tenía lista, así que este rango no tiene par en v0 todavía.
const OPEN_MIN = 2;
const OPEN_MAX = 5;

/** Con lista: cada rol pedido está y no hay roles de contenido sin pedir. Sin lista: hay hero y el contenido
 * cabe en el rango del ADR.
 * HACK: un `other` cubre un rol pedido que falta (v0 nombra "nosotros" a los 3 features de Lumbre y "section" a
 * las cifras de j049): el rol sale del nombre del slug. Pasar al rol medido por contenido cuando haya un
 * clasificador de sección o cuando v0 exponga el rol. */
export function planRoles(p: PlannedPage): PlanDefect[] {
  const asked = requestedRoles(p.brief);
  const soft = softRoles(p.brief);
  const hard = [...asked].filter((r) => !soft.has(r));
  const roles = contentRoles(p.measure);
  const out: PlanDefect[] = [];
  const push = (expected: string, actual: string, message: string) => out.push({ field: 'plan.roles', owner: 'A', page: p.id, expected, actual, message });
  if (!hard.length) {
    const content = roles.filter((r) => !IMPLICIT.has(r)).length;
    if (!roles.includes('hero')) push('hero', 'falta', 'el brief no enumera secciones y la página no abre con hero');
    if (content < OPEN_MIN || content > OPEN_MAX) push(`${OPEN_MIN}-${OPEN_MAX} secciones de contenido`, String(content), `el brief no enumera secciones y la página trae ${content} de contenido`);
    return out;
  }
  const others = roles.filter((r) => r === OTHER).length;
  const missing = hard.filter((r) => !roles.includes(r));
  const extra = [...new Set(roles)].filter((r) => r !== OTHER && !asked.has(r) && !IMPLICIT.has(r));
  missing.slice(others).forEach((r) => push(r, 'falta', `el brief pide ${r} y la página no lo trae`));
  extra.forEach((r) => push('solo lo pedido', r, `${r} está en la página y el brief no lo pide`));
  return out;
}

/** Forma de una sección: su rol y las columnas de cada colección (la primera fila); el número de items no
 * cuenta. Es lo que el usuario ve como "la misma página" aunque cambie el texto. */
const shapeOf = (s: MeasuredSection): string => `${roleOfKey(s.key)}|${s.collections.map((c) => c.rows[0]).join(',')}`;

/** Secciones de contenido con la misma forma en el mismo orden, sobre la más larga de las dos. */
export function structureSimilarity(a: PageMeasure, b: PageMeasure): number {
  const sa = a.sections.filter((s) => roleOfKey(s.key) !== 'frame').map(shapeOf);
  const sb = b.sections.filter((s) => roleOfKey(s.key) !== 'frame').map(shapeOf);
  const n = Math.max(sa.length, sb.length);
  if (!n) return 0;
  return sa.filter((s, i) => s === sb[i]).length / n;
}

// v0 entre sus propias páginas no pasa de 0.11 (j049, Lumbre, atomchat); Nimbus y atomchat nuestras, con el mismo
// pin, dan 0.67 (10/11 bloques iguales: la forma medida es más ruidosa que el bloque porque el número de items
// cambia las filas). El umbral queda entre los dos.
export const SIMILARITY_MAX = 0.5;

const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/** Pares de páginas con brief distinto: no pueden tener la misma secuencia de roles si piden secciones
 * distintas, ni la misma estructura visual aunque pidan las mismas. */
export function varietyPairs(pages: readonly PlannedPage[]): PlanDefect[] {
  const out: PlanDefect[] = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const [a, b] = [pages[i], pages[j]];
      if (fold(a.brief).trim() === fold(b.brief).trim()) continue;
      const id = `${a.id}~${b.id}`;
      const [ra, rb] = [contentRoles(a.measure), contentRoles(b.measure)];
      if (!sameSet(requestedRoles(a.brief), requestedRoles(b.brief)) && ra.join('>') === rb.join('>')) {
        out.push({ field: 'variety.sequence', owner: 'A', page: id, expected: 'secuencias distintas', actual: ra.join('>'), message: `${a.id} y ${b.id} piden secciones distintas y salen con la misma secuencia (${ra.length} secciones)` });
      }
      const sim = structureSimilarity(a.measure, b.measure);
      if (sim > SIMILARITY_MAX) {
        out.push({ field: 'variety.structure', owner: 'B', page: id, expected: `≤${SIMILARITY_MAX}`, actual: sim.toFixed(2), message: `${a.id} y ${b.id} tienen brief distinto y ${Math.round(sim * 100)}% de secciones con la misma forma en el mismo orden` });
      }
    }
  }
  return out;
}
