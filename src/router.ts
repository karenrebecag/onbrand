// Router determinista (spec catalogo-blob-router RF7-RF10): entre el pool verificado del adaptador y
// selectPage, decide QUÉ candidatos entran por rol leyendo el manifiesto agéntico del índice. Es el
// "filter context" (exclusión por whenNotToUse + shortlist); el ranking fino sigue en selectPage.
// Sin LLM en v1: la intención sale de una tabla por briefIntent y la puntuación de scoreCandidate
// (tags del rol + superficie/tono) más el match de keywords, para que la misma entrada dé siempre la
// misma salida (RNF1).

import type { LibraryAdapter } from './adapters/types';
import type { BrandComposition } from './brand';
import { CANONICAL_COPY, unboundTextProps } from './catalog/eligibility';
import { loadCatalog } from './catalog/load';
import type { CatalogEntry, Manifest } from './catalog/schema';
import { blockSlotModel } from './copygen/slot-model';
import { briefIntent, planFrame, planSections, type BriefIntent } from './plan';
import { scoreCandidate } from './rank';
import { unitsFirst } from './unit';
import type { Brief, Candidate, RhythmProfile, Role, RoleSpec } from './types';

/** Términos fijos por intención (RF10). El LLM, cuando entre, sustituye SOLO esta construcción. */
export const INTENT_TERMS: Record<BriefIntent, readonly string[]> = {
  demo: ['demo', 'product', 'buttons', 'schedule'],
  waitlist: ['waitlist', 'early access', 'email capture', 'signup', 'join'],
};

/** Tamaño de la shortlist por perfil (DA3): 4 = TOP_K de select; banded deja margen a la banda. */
export const SHORTLIST: Record<RhythmProfile, number> = { quiet: 4, neutral: 4, banded: 6 };

const MIN_TOKEN = 4;

/** Peso del match de keywords frente al score estructural de scoreCandidate: una keyword cruzada
 * suma 1, muy por debajo de un tag deseado (2) o la afinidad de superficie (0..3), para desempatar
 * sin dominar el encaje de rol. */
const KEYWORD_WEIGHT = 1;

/** Tope de candidatos por geometría en la shortlist (DA): una landing no se arma de seis bentos.
 * Con el pool chico (verificado) no recorta nada; muerde solo el pool grande de variedad. */
const GEOMETRY_CAP = 2;

/** Slot reservado de marca (ADR 0004): tras el top-K por intención, se RESCATAN hasta R candidatos
 * cuyos tags cruzan los desiredTags de la composition activa, para que lleguen a selectPage aunque
 * su intent-score los cortara. El router NO ordena por marca: solo garantiza inclusión (CA7 se lee
 * ahora como "el router no ORDENA por composition"). Conservador (2) para no diluir la intención. */
const RESERVED_BRAND_SLOTS = 2;

/** Diccionario es->en SOLO de términos de intención/rol (RF10). El brief viene en español y las
 * keywords de las librerías en inglés: sin este puente, keywordMatches no cruza nada y todo el pool
 * puntúa 0. Determinista y sin deps; el LLM, cuando entre, sustituye esta normalización, no la amplía
 * a un traductor general. */
const BILINGUAL: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['waitlist', ['waitlist', 'early access']],
  ['lista', ['waitlist', 'list']],
  ['espera', ['waitlist']],
  ['demo', ['demo']],
  ['agendar', ['schedule', 'book', 'demo']],
  ['producto', ['product']],
  ['beneficios', ['features', 'benefits']],
  ['caracteristicas', ['features']],
  ['funciones', ['features']],
  ['features', ['features']],
  ['precios', ['pricing', 'plans']],
  ['planes', ['pricing', 'plans']],
  ['suscripcion', ['subscription', 'pricing']],
  ['testimonios', ['testimonials', 'reviews']],
  ['resenas', ['testimonials', 'reviews']],
  ['opiniones', ['testimonials', 'reviews']],
  ['clientes', ['customers', 'testimonials']],
  ['metricas', ['stats', 'metrics']],
  ['cifras', ['stats', 'metrics']],
  ['numeros', ['stats', 'metrics']],
  ['resultados', ['stats', 'results']],
  ['preguntas', ['faq', 'questions']],
  ['dudas', ['faq', 'questions']],
  ['pasos', ['steps']],
  ['proceso', ['steps', 'process']],
  ['onboarding', ['steps', 'onboarding']],
  ['logos', ['logos', 'brands']],
  ['marcas', ['logos', 'brands']],
  ['correo', ['email']],
  ['email', ['email', 'email capture']],
  ['contacto', ['contact']],
];

