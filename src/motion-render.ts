// Render-gate de motion, parte pura: decide con lo que el navegador midió de un módulo (scripts/
// motion-render-gate.ts). El gate estático no ve lo que pasa al animar; esto sí: contenido que se ve
// antes de su entrada y luego salta atrás, contenido que no termina visible, y residuo tras el cleanup.

/** Estado visual de un nodo en un instante. */
export interface NodeState { opacity: number; transform: string; visible: boolean }

export interface MotionRun {
  /** Nodos de contenido dentro de las raíces, mismo orden en cada instante. */
  t0: NodeState[];
  mid: NodeState[];
  end: NodeState[];
  /** outerHTML de las raíces antes de init y después del cleanup. */
  before: string;
  afterCleanup: string;
  /** Igual que before/afterCleanup, tras resize + ScrollTrigger.refresh. */
  afterResizeCleanup: string;
  /** Con prefers-reduced-motion: el DOM tras init. */
  reducedHtml: string;
  /** Lo que se ve de las raíces sin el módulo (baseline), lo mejor que se vio con el módulo en las posiciones
   * muestreadas, y con reduced-motion. */
  shown: { baseline: Shown; best: Shown; reduced: Shown };
  errors: string[];
}

/** Texto y medios visibles de las raíces. Relativo al baseline: opacidad del autor, imágenes rotas del ejemplo o
 * líneas SVG de alto 0 no son del módulo. */
export interface Shown { chars: number; media: number }

const lessThan = (a: Shown, b: Shown): boolean => a.chars < b.chars || a.media < b.media;

export type RenderRule = 'flash' | 'not-visible' | 'residue' | 'residue-resize' | 'reduced-touched' | 'reduced-hidden' | 'error' | 'no-roots';

export interface RenderFailure { rule: RenderRule; detail: string }
export interface RenderVerdict { pass: boolean; failures: RenderFailure[] }

/** Un nodo que en t0 ya se veía como al final y a mitad de la entrada se ve menos: apareció antes de su
 * entrada y saltó atrás (stagger + invalidateOnRefresh). Solo opacidad: moverse con el scroll (parallax,
 * velocity) es el efecto, no un salto. */
export function flashes(run: Pick<MotionRun, 't0' | 'mid' | 'end'>): number[] {
  return run.t0.flatMap((s, i) => {
    const end = run.end[i];
    return Math.abs(s.opacity - end.opacity) < 0.01 && run.mid[i].opacity < end.opacity - 0.01 ? [i] : [];
  });
}

/** `style` canónico: el navegador reescribe "padding:40px" como "padding: 40px;" al tocar otra propiedad. */
const canonicalStyle = (css: string): string =>
  css.split(';').map((d) => d.trim().replace(/\s*:\s*/, ':')).filter(Boolean).sort().join(';');

/** Compara DOM sin el ruido que no es residuo: espacios y la serialización del atributo style. */
export const normalizeHtml = (html: string): string =>
  html.replace(/\s+/g, ' ').replace(/ style="([^"]*)"/g, (_, css: string) => (canonicalStyle(css) ? ` style="${canonicalStyle(css)}"` : '')).trim();

export function renderVerdict(run: MotionRun): RenderVerdict {
  const failures: RenderFailure[] = run.errors.map((e) => ({ rule: 'error' as const, detail: e }));
  if (!run.t0.length) failures.push({ rule: 'no-roots', detail: 'el markup no tiene nodos de contenido bajo la raíz' });
  const flash = flashes(run);
  if (flash.length) failures.push({ rule: 'flash', detail: `${flash.length} nodo(s) visibles antes de su entrada: ${flash.slice(0, 5).join(', ')}` });
  const { baseline, best, reduced } = run.shown;
  if (lessThan(best, baseline)) failures.push({ rule: 'not-visible', detail: `nunca se ve lo que se ve sin el módulo: ${best.chars}/${baseline.chars} caracteres, ${best.media}/${baseline.media} medios` });
  const before = normalizeHtml(run.before);
  if (normalizeHtml(run.afterCleanup) !== before) failures.push({ rule: 'residue', detail: firstDiff(before, normalizeHtml(run.afterCleanup)) });
  if (normalizeHtml(run.afterResizeCleanup) !== before) failures.push({ rule: 'residue-resize', detail: firstDiff(before, normalizeHtml(run.afterResizeCleanup)) });
  if (normalizeHtml(run.reducedHtml) !== before) failures.push({ rule: 'reduced-touched', detail: firstDiff(before, normalizeHtml(run.reducedHtml)) });
  if (lessThan(reduced, baseline)) failures.push({ rule: 'reduced-hidden', detail: `con reduced-motion se ve menos: ${reduced.chars}/${baseline.chars} caracteres, ${reduced.media}/${baseline.media} medios` });
  return { pass: failures.length === 0, failures };
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `difiere en ${i}: «${a.slice(Math.max(0, i - 30), i + 50)}» vs «${b.slice(Math.max(0, i - 30), i + 50)}»`;
}

/** Resultado del render-gate por item publicado, en catalog/gates/render.json. El registry lo publica como
 * allow.gates.renderGate solo si `sha` coincide con la fuente actual del item; si no, 'none'. */
export interface GateRecord { sha: string; result: 'ok' | 'fail'; at: string }

/** Lo corrido reemplaza su entrada y lo demás queda: correr un slug no borra el resultado de otro. Claves
 * ordenadas para que el diff del archivo committeado sea solo lo que cambió. */
export function mergeGateRecords(existing: Record<string, GateRecord>, ran: Record<string, GateRecord>): Record<string, GateRecord> {
  const merged = { ...existing, ...ran };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}
