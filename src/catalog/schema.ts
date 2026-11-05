// Esquema del índice unificado (`catalog/index.json`): una entrada por item de cualquier librería,
// en vocabulario del core. Es el blob que el router consulta (spec catalogo-blob-router, RF1-RF2).
// Falla ruidoso: un índice mal formado no degrada a "sin candidatos" (RNF4).

import { posix } from 'node:path';
import type { Role, Surface, SurfaceByTheme } from '../types';

export type Library = 'arc' | 'relume' | 'morphin' | 'bencho';
/** layout = cáscara con slot `inner` (ADR 0001, RF12): compite en el pool de su rol como cualquiera. */
export type CatalogKind = 'block' | 'component' | 'layout';

/** Estado del porte por item (spec porter-1765 RF12). Se duplica a propósito el union de
 * tools/porter/cache.ts: el core (src/) no puede importar tooling (RF1, frontera CA1), así que el
 * contrato entre ambos son estos literales, no un import compartido. */
export type PortState = 'ported' | 'built' | 'rendered' | 'fidelity-ok' | 'verified-sample' | 'quarantined';
/** Estados cuyo item entra al pool del router sin `verified` (RF12, ADR 0002). */
export const POOL_PORT_STATES: ReadonlySet<PortState> = new Set(['fidelity-ok', 'verified-sample']);

/** Contrato de slot, patrón SlotField de Puck: qué roles admite el inner y cuántos (uno). */
/** Qué aporta un componente a un slot de organismo (spec composicion-slots §3). Vocabulario
 * cerrado: añadir uno es cambiar este union y el overlay, no inventarlo en código. */
export type SlotSemantic = 'metric' | 'series' | 'illustration' | 'media' | 'avatar' | 'logo' | 'icon' | 'badge' | 'action';

export interface CatalogSlots {
  inner: { allow: Role[]; max: 1 };
}

export interface ManifestRule {
  text: string;
  /** Slug del item que la doc nombra como alternativa; ausente si no resuelve (nunca inventado). */
  alternative?: string;
}

export interface ManifestProp {
  name: string;
  type: string;
  default?: string;
  description: string;
}

/** Manifiesto agéntico (molde Arc). Es lo que el router usa para rutear por intención. */
export interface Manifest {
  keywords: string[];
  whenToUse: string[];
  whenNotToUse: ManifestRule[];
  aiNotes: string[];
  /** Vía de inyección del contenido: props reales, un data file del bloque o constantes del archivo. */
  injection: { kind: 'props' | 'data-file' | 'constants'; detail: string };
  related: string[];
  props: ManifestProp[];
}

export interface CatalogOrigin {
  kind: 'vault';
  /** Ruta del archivo principal relativa a la raíz del vault. */
  path: string;
  /** sha256 de ese archivo en el momento del import; fetch lo verifica antes de copiar. */
  sha256: string;
}

/** Slug con el que el porter nombra el artefacto en out/ported/: la carpeta del item en el vault
 * (segmento final del dir de origin.path), NO el slug del catálogo —que es el id del componente
 * (p.ej. catálogo `section_header116` vs vault `header-116`). Sin origin resoluble cae al slug. */
export function vaultSlug(entry: Pick<CatalogEntry, 'slug' | 'origin'>): string {
  const path = entry.origin?.path;
  return path ? posix.basename(posix.dirname(path)) : entry.slug;
}

/** Gate AUTOMÁTICO del ingest sobre el source del vault (existe, exporta, deps resolubles, lint,
 * residuos del transformer). No sustituye a `verified`: ese sigue exigiendo source vendorizado y
 * render visto; `gate.ok` dice que el item está listo para `catalog fetch` + build. */
export interface CatalogGate {
  ok: boolean;
  /** Vacío si ok; si no, cada motivo por el que el item está en la cola de revisión. */
  reasons: string[];
}

/** Cómo pinta un bloque una forma de dirección (FORMS de src/directions.ts); con `variant`, ese valor de prop
 * es un candidato aparte. */