/** minúsculas, sin tildes, solo [a-z0-9] separados por un espacio. */
export const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Traducciones en->? de los términos es presentes en el texto normalizado. */
function bilingualTerms(text: string): string[] {
  const padded = ` ${text} `;
  const out: string[] = [];
  for (const [es, en] of BILINGUAL) if (padded.includes(` ${es} `) || text.includes(es)) out.push(...en);
  return out;
}

export interface IntentTerms {
  intent: BriefIntent;
  /** Términos del perfil + tokens (≥4 letras) de summary/goal + traducciones es->en, sin repetir. */
  terms: string[];
  /** Texto normalizado del brief + las traducciones, contra el que se prueban las keywords. */
  text: string;
}

export function intentTerms(brief: Brief): IntentTerms {
  const intent = briefIntent(brief);
  const base = normalize(`${brief.summary} ${brief.goal ?? ''}`);
  const tokens = base.split(' ').filter((t) => t.length >= MIN_TOKEN);
  const translated = bilingualTerms(base);
  // El texto incluye las traducciones para que una keyword inglesa cruce por substring sobre un
  // brief español (p.ej. "features" sobre "caracteristicas").
  const text = [base, ...translated].join(' ');
  return { intent, terms: [...new Set([...INTENT_TERMS[intent], ...tokens, ...translated])], text };
}

/** Una keyword cruza si, normalizada, es substring del brief (ya bilingüe) o coincide con un término
 * del perfil. */
export const keywordMatches = (keyword: string, it: IntentTerms): boolean => {
  const k = normalize(keyword);
  return k.length > 0 && (it.text.includes(k) || INTENT_TERMS[it.intent].includes(k));
};

/** Una regla cruza si algún término de intención aparece como palabra/frase completa en su texto. */
export const ruleMatches = (text: string, it: IntentTerms): boolean => {
  const padded = ` ${normalize(text)} `;
  return it.terms.some((t) => padded.includes(` ${t} `));
};

export interface Excluded {
  slug: string;
  /** Etiqueta legible: `whenNotToUse: <intent> -> <alternative>`. */
  rule: string;
  alternative: string;
  text: string;
}

export interface Shortlisted {
  slug: string;
  score: number;
  /** Keywords del manifiesto que cruzaron el brief (para explicar el score). */
  matched: string[];
}

/** Excluido por binding (spec filtro-elegibilidad-router NC1): props de contenido con default visible
 * que el copy del rol no llena. */
export interface Unbound {
  slug: string;
  props: string[];
}

export interface RoleTrace {
  excluded: Excluded[];
  /** Excluidos por el filtro de elegibilidad (v1: solo bloques Relume genéricos). */
  unbound: Unbound[];
  /** D2: ningún candidato del rol era elegible, así que pasó el pool completo (no se vacía el rol). */
  bindingFallback?: true;
  shortlisted: Shortlisted[];
  /** Rescatados por el slot reservado de marca (ADR 0004): fuera del top-K por intención, incluidos
   * porque sus tags cruzan los desiredTags de la composition. Vacío sin marca o sin cruce. */
  rescued: Shortlisted[];
  /** Fuera de la shortlist, con su score, para poder explicar por qué no entraron. */
  dropped: Shortlisted[];
}

export interface RouteResult {
  candidatesByRole: Record<string, Candidate[]>;
  trace: Record<string, RoleTrace>;
  intent: IntentTerms;
}

export interface RouteOptions {
  shortlist?: number;
  /** Índice de donde salen los manifiestos (tests lo inyectan). */
  catalog?: CatalogEntry[];
  /** Incluye los bloques gate-ok (no solo verified) en el pool a rutear: es lo que da variedad. */
  unverified?: boolean;
  /** El pool es para un slot inner del 2-layer: admite organismos propless (emittable:false),
   * que como showcase self-contained no reciben copy. Nunca para secciones top-level. */
  innerSlot?: boolean;
  /** Composición de la marca activa (ADR 0003): el router la lee SOLO para el slot reservado
   * (incluir candidatos marca-deseados), nunca para ordenar la shortlist (ADR 0004 / CA7). */
  composition?: BrandComposition;
  /** Tags de forma por rol derivados del contenido (puente contenido->forma). Se suman a los
   * deseados del spec, así la shortlist ya mira la forma. No es composition: no toca CA7. */
  formByRole?: Record<string, string[]>;
}

