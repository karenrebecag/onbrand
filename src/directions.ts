// Catálogo de direcciones (spec docs/spec/catalogo-direcciones.md, APROBADA 2026-10-27). En Stitch, Lovable, v0 y el
// nuestro la variedad entre corridas es el prior del modelo: el mismo esqueleto de 7 secciones. Una dirección completa
// elegida fuera del modelo es lo único que cambia la forma; el agente recibe solo la elegida, nunca el catálogo.
// Puro: el pipeline pone la semilla, las etiquetas del brief y las recientes.

import type { Density } from './brand';
import type { RhythmProfile, SectionRole } from './types';
import type { BlockFocal, CatalogEntry } from './catalog/schema';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_PATH, loadCatalog } from './catalog/load';

// Sin 'ninguno': toda sección de contenido tiene foco (regla 11); un 'ninguno' en la dirección invitaba al agente a
// poner uno propio y desviarse (gen fac2bce5, beneficios con iconos).
export type Focal = Exclude<BlockFocal, 'ninguno'>;
export type DirectionSurface = 'base' | 'muted' | 'raised' | 'inverse';

export interface DirectionRole {
  /** Estructura de la sección, en el vocabulario de FORMS. */
  form: keyof typeof FORMS;
  focal: Focal;
  surface: DirectionSurface;
  /** Bloque de referencia, relativo a src/components/relume/ del scaffold: está en todo workspace y se lee antes de escribir. */
  ref: string;
}

export interface Direction {
  id: string;
  sector: readonly string[];
  tone: readonly string[];
  /** Par de FONT_LIST; si la marca trae fuentes, ganan las suyas. */
  type: { display: string; body: string };
  rhythm: RhythmProfile;
  density: Density;
  roles: Readonly<Record<SectionRole, DirectionRole>>;
}

/** Formas que los bloques del scaffold materializan (las de Lovable que el registry tiene con código). */
export const FORMS = {
  'split-media': 'dos columnas: texto de un lado y la media del otro',
  'full-bleed': 'imagen a sangre detrás de toda la sección con `Section backdrop={<Image …/>}`; el texto queda en el contenedor, alineado con el resto de la página',
  'centered-stack': 'una columna centrada: titular, texto y acción, con la media debajo',
  'off-grid': 'composición asimétrica: piezas de distinto tamaño fuera de la grilla regular',
  'grid-cards': 'tarjetas en grilla con imagen en cada una',
  'side-heading': 'titular fijo en una columna angosta y el contenido en la ancha',
  'two-col-list': 'lista en dos columnas, sin imagen',
  'card-grid': 'una tarjeta igual por item; las columnas salen de cuántos items hay',
  'single-quote': 'una sola cita grande con su foto',
  marquee: 'fila que se desplaza en horizontal',
  'narrow-accordion': 'una columna angosta con acordeón y, debajo, una nota en letra chica de texto plano (no un enlace)',
  'inline-band': 'banda baja: texto y acción en una fila',
  'stats-row': 'cifras grandes en fila',
  'top-bar': 'barra superior con la marca, los enlaces a las secciones y una acción; el menú móvil lo trae el bloque',
} as const;

const role = (form: DirectionRole['form'], focal: Focal, surface: DirectionSurface, ref: string): DirectionRole => ({ form, focal, surface, ref });