export interface BlockForms {
  forms: string[];
  variant?: { prop: string; value: string };
  /** Lo que el bloque pone al frente. Declarado, solo ocupa filas de la dirección con ese focal; 'ninguno' (un fondo
   * abstracto, un shader) no ocupa ninguna. Sin declarar, cualquiera. */
  focal?: BlockFocal;
  /** Alineación del texto que pinta el bloque; sin declarar, QA la deduce de la forma. */
  align?: 'start' | 'center';
  /** La prop con la colección que cuenta (items, plans, stats): QA cuenta sus elementos en vez de adivinar. */
  itemsProp?: string;
  /** Sectores y tonos para los que el bloque encaja (los de las direcciones). Declarados, solo sale en una dirección que
   * comparte alguno: un hero de portfolio premium no va en un SaaS técnico (corrida c734443f). */
  sectors?: string[];
  tones?: string[];
}

export const BLOCK_FOCALS = ['foto', 'mockup', 'cifra', 'tabla', 'cita', 'iconos', 'acordeón', 'logos', 'acción', 'abstracto', 'ninguno'] as const;
export type BlockFocal = (typeof BLOCK_FOCALS)[number];

export interface CatalogEntry {
  library: Library;
  kind: CatalogKind;
  slug: string;
  name: string;
  /** Ausente en kind component (un átomo no es una sección) y en los bloques de UI de app
   * (category APP_UI): el registry trae el DS entero, como v0, y el selector de landing los filtra
   * por no tener rol. */
  role?: Role;
  category: string;
  tags: string[];
  /** Fijada por una persona al verificar el render; el lint del adaptador la contrasta. */
  surface: SurfaceByTheme;
  geometry: string;
  /** Variante (o layout) que propsFor emite y para la que se clasificó la superficie. */
  variant?: string;
  /** Solo kind layout (obligatorio ahí). */
  slots?: CatalogSlots;
  semantics?: SlotSemantic[];
  /** false = no porta copy del brief; fuera del pool de emisión aunque esté verified. */
  emittable?: boolean;
  verified: boolean;
  /** Source vendorizado, relativo a la raíz del repo; null si todavía no se trajo. */
  source: string | null;
  origin: CatalogOrigin;
  export: string;
  /** El source solo trae `export default`; `export` es el nombre del binding (import-line.ts). */
  exportDefault?: boolean;
  importPath: string;
  /** Slugs de components del índice que el item importa (se traen con él). */
  registryDependencies?: string[];
  manifest: Manifest | null;
  manifestOrigin?: 'parsed' | 'derived';
  /** Solo entradas que pasaron por el ingest automático. */
  gate?: CatalogGate;
  /** Estado del porte en lote (RF11); lo escribe el porter, no el ingest. El pool lo lee (RF12). */
  port?: { state: PortState; reason?: string };
  /** Formas de dirección que el bloque pinta; sin esto ninguna dirección lo elige. */
  candidates?: BlockForms[];
  notes?: string;
}

/** Una sección (block/layout) siempre trae rol; solo un component lo omite. */
/** Categoría de los bloques de producto (auth, settings, billing, shells…): sin rol de landing. */
export const APP_UI = 'app-ui';

export const hasRole = (e: CatalogEntry): e is CatalogEntry & { role: Role } => e.role !== undefined;

export interface ParseOptions {
  /** Desde F2: una entrada verified sin manifiesto es error. */
  requireManifest?: boolean;
}