/** Calidad de un item para desempatar: verified (render visto) > gate.ok (buildeable) > el resto.
 * Nunca es el criterio principal (ese es el score): rompe empates para no caer solo al slug. */
const qualityRank = (e: CatalogEntry | undefined): number => (e?.verified ? 2 : e?.gate?.ok ? 1 : 0);

/** Manifiestos y entradas por slug sobre TODO el índice (no solo la librería del adaptador): el pool
 * del adaptador mezcla arc con bloques relume hosteados, y filtrar por library dejaba a los relume
 * sin manifiesto -> sin keywords -> score 0. El slug ya es único en el pool. */
const indexBySlug = (catalog: CatalogEntry[]): Map<string, CatalogEntry> =>
  new Map(catalog.map((e) => [e.slug, e]));

/** RF8: excluye solo si una regla cruza Y la alternativa está en el pool del mismo rol. */
function exclusion(c: Candidate, manifest: Manifest | null | undefined, pool: Set<string>, it: IntentTerms): Excluded | undefined {
  for (const r of manifest?.whenNotToUse ?? []) {
    if (r.alternative && r.alternative !== c.slug && pool.has(r.alternative) && ruleMatches(r.text, it)) {
      return { slug: c.slug, rule: `whenNotToUse: ${it.intent} -> ${r.alternative}`, alternative: r.alternative, text: r.text };
    }
  }
  return undefined;
}

interface ScoredCandidate {
  candidate: Candidate;
  entry: Shortlisted;
  quality: number;
}

/** Puntúa un candidato ANTES del corte: encaje estructural de scoreCandidate + match de keywords.
 * Antes el corte era por nº de keywords (todo 0 en un brief español) y luego alfabético; ahora el
 * score real decide quién sobrevive al corte, no el orden del slug. */
function scoreForRoute(brief: Brief, spec: RoleSpec, c: Candidate, index: Map<string, CatalogEntry>, it: IntentTerms): ScoredCandidate {
  const matched = (index.get(c.slug)?.manifest?.keywords ?? []).filter((k) => keywordMatches(k, it));
  const score = scoreCandidate(brief, spec, c).score + KEYWORD_WEIGHT * matched.length;
  return { candidate: c, entry: { slug: c.slug, score, matched }, quality: qualityRank(index.get(c.slug)) };
}

/** Orden del corte: score desc, luego calidad desc, luego slug asc (nunca solo por slug). */
const byScoreThenQuality = (a: ScoredCandidate, b: ScoredCandidate): number =>
  b.entry.score - a.entry.score || b.quality - a.quality || a.entry.slug.localeCompare(b.entry.slug);

/** Shortlist con diversidad de geometría: se toman los mejores respetando el tope por geometría; si
 * así no se llena la shortlist, se completa con los que el tope dejó fuera (sin rebajar el tamaño). */
function diversify(scored: ScoredCandidate[], shortlist: number): { picked: ScoredCandidate[]; dropped: ScoredCandidate[] } {
  const picked: ScoredCandidate[] = [];
  const held: ScoredCandidate[] = [];
  const perGeom = new Map<string, number>();
  for (const s of scored) {
    const n = perGeom.get(s.candidate.geometry) ?? 0;
    if (picked.length < shortlist && n < GEOMETRY_CAP) {
      picked.push(s);
      perGeom.set(s.candidate.geometry, n + 1);
    } else {
      held.push(s);
    }
  }
  const fill = shortlist - picked.length;
  return { picked: fill > 0 ? [...picked, ...held.slice(0, fill)] : picked, dropped: fill > 0 ? held.slice(fill) : held };
}

/** Un candidato es marca-deseado si alguno de sus tags cruza los desiredTags (misma normalización
 * que scoreCandidate: trim+lowercase). No ordena: solo decide quién es elegible para el rescate. */
function brandDesired(c: Candidate, desired: Set<string>): boolean {
  if (desired.size === 0) return false;
  return c.tags.some((t) => desired.has(t.trim().toLowerCase()));
}