const H = {
  split: 'hero-header-sections/header-1/header-1-shell.tsx',
  bleed: 'hero-header-sections/header-30/header-30-shell.tsx',
  stack: 'hero-header-sections/header-145/header-145.tsx',
  cards: 'hero-header-sections-grid-cards/header-84/header-84.tsx',
  offGrid: 'hero-header-sections-off-grid/header-116/header-116.tsx',
} as const;
const F = {
  cards: 'feature-sections-3-col/layout-228/layout-228.tsx',
  plain: 'feature-sections-3-col/layout-237/layout-237-shell.tsx',
  side: 'feature-sections-3-col/layout-253/layout-253.tsx',
  bleed: 'feature-sections-3-col/layout-255/layout-255-shell.tsx',
  split: 'feature-sections-left-1-2-col-part-2/layout-105/layout-105.tsx',
  list: 'feature-sections-left-1-2-col-part-2/layout-122/layout-122.tsx',
  offGrid: 'feature-sections-off-grid/layout-428/layout-428.tsx',
} as const;
const T = {
  cards: 'testimonial-sections/testimonial-3/testimonial-3.tsx',
  cards2: 'testimonial-sections/testimonial-6/testimonial-6.tsx',
  quote: 'testimonial-sections/testimonial-13/testimonial-13.tsx',
  marquee: 'testimonial-sections/testimonial-21/testimonial-21.tsx',
} as const;
// Pricing solo con bloques que reparten las columnas según cuántos planes hay (collectionStyle): una forma de dos
// columnas chocaba siempre con 3 planes y el agente la abandonaba (gen fac2bce5, premium-sobrio).
const P = {
  cards10: 'pricing-sections/pricing-10/pricing-10.tsx',
  cards12: 'pricing-sections/pricing-12/pricing-12.tsx',
  cards18: 'pricing-sections-2/pricing-18/pricing-18.tsx',
} as const;
const Q = {
  narrow: 'faq-sections/faq-7/faq-7-shell.tsx',
  side: 'faq-sections/faq-9/faq-9.tsx',
  two: 'faq-sections/faq-12/faq-12.tsx',
  three: 'faq-sections/faq-14/faq-14.tsx',
} as const;
const C = {
  split: 'cta-sections/cta-1/cta-1.tsx',
  bleed: 'cta-sections/cta-3/cta-3-shell.tsx',
  two: 'cta-sections/cta-13/cta-13.tsx',
  stack: 'cta-sections/cta-19/cta-19.tsx',
  band: 'cta-sections-grid-cards/cta-45/cta-45.tsx',
} as const;
const S = { two: 'stats-sections/stats-2/stats-2.tsx', three: 'stats-sections/stats-8/stats-8.tsx', three2: 'stats-sections/stats-27/stats-27.tsx' } as const;
const L = { side: 'logo-sections/logo-2/logo-2.tsx', row: 'logo-sections/logo-3/logo-3.tsx', two: 'logo-sections/logo-4/logo-4.tsx' } as const;

