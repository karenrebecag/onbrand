// Prototipo offline del plan de página (DIAGNOSTICO-calidad-v0 §Experimentos 1, brecha núcleo #1):
// una llamada por brief que devuelve, por sección, qué tiene que lograr para ESE negocio. No toca
// compose-layout: aquí solo se mide (a) si el plan separa a dos negocios por sección más allá del ruido
// entre repeticiones y (b) si la intención por sección basta para elegir entre formas del catálogo con
// una regla determinista. Si (a) da, el plan entra al compositor por el mecanismo de LANG_BLOCK (lane
// de [cf7e39]); este módulo entrega el schema, la regla y las métricas.

import type { Pattern } from '../ds-layout-guides';
import { stat, type Stat } from './layout-metrics';


// El schema y el validador del plan viven en src/runtime/page-plan (lo consume el flujo de producción);
// aquí se re-exportan y se añaden las métricas del experimento.
import { type SectionPlan, type PagePlan } from '../runtime/page-plan';
export { PROOFS, DENSITIES, SURFACES, EMPHASES, parsePagePlan, PLAN_SYSTEM, planUserJson } from '../runtime/page-plan';
export type { SectionPlan, PagePlan } from '../runtime/page-plan';

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
const jaccardDistance = (a: Set<string>, b: Set<string>): number => {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return 1 - inter / (a.size + b.size - inter);
};

/** Distancia entre dos planes de sección: media de 6 campos, cada uno en [0,1]. */
export function sectionPlanDistance(a: SectionPlan, b: SectionPlan): number {
  const d = [
    jaccardDistance(tokens(a.objective), tokens(b.objective)),
    jaccardDistance(tokens(a.avoid.join(' ')), tokens(b.avoid.join(' '))),
    a.proof === b.proof ? 0 : 1,
    a.density === b.density ? 0 : 1,
    a.surface === b.surface ? 0 : 1,
    a.emphasis === b.emphasis ? 0 : 1,
  ];
  return d.reduce((x, y) => x + y, 0) / d.length;
}

/** Distancia entre dos planes de página: media sobre los roles que comparten. */
export function pagePlanDistance(a: PagePlan, b: PagePlan): number {
  const byRole = new Map(b.sections.map((s) => [s.role, s]));
  const ds = a.sections.flatMap((s) => (byRole.has(s.role) ? [sectionPlanDistance(s, byRole.get(s.role)!)] : []));
  return ds.length ? ds.reduce((x, y) => x + y, 0) / ds.length : NaN;
}

/** Sólo la parte categórica (sin texto): mide si la forma pedida cambia entre negocios. */
export const sectionShape = (s: SectionPlan): string => [s.proof, s.density, s.surface, s.emphasis].join('|');

export interface PlanRun {
  business: string;
  rep: number;
  plan: PagePlan;
}

export interface PlanRoleSummary {
  role: string;
  within: Stat;
  between: Stat;
  separation: number;
  /** Formas categóricas distintas por negocio: `negocio -> forma mayoritaria`. */
  shapeByBusiness: Record<string, string>;
}

function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

const majority = (xs: string[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
};

const separation = (w: Stat, bt: Stat): number => (!w.n || !bt.n ? NaN : w.mean === 0 ? (bt.mean > 0 ? Infinity : NaN) : bt.mean / w.mean);

/** Por rol: distancia dentro del negocio (ruido) vs entre negocios (señal), y la forma mayoritaria. */
export function summarizePlans(runs: PlanRun[]): PlanRoleSummary[] {
  const roles = [...new Set(runs.flatMap((r) => r.plan.sections.map((s) => s.role)))];
  return roles.map((role) => {
    const rs = runs.flatMap((r) => {
      const s = r.plan.sections.find((x) => x.role === role);
      return s ? [{ business: r.business, s }] : [];
    });
    const within = pairs(rs).filter(([a, b]) => a.business === b.business).map(([a, b]) => sectionPlanDistance(a.s, b.s));
    const between = pairs(rs).filter(([a, b]) => a.business !== b.business).map(([a, b]) => sectionPlanDistance(a.s, b.s));
    const w = stat(within);
    const bt = stat(between);
    const shapeByBusiness: Record<string, string> = {};
    for (const b of new Set(rs.map((x) => x.business))) shapeByBusiness[b] = majority(rs.filter((x) => x.business === b).map((x) => sectionShape(x.s)));
    return { role, within: w, between: bt, separation: separation(w, bt), shapeByBusiness };
  });
}

/** (b) Regla determinista intención → forma: la densidad fija las columnas, la superficie oscura o la
 * prueba 'demo' piden media, el énfasis alto pide cards. Sin modelo: es lo que se cruza con el shortlist. */
export interface IntentForm {
  cols: 2 | 3 | 4;
  media: 'none' | 'image' | 'background';
  cards: boolean;
}

export function formOfIntent(s: SectionPlan): IntentForm {
  return {
    cols: s.density === 'airy' ? 2 : s.density === 'dense' ? 4 : 3,
    media: s.surface === 'inverse' ? 'background' : s.proof === 'demo' ? 'image' : 'none',
    cards: s.emphasis === 'high',
  };
}

/** Patrón del catálogo que mejor casa con la intención: cols+media+cards, luego cols+media, luego cols,
 * luego el más frecuente. Determinista (patterns viene ordenado por frecuencia). */
export function patternForIntent(patterns: Pattern[], s: SectionPlan): Pattern | undefined {
  const f = formOfIntent(s);
  return (
    patterns.find((p) => p.sig.cols === f.cols && p.sig.media === f.media && p.sig.cards === f.cards) ??
    patterns.find((p) => p.sig.cols === f.cols && p.sig.media === f.media) ??
    patterns.find((p) => p.sig.cols === f.cols) ??
    patterns[0]
  );
}

const f2 = (x: number): string => (Number.isNaN(x) ? '-' : x.toFixed(2));

export function renderPlanSummary(rows: PlanRoleSummary[], patternKeys?: Record<string, Record<string, string>>): string {
  const head = '| rol | dist. dentro del negocio | dist. entre negocios | separación | forma mayoritaria por negocio | patrón por negocio (regla) |';
  const sep = '|---|---|---|---|---|---|';
  const body = rows.map((r) => {
    const shapes = Object.entries(r.shapeByBusiness).map(([b, s]) => `${b}: ${s}`).join('<br>');
    const pk = patternKeys?.[r.role] ? Object.entries(patternKeys[r.role]).map(([b, k]) => `${b}: ${k}`).join('<br>') : '-';
    return `| ${r.role} | ${f2(r.within.mean)} (n=${r.within.n}) | ${f2(r.between.mean)} (n=${r.between.n}) | ${f2(r.separation)} | ${shapes} | ${pk} |`;
  });
  return [head, sep, ...body].join('\n');
}
