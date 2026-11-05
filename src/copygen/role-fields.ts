// Campos de texto del copy agnóstico (RoleCopy) por rol: es la lista que el generador llena, campo a
// campo, como los "input text fields" de Relume. Los tamaños de lista (cuántos features, testimonios,
// preguntas) salen del bloque elegido (Defaults) con un rango sano, para que el copy tenga exactamente
// los items que el componente renderiza. Los números de stats y el sufijo de precio no son texto
// libre: se fijan al ensamblar.

import type { RoleCopy } from '../copy';
import type { Role } from '../types';
import type { Semantic } from './slot-model';

export interface RoleField {
  path: string;
  semantic: Semantic;
}

export interface RoleCounts {
  features: number;
  steps: number;
  stats: number;
  testimonials: number;
  faq: number;
  plans: number;
  planFeatures: number;
  navLinks: number;
  footerColumns: number;
  footerLinks: number;
}

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number): number =>
  v === undefined ? dflt : Math.min(hi, Math.max(lo, v));

/** Tamaños desde los conteos del Defaults del bloque (claves Relume) acotados a un rango razonable. */
export function roleCounts(counts: Record<string, number>): RoleCounts {
  return {
    features: clamp(counts.features ?? counts.cards ?? counts.items, 3, 6, 3),
    steps: clamp(counts.sections ?? counts.steps ?? counts.timelineItems, 2, 4, 3),
    stats: clamp(counts.stats, 3, 4, 3),
    testimonials: clamp(counts.testimonials, 1, 3, 3),
    faq: clamp(counts.questions ?? counts.faqs, 3, 6, 4),
    plans: 2,
    planFeatures: 3,
    navLinks: clamp(counts.navLinks, 2, 4, 3),
    footerColumns: clamp(counts.columnLinks, 2, 3, 2),
    footerLinks: clamp(counts.links, 2, 4, 3),
  };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const f = (path: string, semantic: Semantic): RoleField => ({ path, semantic });

/** Campos de texto de un rol, en orden de lectura. */
export function roleFields(role: Role, c: RoleCounts): RoleField[] {
  switch (role) {
    case 'hero':
      return [f('hero.heading', 'heading'), f('hero.description', 'description'), f('hero.primaryCta', 'cta'), f('hero.secondaryCta', 'cta')];
    case 'logos':
      // Las marcas no se redactan: vienen tal cual de brief.brands (generate.ts).
      return [f('logos.heading', 'heading')];
    case 'features':
      return [
        f('features.heading', 'heading'), f('features.description', 'description'),
        ...range(c.features).flatMap((i) => [f(`features.items[${i}].title`, 'heading'), f(`features.items[${i}].description`, 'description')]),
      ];
    case 'steps':
      return [
        f('steps.heading', 'heading'),
        ...range(c.steps).flatMap((i) => [f(`steps.steps[${i}].tagline`, 'tagline'), f(`steps.steps[${i}].title`, 'heading'), f(`steps.steps[${i}].description`, 'description')]),
      ];
    case 'stats':
      return [f('stats.heading', 'heading'), ...range(c.stats).flatMap((i) => [f(`stats.stats[${i}].label`, 'label'), f(`stats.stats[${i}].detail`, 'note')])];
    case 'testimonials':
      return [
        f('testimonials.heading', 'heading'), f('testimonials.description', 'description'),
        ...range(c.testimonials).flatMap((i) => [
          f(`testimonials.items[${i}].quote`, 'quote'), f(`testimonials.items[${i}].name`, 'name'),
          f(`testimonials.items[${i}].role`, 'position'), f(`testimonials.items[${i}].company`, 'company'),
        ]),
      ];
    case 'pricing':
      return [
        f('pricing.tagline', 'tagline'), f('pricing.heading', 'heading'), f('pricing.description', 'description'),
        ...range(c.plans).flatMap((i) => [
          f(`pricing.plans[${i}].name`, 'heading'), f(`pricing.plans[${i}].monthlyPrice`, 'price'), f(`pricing.plans[${i}].yearlyNote`, 'note'),
          ...range(c.planFeatures).map((j) => f(`pricing.plans[${i}].features[${j}]`, 'label')),
          f(`pricing.plans[${i}].cta`, 'cta'),
        ]),
      ];
    case 'faq':
      return [
        f('faq.heading', 'heading'), f('faq.description', 'description'),
        ...range(c.faq).flatMap((i) => [f(`faq.items[${i}].question`, 'question'), f(`faq.items[${i}].answer`, 'answer')]),
        f('faq.contact.heading', 'heading'), f('faq.contact.description', 'description'), f('faq.contact.cta', 'cta'),
      ];
    case 'cta':
    case 'banner':
      return [f('cta.heading', 'heading'), f('cta.description', 'description'), f('cta.primaryCta', 'cta'), f('cta.secondaryCta', 'cta'), f('cta.note', 'note')];
    case 'navbar':
      return [f('navbar.brand', 'brand'), ...range(c.navLinks).map((i) => f(`navbar.links[${i}]`, 'link')), f('navbar.primaryCta', 'cta'), f('navbar.secondaryCta', 'cta')];
    case 'footer':
      return [
        f('footer.brand', 'brand'), f('footer.tagline', 'description'),
        ...range(c.footerColumns).flatMap((i) => [f(`footer.columns[${i}].title`, 'heading'), ...range(c.footerLinks).map((j) => f(`footer.columns[${i}].links[${j}]`, 'link'))]),
        f('footer.legal[0]', 'link'), f('footer.legal[1]', 'link'),
      ];
    default:
      return [];
  }
}

type Tree = Record<string, unknown> | unknown[];

const segments = (path: string): Array<string | number> =>
  path.split('.').flatMap((seg) => {
    const m = seg.match(/^(\w+)\[(\d+)\]$/);
    return m ? [m[1], Number(m[2])] : [seg];
  });

/** Devuelve una copia del árbol con `path` puesto a `value` (nunca muta la entrada). */
export function setPath(tree: Tree, path: string, value: unknown): Tree {
  const segs = segments(path);
  const put = (node: unknown, i: number): unknown => {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (typeof seg === 'number') {
      const arr = Array.isArray(node) ? [...node] : [];
      arr[seg] = last ? value : put(arr[seg], i + 1);
      return arr;
    }
    const obj = node && typeof node === 'object' && !Array.isArray(node) ? { ...(node as Record<string, unknown>) } : {};
    return { ...obj, [seg]: last ? value : put(obj[seg], i + 1) };
  };
  return put(tree, 0) as Tree;
}

export function getPath(tree: unknown, path: string): unknown {
  return segments(path).reduce<unknown>((node, seg) => {
    if (node === null || node === undefined) return undefined;
    if (typeof seg === 'number') return Array.isArray(node) ? node[seg] : undefined;
    return typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined;
  }, tree);
}

// Cifras de muestra para stats: no son texto libre (el LLM no inventa números) y van marcadas como
// hueco en el reporte del runner.
const STAT_NUMBERS: ReadonlyArray<{ value: number; prefix?: string; suffix?: string }> = [
  { value: 24, suffix: '/7' }, { value: 5, suffix: ' min' }, { value: 3, suffix: '×' }, { value: 98, suffix: '%' },
];

/** Ensambla el RoleCopy desde los campos ya escritos: pone los números de stats, el sufijo de precio y
 * elimina los opcionales vacíos (un secondaryCta "" no es un botón). */
export function assembleRoleCopy(texts: ReadonlyArray<{ path: string; text: string }>, lang: 'es' | 'en'): RoleCopy {
  const tree = texts.reduce<Tree>((acc, { path, text }) => (text.trim() ? setPath(acc, path, text.trim()) : acc), {});
  const copy = tree as Record<string, unknown>;
  const stats = getPath(copy, 'stats.stats');
  const withStats = Array.isArray(stats)
    ? setPath(copy, 'stats.stats', stats.map((s, i) => ({ ...STAT_NUMBERS[i % STAT_NUMBERS.length], ...(s as object) })))
    : copy;
  const withPeriod = getPath(withStats, 'pricing') ? setPath(withStats, 'pricing.periodLabel', lang === 'es' ? '/mes' : '/mo') : withStats;
  return withPeriod as RoleCopy;
}