const LIBRARIES: readonly Library[] = ['arc', 'relume', 'morphin', 'bencho'];
const KINDS: readonly CatalogKind[] = ['block', 'component', 'layout'];
const ROLES: readonly Role[] = [
  'hero', 'features', 'steps', 'cta', 'testimonials', 'pricing', 'faq', 'logos', 'stats',
  'navbar', 'footer', 'banner',
];
export const SEMANTICS: readonly SlotSemantic[] = ['metric', 'series', 'illustration', 'media', 'avatar', 'logo', 'icon', 'badge', 'action'];
const SURFACES: readonly Surface[] = ['base', 'tinted', 'dark', 'media'];
const INJECTIONS = ['props', 'data-file', 'constants'] as const;
const PORT_STATES: readonly PortState[] = ['ported', 'built', 'rendered', 'fidelity-ok', 'verified-sample', 'quarantined'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isSurfaceByTheme = (v: unknown): v is SurfaceByTheme => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return oneOf(SURFACES, o.light) && oneOf(SURFACES, o.dark);
};

/** RF14: una ruta del índice dirige copias de archivos, así que debe quedar DENTRO de su raíz
 * (repo o vault). Absolutas o con `..` que escapen hacen fallar el loader con el slug. */
export function assertInside(rel: string, what: string, slug: string): void {
  const norm = posix.normalize(rel.replace(/\\/g, '/'));
  if (posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`catalog (${slug}): ${what} escapa de su raíz: "${rel}"`);
  }
}

/** slots: obligatorio y bien formado en un layout; prohibido en lo demás (un block no anida). */
function parseSlots(raw: unknown, kind: CatalogKind, fail: (f: string) => never): CatalogSlots | undefined {
  if (kind !== 'layout') {
    if (raw !== undefined) fail('slots (solo kind layout)');
    return undefined;
  }
  const inner = (raw as { inner?: Record<string, unknown> } | undefined)?.inner;
  if (typeof inner !== 'object' || inner === null) return fail('slots.inner');
  if (!Array.isArray(inner.allow) || inner.allow.length === 0 || !inner.allow.every((r) => oneOf(ROLES, r))) fail('slots.inner.allow');
  if (inner.max !== 1) fail('slots.inner.max');
  return { inner: { allow: [...(inner.allow as Role[])], max: 1 } };
}

/** port: opcional; si viene, `state` es un estado válido y `reason` (si existe) un string. */
function parsePort(raw: unknown, fail: (f: string) => never): { state: PortState; reason?: string } | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return fail('port');
  const p = raw as Record<string, unknown>;
  if (!oneOf(PORT_STATES, p.state)) return fail('port.state');
  if (p.reason !== undefined && !isStr(p.reason)) return fail('port.reason');
  return { state: p.state, ...(typeof p.reason === 'string' ? { reason: p.reason } : {}) };
}

/** gate: opcional; si viene, `ok` booleano y `reasons` strings, y un gate ok no lleva motivos. */
function parseGate(raw: unknown, fail: (f: string) => never): CatalogGate | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return fail('gate');
  const g = raw as Record<string, unknown>;
  if (typeof g.ok !== 'boolean' || !isStrArray(g.reasons)) return fail('gate');
  if (g.ok && g.reasons.length > 0) return fail('gate (ok con motivos)');
  return { ok: g.ok, reasons: [...g.reasons] };
}

function parseManifest(raw: unknown, fail: (f: string) => never): Manifest {
  if (typeof raw !== 'object' || raw === null) return fail('manifest');
  const m = raw as Record<string, unknown>;
  if (!isStrArray(m.keywords)) fail('manifest.keywords');
  if (!isStrArray(m.whenToUse)) fail('manifest.whenToUse');
  if (!isStrArray(m.aiNotes)) fail('manifest.aiNotes');
  if (!isStrArray(m.related)) fail('manifest.related');
  if (!Array.isArray(m.whenNotToUse)) fail('manifest.whenNotToUse');
  if (!Array.isArray(m.props)) fail('manifest.props');
  const inj = m.injection as Record<string, unknown> | undefined;
  if (typeof inj !== 'object' || inj === null || !oneOf(INJECTIONS, inj.kind) || typeof inj.detail !== 'string') fail('manifest.injection');
  const whenNotToUse = (m.whenNotToUse as unknown[]).map((r, i) => {
    const o = r as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || !isStr(o.text)) return fail(`manifest.whenNotToUse[${i}]`);
    if (o.alternative !== undefined && !isStr(o.alternative)) fail(`manifest.whenNotToUse[${i}].alternative`);
    return { text: o.text, ...(typeof o.alternative === 'string' ? { alternative: o.alternative } : {}) };
  });
  const props = (m.props as unknown[]).map((p, i) => {
    const o = p as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || !isStr(o.name) || typeof o.type !== 'string' || typeof o.description !== 'string') return fail(`manifest.props[${i}]`);
    if (o.default !== undefined && typeof o.default !== 'string') fail(`manifest.props[${i}].default`);
    return { name: o.name, type: o.type, ...(typeof o.default === 'string' ? { default: o.default } : {}), description: o.description };
  });
  return {
    keywords: m.keywords as string[],
    whenToUse: m.whenToUse as string[],
    whenNotToUse,
    aiNotes: m.aiNotes as string[],
    injection: { kind: inj.kind as Manifest['injection']['kind'], detail: inj.detail as string },
    related: m.related as string[],
    props,
  };
}