export const DIRECTIONS: readonly Direction[] = [
  {
    id: 'editorial-serif',
    sector: ['servicios', 'creativo', 'hospitalidad'],
    tone: ['editorial', 'premium', 'sobrio'],
    type: { display: 'Fraunces', body: 'Instrument Sans' },
    rhythm: 'quiet',
    density: 'spacious',
    roles: {
      hero: role('full-bleed', 'foto', 'base', H.bleed),
      features: role('side-heading', 'iconos', 'base', F.side),
      steps: role('two-col-list', 'cifra', 'muted', F.list),
      stats: role('stats-row', 'cifra', 'base', S.two),
      logos: role('inline-band', 'logos', 'base', L.side),
      testimonials: role('single-quote', 'cita', 'muted', T.quote),
      pricing: role('card-grid', 'tabla', 'base', P.cards10),
      faq: role('side-heading', 'acordeón', 'base', Q.side),
      cta: role('centered-stack', 'acción', 'inverse', C.stack),
    },
  },
  {
    id: 'producto-tecnico',
    sector: ['saas', 'finanzas'],
    tone: ['tecnico', 'sobrio'],
    type: { display: 'Space Grotesk', body: 'IBM Plex Sans' },
    rhythm: 'banded',
    density: 'compact',
    roles: {
      hero: role('centered-stack', 'abstracto', 'base', H.stack),
      features: role('card-grid', 'mockup', 'muted', F.plain),
      steps: role('side-heading', 'cifra', 'base', F.side),
      stats: role('stats-row', 'cifra', 'inverse', S.three),
      logos: role('inline-band', 'logos', 'base', L.row),
      testimonials: role('card-grid', 'cita', 'muted', T.cards),
      pricing: role('card-grid', 'tabla', 'base', P.cards18),
      faq: role('two-col-list', 'acordeón', 'muted', Q.two),
      cta: role('inline-band', 'acción', 'inverse', C.band),
    },
  },
  {
    id: 'cercano-fotografico',
    sector: ['salud', 'educacion', 'servicios'],
    tone: ['cercano', 'amable'],
    type: { display: 'Bricolage Grotesque', body: 'Manrope' },
    rhythm: 'banded',
    density: 'default',
    roles: {
      hero: role('split-media', 'foto', 'base', H.split),
      features: role('split-media', 'foto', 'muted', F.split),
      steps: role('card-grid', 'cifra', 'base', F.plain),
      stats: role('stats-row', 'cifra', 'muted', S.three2),
      logos: role('two-col-list', 'logos', 'base', L.two),
      testimonials: role('card-grid', 'cita', 'raised', T.cards2),
      pricing: role('card-grid', 'tabla', 'base', P.cards12),
      faq: role('narrow-accordion', 'acordeón', 'muted', Q.narrow),
      cta: role('split-media', 'foto', 'inverse', C.split),
    },
  },
  {
    id: 'galeria-asimetrica',
    sector: ['creativo', 'retail', 'hospitalidad'],
    tone: ['audaz', 'editorial'],
    type: { display: 'Instrument Serif', body: 'Work Sans' },
    rhythm: 'neutral',
    density: 'spacious',
    roles: {
      hero: role('off-grid', 'foto', 'base', H.offGrid),
      features: role('off-grid', 'foto', 'base', F.offGrid),
      steps: role('two-col-list', 'cifra', 'muted', F.list),
      stats: role('stats-row', 'cifra', 'base', S.two),
      logos: role('inline-band', 'logos', 'muted', L.side),
      testimonials: role('marquee', 'cita', 'base', T.marquee),
      pricing: role('card-grid', 'tabla', 'muted', P.cards12),
      faq: role('two-col-list', 'acordeón', 'base', Q.two),
      cta: role('full-bleed', 'foto', 'inverse', C.bleed),
    },
  },
  {
    id: 'tarjetas-retail',
    sector: ['retail', 'educacion', 'saas'],
    tone: ['audaz', 'cercano'],
    type: { display: 'Schibsted Grotesk', body: 'Figtree' },
    rhythm: 'banded',
    density: 'compact',
    roles: {
      hero: role('grid-cards', 'foto', 'base', H.cards),
      features: role('grid-cards', 'foto', 'muted', F.cards),
      steps: role('card-grid', 'cifra', 'base', F.plain),
      stats: role('stats-row', 'cifra', 'raised', S.three),
      logos: role('inline-band', 'logos', 'base', L.row),
      testimonials: role('marquee', 'cita', 'muted', T.marquee),
      pricing: role('card-grid', 'tabla', 'base', P.cards18),
      faq: role('card-grid', 'acordeón', 'muted', Q.three),
      cta: role('two-col-list', 'acción', 'inverse', C.two),
    },
  },
  {
    id: 'premium-sobrio',
    sector: ['finanzas', 'salud', 'servicios'],
    tone: ['premium', 'sobrio'],
    type: { display: 'Playfair Display', body: 'Libre Franklin' },
    rhythm: 'quiet',
    density: 'spacious',
    roles: {
      hero: role('split-media', 'foto', 'base', H.split),
      features: role('side-heading', 'iconos', 'base', F.side),
      steps: role('card-grid', 'cifra', 'muted', F.plain),
      stats: role('stats-row', 'cifra', 'base', S.three2),
      logos: role('two-col-list', 'logos', 'base', L.two),
      testimonials: role('single-quote', 'cita', 'base', T.quote),
      pricing: role('card-grid', 'tabla', 'muted', P.cards10),
      faq: role('narrow-accordion', 'acordeón', 'base', Q.narrow),
      cta: role('full-bleed', 'foto', 'inverse', C.bleed),
    },
  },
  {
    id: 'banda-inmersiva',
    sector: ['hospitalidad', 'educacion', 'creativo'],
    tone: ['audaz', 'amable'],
    type: { display: 'Outfit', body: 'DM Sans' },
    rhythm: 'banded',
    density: 'default',
    roles: {
      hero: role('full-bleed', 'abstracto', 'base', H.bleed),
      features: role('full-bleed', 'foto', 'base', F.bleed),
      steps: role('side-heading', 'cifra', 'muted', F.side),
      stats: role('stats-row', 'cifra', 'raised', S.two),
      logos: role('inline-band', 'logos', 'base', L.side),
      testimonials: role('card-grid', 'cita', 'muted', T.cards2),
      pricing: role('card-grid', 'tabla', 'base', P.cards10),
      faq: role('card-grid', 'acordeón', 'muted', Q.three),
      cta: role('centered-stack', 'acción', 'base', C.stack),
    },
  },
  {
    id: 'directo-conversion',
    sector: ['saas', 'retail', 'servicios'],
    tone: ['cercano', 'tecnico'],
    type: { display: 'Sora', body: 'Onest' },
    rhythm: 'neutral',
    density: 'default',
    roles: {
      hero: role('centered-stack', 'mockup', 'base', H.stack),
      features: role('split-media', 'mockup', 'muted', F.split),
      steps: role('two-col-list', 'cifra', 'base', F.list),
      stats: role('stats-row', 'cifra', 'muted', S.three2),
      logos: role('two-col-list', 'logos', 'base', L.two),
      testimonials: role('card-grid', 'cita', 'base', T.cards),
      pricing: role('card-grid', 'tabla', 'muted', P.cards12),
      faq: role('side-heading', 'acordeón', 'base', Q.side),
      cta: role('split-media', 'mockup', 'inverse', C.split),
    },
  },
];

