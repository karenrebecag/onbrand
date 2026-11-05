// Métricas del experimento "guía de layout sí/no" (RE-relume-en-registry §5b, diseño de QA):
// N corridas por negocio y condición sobre el mismo rol; se mide (1) átomos distintos por sección,
// (2) distancia estructural entre árboles de layout, comparando la distancia ENTRE negocios contra
// la distancia DENTRO del mismo negocio (ruido de repetición: la guía da variedad solo si la primera
// supera claramente a la segunda), (3) render-gate ok. Puro: recibe los árboles ya emitidos.

type Node = Record<string, unknown>;

const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

function children(n: Node): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(n.children)) out.push(...n.children);
  if (isObj(n.props)) for (const v of Object.values(n.props)) if (isObj(v) && '$slot' in v) out.push(...(Array.isArray(v.$slot) ? v.$slot : [v.$slot]));
  return out;
}

/** Slugs de componente distintos de una sección (los iconos `icon:` no cuentan como átomo). */
export function atomsOf(section: unknown): string[] {
  const seen = new Set<string>();
  const walk = (n: unknown): void => {
    if (!isObj(n)) return;
    if (typeof n.component === 'string' && !n.component.startsWith('icon:')) seen.add(n.component);
    children(n).forEach(walk);
  };
  walk(section);
  return [...seen].sort();
}

/** Nombres de icono (`icon:<set>/<Nombre>`) de una sección, en orden de aparición. */
export function iconsOf(section: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!isObj(n)) return;
    if (typeof n.component === 'string' && n.component.startsWith('icon:')) out.push(n.component);
    children(n).forEach(walk);
  };
  walk(section);
  return out;
}

/** Copia literal de iconos: la salida no trae ningún icono fuera de los que venían en la plantilla.
 * Mide si el modelo eligió iconos por el contenido o calcó el ejemplo (regla 3 de QA, exp2: 5/6). */
export function copiesIcons(section: unknown, injected: unknown): boolean {
  const given = new Set(iconsOf(injected));
  const got = iconsOf(section);
  return got.length > 0 && got.every((i) => given.has(i));
}

/** Esqueleto estructural en pre-orden: tipo de layout con su parámetro de forma, rol de texto y slug.
 * Sin copy ni espaciados: lo que distingue una maquetación de otra. */
export function skeletonOf(section: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown, depth: number): void => {
    if (!isObj(n)) return;
    if (typeof n.layout === 'string') {
      const shape = n.layout === 'grid' ? `cols=${JSON.stringify(n.cols)}` : n.layout === 'split' ? `ratio=${String(n.ratio ?? '1:1')}` : '';
      out.push(`${depth}:${n.layout}${shape ? `[${shape}]` : ''}`);
    } else if (typeof n.text === 'string') out.push(`${depth}:text:${n.text}`);
    else if (typeof n.component === 'string') out.push(`${depth}:${n.component.startsWith('icon:') ? 'icon' : n.component}`);
    else if (Array.isArray(n.children)) out.push(`${depth}:section[${String(n.surface ?? 'base')}]`);
    children(n).forEach((c) => walk(c, depth + 1));
  };
  walk(section, 0);
  return out;
}

/** Distancia de edición normalizada (0 = iguales, 1 = nada en común) entre dos secuencias. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (!a.length && !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

export const treeDistance = (a: unknown, b: unknown): number => editDistance(skeletonOf(a), skeletonOf(b));

export interface Run {
  business: string;
  /** Condición: `noguide`, `guide` (10 patrones), `guide1` (un patrón por brief)... */
  cond: string;
  rep: number;
  section: unknown;
  /** Veredicto del render-gate de esa corrida (undefined = no medido). */
  renderOk?: boolean;
  /** Árbol inyectado como guía en esa corrida (undefined = sin guía o guía de varios patrones). */
  injected?: unknown;
}

/** Umbral de distancia bajo el cual se considera que la corrida emitió el patrón inyectado. */
export const EMITS_PATTERN_MAX = 0.1;

export interface Stat {
  mean: number;
  min: number;
  max: number;
  n: number;
}