/** Narrowing de una entrada cruda. Las claves de salida van en el orden canónico del índice. */
export function parseCatalogEntry(raw: unknown, i: number, opts: ParseOptions = {}): CatalogEntry {
  if (typeof raw !== 'object' || raw === null) throw new Error(`catalog[${i}]: no es un objeto`);
  const r = raw as Record<string, unknown>;
  const fail = (f: string): never => {
    throw new Error(`catalog[${i}] (${String(r.slug ?? '?')}): campo inválido "${f}"`);
  };
  if (!oneOf(LIBRARIES, r.library)) fail('library');
  if (!oneOf(KINDS, r.kind)) fail('kind');
  if (!isStr(r.slug)) fail('slug');
  if (!isStr(r.name)) fail('name');
  const roleOptional = r.kind === 'component' || (r.kind === 'block' && r.category === APP_UI);
  if (roleOptional ? r.role !== undefined && !oneOf(ROLES, r.role) : !oneOf(ROLES, r.role)) fail('role');
  if (r.semantics !== undefined && !(Array.isArray(r.semantics) && r.semantics.length > 0 && r.semantics.every((x) => oneOf(SEMANTICS, x)))) fail('semantics');
  if (!isStr(r.category)) fail('category');
  if (!isStrArray(r.tags)) fail('tags');
  if (!isSurfaceByTheme(r.surface)) fail('surface');
  if (!isStr(r.geometry)) fail('geometry');
  if (r.variant !== undefined && !isStr(r.variant)) fail('variant');
  if (r.emittable !== undefined && typeof r.emittable !== 'boolean') fail('emittable');
  if (typeof r.verified !== 'boolean') fail('verified');
  if (r.source !== null && !isStr(r.source)) fail('source');
  if (r.verified === true && r.source === null) fail('source (verified exige source)');
  const rawOrigin = r.origin as Record<string, unknown> | undefined;
  if (typeof rawOrigin !== 'object' || rawOrigin === null || rawOrigin.kind !== 'vault' || !isStr(rawOrigin.path) || !/^[0-9a-f]{64}$/.test(String(rawOrigin.sha256))) fail('origin');
  // fail() devuelve never pero no estrecha: el local tipado repite lo ya validado.
  const origin: CatalogOrigin = { kind: 'vault', path: String(rawOrigin?.path), sha256: String(rawOrigin?.sha256) };
  if (!isStr(r.export)) fail('export');
  if (!isStr(r.importPath)) fail('importPath');
  if (r.registryDependencies !== undefined && !isStrArray(r.registryDependencies)) fail('registryDependencies');
  if (r.manifestOrigin !== undefined && r.manifestOrigin !== 'parsed' && r.manifestOrigin !== 'derived') fail('manifestOrigin');
  const gate = parseGate(r.gate, fail);
  const port = parsePort(r.port, fail);
  if (r.notes !== undefined && typeof r.notes !== 'string') fail('notes');
  if (r.candidates !== undefined && !(Array.isArray(r.candidates) && r.candidates.every(isBlockForms))) fail('candidates');
  if (r.manifest === undefined) fail('manifest');
  if (opts.requireManifest && r.verified === true && r.manifest === null) fail('manifest');
  const slug = r.slug as string;
  if (typeof r.source === 'string') assertInside(r.source, 'source', slug);
  assertInside(origin.path, 'origin.path', slug);
  const surface = r.surface as SurfaceByTheme;
  const slots = parseSlots(r.slots, r.kind as CatalogKind, fail);
  return {
    library: r.library as Library,
    kind: r.kind as CatalogKind,
    slug,
    name: r.name as string,
    ...(typeof r.role === 'string' ? { role: r.role as Role } : {}),
    category: r.category as string,
    tags: [...(r.tags as string[])],
    surface: { light: surface.light, dark: surface.dark },
    geometry: r.geometry as string,
    ...(typeof r.variant === 'string' ? { variant: r.variant } : {}),
    ...(slots ? { slots } : {}),
    ...(Array.isArray(r.semantics) ? { semantics: [...(r.semantics as SlotSemantic[])] } : {}),
    ...(typeof r.emittable === 'boolean' ? { emittable: r.emittable } : {}),
    verified: r.verified as boolean,
    source: r.source as string | null,
    origin,
    export: r.export as string,
    ...(r.exportDefault === true ? { exportDefault: true } : {}),
    importPath: r.importPath as string,
    ...(Array.isArray(r.registryDependencies) ? { registryDependencies: [...(r.registryDependencies as string[])] } : {}),
    manifest: r.manifest === null ? null : parseManifest(r.manifest, fail),
    ...(typeof r.manifestOrigin === 'string' ? { manifestOrigin: r.manifestOrigin as 'parsed' | 'derived' } : {}),
    ...(gate ? { gate } : {}),
    ...(port ? { port } : {}),
    ...(Array.isArray(r.candidates) ? { candidates: (r.candidates as BlockForms[]).map((c) => ({ forms: [...c.forms], ...(c.variant ? { variant: { ...c.variant } } : {}), ...(c.focal ? { focal: c.focal } : {}), ...(c.align ? { align: c.align } : {}), ...(c.itemsProp ? { itemsProp: c.itemsProp } : {}), ...(c.sectors ? { sectors: [...c.sectors] } : {}), ...(c.tones ? { tones: [...c.tones] } : {}) })) } : {}),
    ...(typeof r.notes === 'string' ? { notes: r.notes } : {}),
  };
}