/** Mínimo de candidatas que deja la exclusión de recientes: con menos, la semilla no elige nada. gen7 (QA de Karen):
 * con 2 excluidas de 8, la 4ª corrida de una misma marca repitió la 1ª. */
export const MIN_POOL = 2;

// FNV-1a de 32 bits: la elección tiene que ser reproducible con la misma semilla, en cualquier runtime.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export interface PickInput {
  seed: string;
  sector?: readonly string[];
  tone?: readonly string[];
  /** Ids de las últimas direcciones usadas para este brief, la más reciente al final. */
  recent?: readonly string[];
  /** BrandComposition.styleSet: una marca que fija su dirección se salta la semilla. */
  styleSet?: string;
}

/** Un hero abstracto (visual generativo) no lleva imagen de producto: el preflight no la pide y se ahorran los ~45 s de
 * fal. Lo leen el transport y el composer, que es quien la corre si el transport no lo hizo. */
export const wantsProductImage = (d: Direction): boolean => d.roles.hero.focal !== 'abstracto';

/** Afinidad de una dirección con el brief: sector y tono cuentan por separado (un sector que cruza vale igual que un tono
 * que cruza), así una dirección del sector con el tono pedido gana a una que solo comparte el sector. */
export function directionAffinity(d: Direction, input: Pick<PickInput, 'sector' | 'tone'>): number {
  const sector = new Set(input.sector ?? []);
  const tone = new Set(input.tone ?? []);
  return d.sector.filter((s) => sector.has(s)).length + d.tone.filter((t) => tone.has(t)).length;
}

/** Candidatas por afinidad: el grupo de mayor afinidad y, si no llega a MIN_POOL, los grupos siguientes hasta llegar.
 * Sin ningún cruce, el catálogo entero. */
function affinityPool(input: PickInput, catalog: readonly Direction[]): Direction[] {
  const scored = catalog.map((d) => ({ d, score: directionAffinity(d, input) }));
  const levels = [...new Set(scored.map((s) => s.score))].sort((a, b) => b - a).filter((s) => s > 0);
  const pool: Direction[] = [];
  for (const level of levels) {
    if (pool.length >= MIN_POOL) break;
    pool.push(...scored.filter((s) => s.score === level).map((s) => s.d));
  }
  return pool.length ? pool : [...catalog];
}

/** Quita las recientes de la más nueva a la más vieja mientras queden MIN_POOL candidatas: con 8 direcciones y un brief
 * que cruza con 4, las 3 últimas corridas no se repiten; antes solo las 2 últimas. */
function withoutRecent(pool: readonly Direction[], recent: readonly string[]): Direction[] {
  const out = [...pool];
  for (const id of [...recent].reverse()) {
    const i = out.findIndex((d) => d.id === id);
    if (i >= 0 && out.length > MIN_POOL) out.splice(i, 1);
  }
  return out;
}

export function pickDirection(input: PickInput, catalog: readonly Direction[] = DIRECTIONS): Direction {
  const pinned = input.styleSet && catalog.find((d) => d.id === input.styleSet);
  if (pinned) return pinned;
  const final = withoutRecent(affinityPool(input, catalog), input.recent ?? []);
  return final[hash(input.seed) % final.length];
}

// Valores a los que convergen los modelos cuando inventan (Stitch, Lovable, v0 y el nuestro: +38 %, 42 s, 3x, $249).
export const TYPICAL_FIGURES = ['38 %', '42 %', '62 %', '42 s', '3x', '3,1x', '99,9 %', '4,9/5', '$49', '$79', '$149', '$249'] as const;
const TYPICAL_PERCENT = new Set([20, 25, 30, 35, 38, 40, 42, 45, 50, 60, 62, 70]);
const TYPICAL_SECONDS = new Set([30, 42, 60]);
const round5 = (n: number): number => Math.round(n / 5) * 5;