export interface ConditionSummary {
  cond: string;
  runs: number;
  atoms: Stat;
  /** Distancia media entre repeticiones del MISMO negocio (ruido). */
  within: Stat;
  /** Distancia media entre árboles de negocios DISTINTOS (variedad). */
  between: Stat;
  /** between / within: > 1 claramente = la guía separa negocios más que el ruido. NaN sin pares. */
  separation: number;
  renderOk: { ok: number; measured: number };
  /** Fidelidad a la guía: distancia media al árbol inyectado y cuántas corridas lo emiten (< EMITS_PATTERN_MAX). */
  fidelity: { mean: number; emits: number; measured: number };
  /** Corridas con guía cuyos iconos son todos los del ejemplo inyectado. */
  iconCopy: { copied: number; measured: number };
}

export function stat(xs: number[]): Stat {
  if (!xs.length) return { mean: NaN, min: NaN, max: NaN, n: 0 };
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

function pairs<T>(xs: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i], xs[j]]);
  return out;
}

export function summarize(runs: Run[]): ConditionSummary[] {
  const conds = [...new Set(runs.map((r) => r.cond))];
  return conds.map((cond) => {
    const rs = runs.filter((r) => r.cond === cond);
    const within = pairs(rs).filter(([a, b]) => a.business === b.business).map(([a, b]) => treeDistance(a.section, b.section));
    const between = pairs(rs).filter(([a, b]) => a.business !== b.business).map(([a, b]) => treeDistance(a.section, b.section));
    const w = stat(within);
    const bt = stat(between);
    const measured = rs.filter((r) => r.renderOk !== undefined);
    return {
      cond,
      runs: rs.length,
      atoms: stat(rs.map((r) => atomsOf(r.section).length)),
      within: w,
      between: bt,
      // Sin ruido (repeticiones idénticas) cualquier diferencia entre negocios es separación total.
      separation: !w.n || !bt.n ? NaN : w.mean === 0 ? (bt.mean > 0 ? Infinity : NaN) : bt.mean / w.mean,
      renderOk: { ok: measured.filter((r) => r.renderOk).length, measured: measured.length },
      fidelity: fidelityOf(rs),
      iconCopy: iconCopyOf(rs),
    };
  });
}

function fidelityOf(rs: Run[]): ConditionSummary['fidelity'] {
  const ds = rs.filter((r) => r.injected !== undefined).map((r) => treeDistance(r.section, r.injected));
  return { mean: stat(ds).mean, emits: ds.filter((d) => d < EMITS_PATTERN_MAX).length, measured: ds.length };
}

function iconCopyOf(rs: Run[]): ConditionSummary['iconCopy'] {
  const guided = rs.filter((r) => r.injected !== undefined && iconsOf(r.injected).length > 0);
  return { copied: guided.filter((r) => copiesIcons(r.section, r.injected)).length, measured: guided.length };
}

const f = (x: number): string => (Number.isNaN(x) ? '-' : x.toFixed(2));

export function renderSummary(rows: ConditionSummary[]): string {
  const head = '| condición | corridas | átomos distintos (media, rango) | distancia dentro del negocio | distancia entre negocios | separación | render ok | emite el patrón (dist. media a la guía) | copia los iconos del ejemplo |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) =>
    `| ${r.cond} | ${r.runs} | ${f(r.atoms.mean)} (${f(r.atoms.min)}-${f(r.atoms.max)}) | ${f(r.within.mean)} (${f(r.within.min)}-${f(r.within.max)}, n=${r.within.n}) | ${f(r.between.mean)} (${f(r.between.min)}-${f(r.between.max)}, n=${r.between.n}) | ${f(r.separation)} | ${r.renderOk.ok}/${r.renderOk.measured} | ${r.fidelity.measured ? `${r.fidelity.emits}/${r.fidelity.measured} (${f(r.fidelity.mean)})` : '-'} | ${r.iconCopy.measured ? `${r.iconCopy.copied}/${r.iconCopy.measured}` : '-'} |`,
  );
  return [head, sep, ...body].join('\n');
}