/** v1 del filtro de elegibilidad (C1): solo bloques Relume genéricos, los que injectCopy llena desde su
 * manifest. Los curados (relumeProps) son todos verified; los Arc nativos van por injectBySchema. */
const isGenericRelume = (e: CatalogEntry | undefined): e is CatalogEntry =>
  e !== undefined && e.library === 'relume' && e.kind !== 'layout' && e.verified === false;

/** Props de contenido con default visible que la ruta de binding real deja sin llenar con el copy
 * canónico. Vacío = elegible (o sin evidencia: source ilegible, nunca se excluye a ciegas). */
function unboundOf(entry: CatalogEntry, adapter: LibraryAdapter): string[] {
  const bound = new Set(Object.keys(adapter.propsFor(entry.slug, CANONICAL_COPY) ?? {}));
  return unboundTextProps(blockSlotModel(entry), bound);
}

/** Un candidato cuenta como alternativa a uno sin binding si es elegible, no es un layout (el strip
 * excluido volvería como inner del shell por pickInner y la página cambia sin quitar el demo) y no
 * baja de nivel de verificación (cambiar un demo conocido de un verified por el binding no verificado
 * de un gate-ok no quita nada). */
const isAlternativeFor = (unboundEntry: CatalogEntry | undefined, alt: CatalogEntry | undefined): boolean =>
  alt?.kind !== 'layout' && (unboundEntry?.verified !== true || alt?.verified === true);

/** Filtro de elegibilidad (RF4 de #27 + RF5 de slots visibles): excluye los candidatos con props sin
 * binding SOLO si les queda alguna alternativa; si no, se quedan y se anota (D2: nunca se vacía el
 * rol). La fuente de "sin binding" la pone el adaptador (`unboundFor`, política por schema) y, si no
 * opina, la fórmula del core sobre los Defaults de un Relume genérico. */
function eligibility(kept: Candidate[], index: Map<string, CatalogEntry>, adapter: LibraryAdapter): { kept: Candidate[]; unbound: Unbound[]; bindingFallback: boolean } {
  const unbound: Unbound[] = [];
  const eligible: Candidate[] = [];
  const held: Candidate[] = [];
  for (const c of kept) {
    const entry = index.get(c.slug);
    const props = adapter.unboundFor?.(c.slug) ?? (isGenericRelume(entry) ? unboundOf(entry, adapter) : []);
    if (props.length) { unbound.push({ slug: c.slug, props }); held.push(c); }
    else eligible.push(c);
  }
  const excluded = new Set(held.filter((u) => eligible.some((a) => isAlternativeFor(index.get(u.slug), index.get(a.slug)))).map((u) => u.slug));
  const bindingFallback = held.some((u) => !excluded.has(u.slug));
  return { kept: kept.filter((c) => !excluded.has(c.slug)), unbound, bindingFallback };
}

function routeRole(pool: Candidate[], spec: RoleSpec, brief: Brief, index: Map<string, CatalogEntry>, it: IntentTerms, shortlist: number, desiredTags: readonly string[], reserved: number, adapter: LibraryAdapter): { candidates: Candidate[]; trace: RoleTrace } {
  const slugs = new Set(pool.map((c) => c.slug));
  const excluded: Excluded[] = [];
  const afterRules: Candidate[] = [];
  for (const c of pool) {
    const ex = exclusion(c, index.get(c.slug)?.manifest, slugs, it);
    if (ex) excluded.push(ex);
    else afterRules.push(c);
  }
  // Filtro de elegibilidad por props: filter context, antes del score (curate-then-score).
  const { kept, unbound, bindingFallback } = eligibility(afterRules, index, adapter);
  // Organism-first (decisión A): la shortlist se arma solo de unidades Arc cuando el rol tiene
  // alguna; si no, cae al pool Relume plano. Sin esto, un header Relume gana la shortlist por score
  // de intención y el organism-first de eligible ya no tiene al organismo que preferir.
  const base = unitsFirst(kept);
  const scored = base.map((c) => scoreForRoute(brief, spec, c, index, it)).sort(byScoreThenQuality);
  const { picked, dropped } = diversify(scored, shortlist);
  // Slot reservado (ADR 0004): rescata hasta `reserved` descartados marca-deseados, en el orden
  // existente (score desc), para que lleguen a selectPage. No reordena la shortlist por marca.
  const desired = new Set(desiredTags.map((t) => t.trim().toLowerCase()));
  const rescued = reserved > 0 ? dropped.filter((s) => brandDesired(s.candidate, desired)).slice(0, reserved) : [];
  const rescuedSlugs = new Set(rescued.map((s) => s.candidate.slug));
  return {
    candidates: [...picked.map((s) => s.candidate), ...rescued.map((s) => s.candidate)],
    trace: {
      excluded,
      unbound,
      ...(bindingFallback ? { bindingFallback: true as const } : {}),
      shortlisted: picked.map((s) => s.entry),
      rescued: rescued.map((s) => s.entry),
      dropped: dropped.filter((s) => !rescuedSlugs.has(s.candidate.slug)).map((s) => s.entry),
    },
  };
}