function pickFrom(seed: string, salt: string, lo: number, hi: number, skip: ReadonlySet<number>): number {
  const span = hi - lo + 1;
  for (let i = 0; i < span; i += 1) {
    const n = lo + ((hash(`${seed}:${salt}`) + i) % span);
    if (!skip.has(n)) return n;
  }
  return lo;
}

/** Cifras guía de la página, de la semilla: dos corridas con semillas distintas no comparten las mismas cifras. */
export function figureHints(seed: string): { percent: number; multiplier: string; seconds: number; prices: [number, number, number] } {
  const base = round5(pickFrom(seed, 'precio', 15, 85, new Set()));
  return {
    percent: pickFrom(seed, 'porcentaje', 13, 71, TYPICAL_PERCENT),
    multiplier: (pickFrom(seed, 'multiplicador', 14, 27, new Set([20, 25])) / 10).toFixed(1).replace('.', ','),
    seconds: pickFrom(seed, 'segundos', 7, 89, TYPICAL_SECONDS),
    prices: [base, round5(base * 2.7), round5(base * 6.4)],
  };
}

const SURFACE_TEXT: Record<DirectionSurface, string> = {
  base: 'base',
  muted: '`surface="muted"`',
  raised: '`surface="raised"`',
  inverse: '`surface="inverse"` (zona oscura)',
};

/** Un bloque de sección que puede ocupar un rol (índice, "Secciones de landing"), con las formas que pinta. Un bloque con
 * variantes entra una vez por variante: es la variante la que decide la forma. */
/** Los roles que un bloque puede ocupar: las secciones de la dirección y la barra de navegación, que no es sección pero
 * sin bloque el agente la escribe sin menú móvil y lo deja en Pendiente en cada corrida. */
export type BlockRole = SectionRole | 'navbar';

export interface BlockCandidate {
  id: string;
  role: BlockRole;
  exportName: string;
  importPath: string;
  variant?: { prop: string; value: string };
  forms: readonly (keyof typeof FORMS)[];
  focal?: BlockFocal;
  align?: 'start' | 'center';
  itemsProp?: string;
  sectors?: readonly string[];
  tones?: readonly string[];
}

const BLOCK_ROLES: ReadonlySet<string> = new Set<BlockRole>(['navbar', 'hero', 'features', 'steps', 'cta', 'testimonials', 'pricing', 'faq', 'logos', 'stats']);
const isForm = (f: string): f is keyof typeof FORMS => Object.hasOwn(FORMS, f);

/** Los candidatos salen de `candidates` de cada entrada del catálogo: un bloque nuevo de cualquier librería entra
 * declarándolos ahí, sin tocar este archivo. Fuera lo no verificado, lo propless y las formas que el catálogo de
 * direcciones no conoce (nunca coincidirían con una fila). */
export function blockCandidatesFrom(entries: readonly CatalogEntry[]): BlockCandidate[] {
  return entries.flatMap((e) => {
    if (!e.candidates || !e.verified || e.emittable === false || !e.role || !BLOCK_ROLES.has(e.role)) return [];
    const role = e.role as BlockRole;
    return e.candidates.flatMap((c) => {
      const forms = c.forms.filter(isForm);
      if (!forms.length) return [];
      return [{ id: `${e.library}/${e.slug}${c.variant ? `:${c.variant.value}` : ''}`, role, exportName: e.export, importPath: e.importPath, forms, ...(c.variant ? { variant: { ...c.variant } } : {}), ...(c.focal ? { focal: c.focal } : {}), ...(c.align ? { align: c.align } : {}), ...(c.itemsProp ? { itemsProp: c.itemsProp } : {}), ...(c.sectors ? { sectors: [...c.sectors] } : {}), ...(c.tones ? { tones: [...c.tones] } : {}) }];
    });
  });
}

/** El paquete publicado no lleva catalog/ (decisión 17: es tooling del vault, no contrato del alpha); sin índice no hay
 * candidatos y direction.md pide escribir cada sección, igual que cuando ninguno existe en el scaffold. */