function isBlockForms(x: unknown): x is BlockForms {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  const v = c.variant as Record<string, unknown> | undefined;
  return isStrArray(c.forms) && c.forms.length > 0 && (v === undefined || (typeof v === 'object' && v !== null && isStr(v.prop) && isStr(v.value)))
    && (c.focal === undefined || (BLOCK_FOCALS as readonly unknown[]).includes(c.focal))
    && (c.align === undefined || c.align === 'start' || c.align === 'center')
    && (c.itemsProp === undefined || (isStr(c.itemsProp) && /^[A-Za-z_$][\w$]*$/.test(c.itemsProp)))
    && (c.sectors === undefined || (isStrArray(c.sectors) && c.sectors.length > 0))
    && (c.tones === undefined || (isStrArray(c.tones) && c.tones.length > 0));
}

export function parseCatalog(json: string, opts: ParseOptions = {}): CatalogEntry[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('catalog/index.json: se esperaba un array');
  return data.map((raw, i) => parseCatalogEntry(raw, i, opts));
}

const byLibraryThenSlug = (a: CatalogEntry, b: CatalogEntry): number =>
  a.library.localeCompare(b.library) || a.slug.localeCompare(b.slug);

/** Serialización canónica (RNF1): orden por library, slug; claves en el orden de parseCatalogEntry. */
export function serializeCatalog(entries: CatalogEntry[]): string {
  const sorted = [...entries].sort(byLibraryThenSlug);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