/** RF7: pool del adaptador -> exclusión -> shortlist, por cada rol que el plan pide. La salida
 * entra tal cual en selectPage/composePage. */
export function routeCandidates(brief: Brief, adapter: LibraryAdapter, options: RouteOptions = {}): RouteResult {
  const it = intentTerms(brief);
  const shortlist = options.shortlist ?? SHORTLIST[adapter.rhythm];
  const catalog = options.catalog ?? loadCatalog({ requireManifest: false });
  const index = indexBySlug(catalog);
  // Specs por rol (no solo el nombre del rol): scoreCandidate necesita desiredTags/undesiredTags.
  const specByRole = new Map<Role, RoleSpec>();
  // composition NO entra al spec del router (ADR 0004: la marca no puntúa; se rescata en slot
  // reservado más abajo). formByRole SÍ: la forma del contenido es señal de selección, no marca.
  for (const spec of [...planFrame(brief, undefined, options.formByRole), ...planSections(brief, undefined, options.formByRole)]) if (!specByRole.has(spec.role)) specByRole.set(spec.role, spec);
  const roles = [...specByRole.keys()];
  const pools = adapter.candidatesByRole(roles, { unverified: options.unverified, innerSlot: options.innerSlot, ...(brief.showcases ? { showcases: brief.showcases } : {}) });
  const candidatesByRole: Record<string, Candidate[]> = {};
  const trace: Record<string, RoleTrace> = {};
  for (const role of roles) {
    const desiredTags = options.composition?.roles?.[role]?.desiredTags ?? [];
    const reserved = desiredTags.length ? RESERVED_BRAND_SLOTS : 0;
    const routed = routeRole(pools[role] ?? [], specByRole.get(role) as RoleSpec, brief, index, it, shortlist, desiredTags, reserved, adapter);
    candidatesByRole[role] = routed.candidates;
    trace[role] = routed.trace;
  }
  return { candidatesByRole, trace, intent: it };
}

/** Cuántos excluidos por binding se listan en el report; el resto va como conteo (flow.json los lleva todos). */
const UNBOUND_SHOWN = 6;

function unboundLine(role: string, t: RoleTrace): string {
  const shown = t.unbound.slice(0, UNBOUND_SHOWN).map((u) => `${u.slug}[${u.props.join(',')}]`).join(', ');
  const rest = t.unbound.length - UNBOUND_SHOWN;
  const tail = t.bindingFallback ? '; sin alternativa elegible, pasa el pool completo' : '';
  return `router: ${role} -> sin binding ${shown}${rest > 0 ? ` (+${rest} más)` : ''}${tail}`;
}

/** Líneas del trace para el runner (RF11): una por exclusión, una por binding, y una por rol con descartes. */
export function traceLines(trace: Record<string, RoleTrace>): string[] {
  return Object.entries(trace).flatMap(([role, t]) => [
    ...t.excluded.map((e) => `router: ${role} -> excluido ${e.slug} (${e.rule})`),
    ...(t.unbound.length ? [unboundLine(role, t)] : []),
    ...(t.rescued.length
      ? [`router: ${role} -> rescate marca ${t.rescued.map((r) => `${r.slug}=${r.score}`).join(', ')}`]
      : []),
    ...(t.dropped.length
      ? [`router: ${role} -> shortlist ${t.shortlisted.map((s) => `${s.slug}=${s.score}`).join(', ')}; fuera ${t.dropped.map((d) => `${d.slug}=${d.score}`).join(', ')}`]
      : []),
  ]);
}