export const blockCandidatesAt = (path: string): BlockCandidate[] => (existsSync(path) ? blockCandidatesFrom(loadCatalog(undefined, path)) : []);

export const BLOCK_CANDIDATES: readonly BlockCandidate[] = blockCandidatesAt(CATALOG_PATH);

/** Los candidatos cuyo `importPath` existe en el `src` del scaffold del workspace (`@/` = `src/`). El catálogo trae los bloques de la
 * distro aunque el workspace lleve la base neutra: un bloque que direction.md manda importar y no existe rompe el build.
 * HACK: se comprueba por existencia en disco en cada turno; se quita cuando el catálogo se parta en core y distro
 * (docs/spec/catalogo-core-distro.md) y BLOCK_CANDIDATES solo traiga lo del scaffold activo. */
export function candidatesIn(scaffoldSrc: string, candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES): BlockCandidate[] {
  const seen = new Map<string, boolean>();
  const exists = (importPath: string): boolean => {
    let hit = seen.get(importPath);
    if (hit === undefined) {
      const base = join(scaffoldSrc, importPath.replace(/^@\//, ''));
      hit = importPath.startsWith('@/') && ['.tsx', '.ts', '/index.tsx', '/index.ts'].some((ext) => existsSync(base + ext));
      seen.set(importPath, hit);
    }
    return hit;
  };
  return candidates.filter((c) => exists(c.importPath));
}

// Una fila abstracta pide un visual generativo: solo la ocupa un bloque que lo declara, porque uno sin focal (un hero
// con slot de media) pediría la foto que en esa dirección no se genera.
const focalFits = (block: BlockFocal | undefined, row: Focal | undefined): boolean =>
  !row ? true : row === 'abstracto' ? block === 'abstracto' : !block || block === row;

/** Sector y tono de la dirección: un eje que el bloque declara tiene que cruzar con el de la dirección. */
export interface BlockContext { sector: readonly string[]; tone: readonly string[] }
const axisFits = (declared: readonly string[] | undefined, wanted: readonly string[] | undefined): boolean =>
  !declared?.length || !wanted || declared.some((x) => wanted.includes(x));

/** El bloque de un rol para una forma, o undefined si ninguno la pinta (la sección se escribe con el ref de Relume).
 * Misma regla que pickDirection: semilla, y fuera los recientes salvo que no quede otro. Un bloque que declara focal
 * solo ocupa filas con ese focal: un hero de shader en una fila de foto se contradice y el agente lo reescribe
 * (QA 3fc160a7). */
export function pickBlock(role: BlockRole, form: keyof typeof FORMS, seed: string, candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES, recent: readonly string[] = [], focal?: Focal, context?: BlockContext): BlockCandidate | undefined {
  const fit = candidates.filter((c) => c.role === role && c.forms.includes(form) && focalFits(c.focal, focal) && axisFits(c.sectors, context?.sector) && axisFits(c.tones, context?.tone));
  if (!fit.length) return undefined;
  const skip = new Set(recent);
  const fresh = fit.filter((c) => !skip.has(c.id));
  const pool = fresh.length ? fresh : fit;
  return pool[hash(`${seed}:${role}`) % pool.length];
}

const blockCell = (c: BlockCandidate | undefined): string =>
  c ? `\`import { ${c.exportName} } from "${c.importPath}"\`${c.variant ? ` con \`${c.variant.prop}="${c.variant.value}"\`` : ''}` : 'ninguno: escribe la sección';

/** El bloque elegido por rol, en el orden de la página. Es lo que direction.md escribe en la columna Bloque y lo que
 * va a agent.trace, para que QA no lo saque del markdown. */
const NAVBAR_FORM = 'top-bar' as const;
const pageOrder = (d: Direction): BlockRole[] => ['navbar', ...(Object.keys(d.roles) as SectionRole[])];

export function directionBlockPicks(d: Direction, order: readonly BlockRole[] = pageOrder(d), seed?: string, candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES, recentBlocks: readonly string[] = []): { role: BlockRole; block?: BlockCandidate }[] {
  const context = { sector: d.sector, tone: d.tone };
  return order.map((role) => {
    const row = role === 'navbar' ? undefined : d.roles[role];
    const block = pickBlock(role, row?.form ?? NAVBAR_FORM, seed ?? d.id, candidates, recentBlocks, row?.focal, context);
    return block ? { role, block } : { role };
  });
}

/** `references/direction.md`: la dirección elegida, en el formato que lee el agente. */
export function directionReference(d: Direction, order: readonly BlockRole[] = pageOrder(d), seed?: string, candidates: readonly BlockCandidate[] = BLOCK_CANDIDATES, recentBlocks: readonly string[] = [], real: RealFigures = {}): string {
  const rows = directionBlockPicks(d, order, seed, candidates, recentBlocks).flatMap(({ role: r, block }) => {
    // La barra no tiene fila en la dirección: sin bloque, la escribe el agente como hasta ahora y no hay fila que leer.
    if (r === 'navbar') return block ? [`| navbar | ${blockCell(block)} | ${NAVBAR_FORM}: la pinta el bloque, con el menú móvil | acción | base | — |`] : [];
    const x = d.roles[r];
    // Con bloque, la forma ya la pinta él: la descripción de FORMS son instrucciones de escritura (`Section backdrop`)
    // que compiten con "impórtalo" (QA 3fc160a7).
    return `| ${r} | ${blockCell(block)} | ${x.form}: ${block ? 'la pinta el bloque' : FORMS[x.form]} | ${x.focal} | ${SURFACE_TEXT[x.surface]} | \`src/components/relume/${x.ref}\` |`;
  });
  return [
    `# Dirección: ${d.id}`,
    '',
    'Esta página sigue esta dirección. Es la estructura, no el contenido: el copy, las cifras y el foco concreto los decides para este negocio.',
    '',
    `- **Tipografía:** ${d.type.display} en titulares y ${d.type.body} en el cuerpo. Si \`src/identity.css\` viene de un brand pack, ganan sus fuentes.`,
    `- **Ritmo:** ${d.rhythm}. **Densidad:** ${d.density}.`,
    '- En `page-plan.md`, escribe `direccion: ' + d.id + '` en la cabecera y, por sección, la forma y el focal de esta tabla.',
    '- Por cada sección, en este orden:',
    '  1. Si la fila trae **Bloque**, impórtalo y pásale el contenido del brief por props (las de "Secciones de landing" en',
    '     `references/components/index.md`), dentro de `<Section id role slug bare>`, con la variante de la fila. Nunca lo dejes sin props: pintaría',
    '     su demo. No reescribas a mano una sección que tiene bloque: QA la marca como defecto. Una acción del bloque con',
    '     `href` a wa.me ya pinta el botón de WhatsApp (regla 8) sin que le pases `variant`. La fila navbar no es una',
    '     sección: su bloque va dentro de `<header data-wt-role="navbar" data-wt-slug="01-navbar">`, sin `Section`, con la',
    '     marca, los enlaces a las anclas de la página y la acción principal; el menú móvil ya lo trae.',
    '  2. Si no trae bloque: Read de la ruta de su fila en la columna Referencia (una guía de layout, no un componente',
    '     para importar) y escribe la sección con esa forma.',
    '',
    ...(seed ? figureLines(figureHints(seed), real) : []),
    '| Rol | Bloque | Forma | Focal | Superficie | Referencia de layout |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Qué cifras ya son reales (DATOS REALES del prompt): una pista inventada al lado de una real compite con ella. */
export interface RealFigures { metrics?: boolean; prices?: boolean }

function figureLines(f: ReturnType<typeof figureHints>, real: RealFigures): string[] {
  const hints = [
    ...(real.metrics ? [] : [`una mejora alrededor de ${f.percent} %`, `un multiplicador de ${f.multiplier}x`, `un tiempo de ${f.seconds} s`]),
    ...(real.prices ? [] : [`precios desde ${f.prices.map((p) => `$${p}`).join(' / ')} al mes`]),
  ];
  const kept = [real.metrics && 'las métricas', real.prices && 'los precios'].filter(Boolean).join(' y ');
  return [
    '## Cifras guía',
    '',
    ...(kept ? [`${kept.charAt(0).toUpperCase()}${kept.slice(1)} son las de DATOS REALES del prompt, tal cual: aquí no hay pista para ellas.`] : []),
    ...(hints.length ? [`Las cifras que inventes parten de estas, ajustadas al sector (y declaradas en \`inventado:\`): ${hints.join(', ')}. Nunca uses los valores típicos de plantilla: ${TYPICAL_FIGURES.join(', ')}.`] : []),
    '',
  ];
}
