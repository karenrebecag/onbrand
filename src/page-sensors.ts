// Sensores de página (HC1, re-v0/HIPOTESIS-QAWebTransformer.md): cada uno afirma un campo del contrato de
// página (A) o de bloque (B) contra lo que el navegador midió en la página del usuario. Aquí solo se decide;
// la medición vive en scripts/page-sensors.browser.js, el mismo código que se corre sobre el preview de v0
// para calibrar (0 defectos en v0 j049 y Café Lumbre, rojo en 82cd6634). El dueño del campo viaja con el
// defecto para que el repair lo enrute (HC2).

import { detectLang, type Lang } from './foreign-text';
import { visualKinds, type SectionVisuals } from './richness';
import { optionalFocal, planCount, planDefects, type PagePlanMd, type PlanSection } from './page-plan-md';
import type { BlockCandidate, Direction, DirectionRole, Focal } from './directions';
import { fold, roleOfKey } from './plan-sensors';
import { roleOfSlug } from './section-slug';

export type Align = 'start' | 'center';

export interface MeasuredSection {
  key: string;
  role: string;
  frame: boolean;
  height: number;
  /** `left`: borde izquierdo del texto de la cabecera, en px de viewport (solo si está a la izquierda). */
  header: { align: Align; text: string; left?: number } | null;
  collections: { items: number; rows: number[]; tag: string; cls: string }[];
  hiddenBefore: number;
  revealed: number;
  text: string;
  /** Texto visible de cada caja de bloque sin otra caja con texto dentro (párrafo, título, celda), por innerText. */
  fragments?: string[];
  /** Todo el texto del DOM de la sección, visible o no (acordeón cerrado, tab inactivo). */
  domText?: string;
  /** Enlaces visibles; `target` dice si el ancla existe (null si no es un ancla). */
  links?: { href: string; text: string; target: boolean | null }[];
  /** Imágenes cargadas, con sus dimensiones reales. `flat`: pinta un solo color (null si el canvas no la pudo leer). */
  images?: { src: string; alt: string; width: number; height: number; flat?: boolean | null }[];
  /** Riqueza por forma (src/richness.ts decide qué es visual). */
  visuals?: SectionVisuals;
  /** Detalle de soporte: chips, etiquetas con icono chico, notas en letra chica, y si hay una acción con fondo. */
  support?: { chips: number; iconLabels: number; notes: number; action: boolean };
  /** Superficie que pide el wrapper y el fondo que se pinta detrás de la sección y de la página. */
  surface?: { declared: string | null; bg: string; page: string };
  /** Iconos de trazo que pintan relleno o que no pintan nada: el texto de su tarjeta, para ubicarlos. */
  brokenIcons?: string[];
  /** Logos anchos (wordmark) con el texto de su enlace o fila (brand-sensors, brand.logo). */
  /** ratio = ancho/alto medido; brand-sensors decide con él si es wordmark cuando el pack no declara logoKind. */
  logos?: { src: string; text: string; ratio?: number }[];
  /** Acciones con fondo propio: fondo, borde (`none` o `<px> <rgb>`) y radio topado a la mitad del alto. */
  actions?: { text: string; bg: string | null; border: string; radius: number }[];
  /** Iniciales pintadas en un retrato de 96 px o más sin imagen: el slot de foto quedó vacío. */
  initials?: string[];
  /** Contrato de Section: null en páginas sin data-wt-role (v0, Stitch). */
  layout?: { section: boolean; container: boolean; margins: { left: number; right: number } | null } | null;
}

export interface PageMeasure {
  viewport: number;
  lang: string;
  title: string;
  overflow?: { scrollWidth: number; clientWidth: number };
  fonts: { family: string; count: number; generic: boolean; loaded: boolean; declared: boolean }[];
  animations: number;
  /** Acento resuelto en :root (--accent a rgb) y el preset `data-accent` del documento. */
  accent?: { attr: string | null; rgb: string | null };
  /** Elementos que pintan su fondo con un color cercano a --brand-highlight, con su área en px² (brand-sensors). */
  highlightAreas?: { tag: string; text: string; bg: string; area: number; section: string }[];
  sections: MeasuredSection[];
}

/** Lo que la página debería cumplir. Hasta que exista el contrato A, cada campo trae su default. */
export interface PageExpect {
  lang?: Lang;
  /** Alineación de cabecera por defecto de las secciones de contenido (v0: 10/10 a la izquierda). */
  align?: Align;
  /** Por sección (key), cuando el plan la fija. */
  sectionAlign?: Record<string, Align>;
  /** Secciones con entrada animada permitidas por página (guía de Arc: una entrada orquestada como mucho). */
  motionBudget?: number;
  /** `page-plan.md` del workspace del agente; null si el agente debía escribirlo y no está. Sin campo, no se afirma. */
  plan?: PagePlanMd | null;
  /** La dirección que el pipeline entregó en references/direction.md. `brandFonts`: el pack fija las fuentes y el par
   * tipográfico de la dirección no se afirma (spec catalogo-direcciones §3). `blocks`: el bloque que su columna Bloque
   * eligió por rol; la forma en el DOM se mide contra él. */
  /** El código de cada `src/sections/NN-*.tsx` por key, para saber si la sección importa su bloque elegido. */
  sources?: Readonly<Record<string, string>>;
  /** Rutas públicas (`/images/…`) cuyo generador falló: agent.images.pending de page.json en turnos anteriores a la
   * tool de imagen (los del banco siguen midiéndose). */
  pendingImages?: readonly string[];
  direction?: { direction: Direction; brandFonts: boolean; blocks?: Partial<Record<keyof Direction['roles'], BlockCandidate>> };
}

export type SensorField = 'collection.rows' | 'section.align' | 'section.gutter' | 'section.contract' | 'section.centered' | 'page.lang' | 'section.lang' | 'brand.fonts' | 'page.motion' | 'content.emitted' | 'page.overflow' | 'page.title' | 'icon.rendered' | 'section.detail' | 'plan.exists' | 'plan.copy' | 'plan.count' | 'plan.surface' | 'plan.detail' | 'plan.direction' | 'image.pending' | 'image.blank' | 'button.unified' | 'portrait.empty';

/** A = contrato de página (plan, documento, marca); B = contrato de bloque (lo aplica el bloque); L6 = la
 * emisión del runner (lo que el composer decidió y no llegó al TSX). */
export type Owner = 'A' | 'B' | 'L6';

export const FIELD_OWNER: Record<SensorField, Owner> = {
  'collection.rows': 'B',
  'section.align': 'B',
  // La sección no usa Section o la saca de su eje: lo escribió el agente sobre el contrato de bloque.
  'section.contract': 'B',
  'section.centered': 'B',
  'section.gutter': 'B',
  'page.lang': 'A',
  'section.lang': 'A',
  'brand.fonts': 'A',
  'page.motion': 'B',
  // Por defecto la emisión; si el texto sí está en el TSX y no en el DOM, el bloque no lo pinta (B).
  'content.emitted': 'L6',
  // Algún bloque no se encoge al viewport: el contrato de bloque es responsive.
  'page.overflow': 'B',
  'page.title': 'A',
  // El glifo lo trae el set de iconos del DS: el bloque lo usa tal cual.
  'icon.rendered': 'B',
  'section.detail': 'B',
  'plan.exists': 'A',
  // El plan se cumplió o no en el código de la sección: lo arregla quien escribe la sección, no el plan.
  'plan.copy': 'B',
  'plan.count': 'B',
  'plan.surface': 'B',
  'plan.detail': 'B',
  // El plan o la página se salieron de la dirección elegida fuera del modelo: la elección es del contrato de página.
  'plan.direction': 'A',
  // El motor debía generar la imagen al cerrar el turno y no llegó: es la emisión del runner, no la sección.
  'image.pending': 'L6',
  // Una imagen de un solo color: el placeholder gris de un bloque o un asset vacío que la sección usa como foto.
  'image.blank': 'B',
  // Las acciones con el mismo fondo son la misma variante: borde y radio los fija la ranura de marca del Button.
  'button.unified': 'A',
  // El bloque pinta iniciales por contrato cuando falta la foto: la foto la pasa quien escribe la sección.
  'portrait.empty': 'B',
};

export interface SensorDefect {
  field: SensorField;
  owner: Owner;
  section: string;
  viewport: number;
  expected: string;
  actual: string;
  message: string;
}

export interface SensorReport {
  /** Cuántas veces se afirmó cada campo: un sensor que no midió nada no es un verde. */
  checked: Record<SensorField, number>;
  defects: SensorDefect[];
}

const DEFAULT_ALIGN: Align = 'start';
const DEFAULT_MOTION_BUDGET = 1;
// v0 alterna a propósito contenedores de 144, 176 y 208 px a 1440 (±32); el cierre pegado al borde de
// cc7b8016 se va 124. Calibrado en v0 Mini, Stitch y cc7b8016: solo marca ese cierre.
const GUTTER_TOLERANCE = 48;
// Con menos cabeceras la mediana no dice cuál es el margen de la página.
const GUTTER_MIN_SECTIONS = 3;
// Menos palabras que esto no dan señal de idioma fiable (un nombre de marca, una cifra).
const MIN_LANG_WORDS = 6;

const defect = (field: SensorField, section: string, viewport: number, expected: string, actual: string, message: string, owner: Owner = FIELD_OWNER[field]): SensorDefect =>
  ({ field, owner, section, viewport, expected, actual, message });

// Redondeo de las cajas: el contrato de Arq es margen izquierdo = derecho ±1 px.
const CENTER_TOLERANCE = 1;

/** Cada sección de contenido usa Section (.l-section > .l-container) y su container queda centrado. El marco no se
 * afirma: navbar y footer tienen su propio layout. */
function contractDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  const out: SensorDefect[] = [];
  for (const s of m.sections) {
    if (s.frame || !s.layout) continue;
    checked['section.contract'] += 1;
    if (!s.layout.section || !s.layout.container) {
      out.push(defect('section.contract', s.key, m.viewport, '.l-section > .l-container', s.layout.section ? 'sin .l-container hijo' : 'sin .l-section', `${s.role} no usa Section: ${s.layout.section ? 'falta el .l-container hijo directo' : 'no es un .l-section'}`));
      continue;
    }
    const { left, right } = s.layout.margins!;
    checked['section.centered'] += 1;
    if (Math.abs(left - right) > CENTER_TOLERANCE) out.push(defect('section.centered', s.key, m.viewport, 'margen izquierdo = derecho', `${left}/${right}`, `el container de ${s.role} está corrido: ${left} px a la izquierda y ${right} px a la derecha`));
  }
  return out;
}

/** Cabecera fuera del margen de la página: su borde izquierdo se aparta de la mediana de las demás. Las
 * centradas no cuentan (eso es section.align) ni el marco (los títulos del footer son de columna). */
// Un bloque importado trae su propio contenedor (PricingTable de Morphin arranca en 232 a 1440): igual que la
// alineación, el margen cede ante el bloque y la sección no entra a la mediana.
function gutterDefects(m: PageMeasure, e: PageExpect, checked: SensorReport['checked']): SensorDefect[] {
  const placed = m.sections.filter((s) => !s.frame && s.header?.align === 'start' && s.header.left !== undefined && !usedBlock(s, e));
  if (placed.length < GUTTER_MIN_SECTIONS) return [];
  const lefts = placed.map((s) => s.header!.left!).sort((a, b) => a - b);
  const median = lefts[Math.floor(lefts.length / 2)];
  checked['section.gutter'] += placed.length;
  return placed.flatMap((s) => {
    const dx = s.header!.left! - median;
    // Con Section el margen lo pone su container: la FAQ narrow (768 px) arranca en 336 a 1440 a propósito. Una
    // cabecera al borde de su propio container respeta el margen aunque se aparte de la mediana.
    const own = s.layout?.margins?.left;
    if (own !== undefined && Math.abs(s.header!.left! - own) <= GUTTER_TOLERANCE) return [];
    return Math.abs(dx) > GUTTER_TOLERANCE ? [defect('section.gutter', s.key, m.viewport, `x≈${median}`, `x=${s.header!.left}`, `la cabecera de ${s.role} ("${s.header!.text}") arranca en x=${s.header!.left} y el margen de la página está en x≈${median}`)] : [];
  });
}

/** Fila incompleta: más de una fila y la última con menos items que la primera (3 en 2 columnas = 2+1). */
export function incompleteRows(rows: readonly number[]): boolean {
  return rows.length > 1 && rows[rows.length - 1] < rows[0];
}

function collectionDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  const out: SensorDefect[] = [];
  for (const s of m.sections) {
    for (const c of s.collections) {
      checked['collection.rows'] += 1;
      if (incompleteRows(c.rows)) out.push(defect('collection.rows', s.key, m.viewport, 'filas completas', c.rows.join('+'), `a ${m.viewport} px ${s.role} reparte ${c.items} items en filas ${c.rows.join('+')}`));
    }
  }
  return out;
}

const quoted = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// El bloque elegido es import y variante: FaqSection en accordion no cumple una fila que pidió columns.
export const usesBlock = (code: string, b: BlockCandidate): boolean =>
  new RegExp(`from ["']${quoted(b.importPath)}["']`).test(code) && (!b.variant || new RegExp(`${b.variant.prop}=\\{?["']${quoted(b.variant.value)}["']`).test(code));

/** El bloque que la corrida eligió para el rol de la sección, si su código lo importa con su variante. */
function usedBlock(s: MeasuredSection, e: PageExpect): { block: BlockCandidate; source: string } | undefined {
  const block = e.direction?.blocks?.[s.role as keyof Direction['roles']];
  const source = e.sources?.[s.key];
  return block && source && usesBlock(source, block) ? { block, source } : undefined;
}

// HACK: la alineación de una variante sale de sus formas, porque el catálogo no la declara; una forma sin entrada no se
// afirma. Leerla del candidato cuando el catálogo la traiga.
const FORM_ALIGN: Partial<Record<DirectionRole['form'], Align>> = { 'centered-stack': 'center', 'split-media': 'start', 'side-heading': 'start', 'two-col-list': 'start', 'inline-band': 'start' };
const blockAlign = (b: BlockCandidate): Align | undefined => {
  const aligns = new Set(b.forms.map((f) => FORM_ALIGN[f]));
  return aligns.size === 1 ? [...aligns][0] : undefined;
};

/** La cabecera sigue el contrato general, salvo en una sección que importa su bloque elegido: ahí manda la variante. */
function alignDefects(m: PageMeasure, e: PageExpect, checked: SensorReport['checked']): SensorDefect[] {
  const out: SensorDefect[] = [];
  for (const s of m.sections) {
    if (s.frame || !s.header) continue;
    const used = usedBlock(s, e);
    const want = used ? blockAlign(used.block) : e.sectionAlign?.[s.key] ?? e.align ?? DEFAULT_ALIGN;
    if (!want) continue;
    checked['section.align'] += 1;
    if (s.header.align !== want) out.push(defect('section.align', s.key, m.viewport, want, s.header.align, `la cabecera de ${s.role} ("${s.header.text}") está ${s.header.align === 'center' ? 'centrada' : 'a la izquierda'} y ${used ? `el bloque ${used.block.id} pide` : 'el contrato pide'} ${want}`));
  }
  return out;
}

const words = (t: string): number => t.split(/[^\p{L}]+/u).filter(Boolean).length;

function langDefects(m: PageMeasure, want: Lang | undefined, checked: SensorReport['checked']): SensorDefect[] {
  if (!want) return [];
  const out: SensorDefect[] = [];
  checked['page.lang'] += 1;
  const declared = m.lang.toLowerCase().split('-')[0];
  if (declared !== want) out.push(defect('page.lang', '-', m.viewport, want, declared || '(vacío)', `<html lang="${m.lang}"> en una página en ${want}`));
  for (const s of m.sections) {
    if (words(s.text) < MIN_LANG_WORDS) continue;
    checked['section.lang'] += 1;
    const got = detectLang(s.text);
    if (got && got !== want) out.push(defect('section.lang', s.key, m.viewport, want, got, `${s.role} está en ${got} en una página en ${want}`));
  }
  return out;
}

function fontDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  const out: SensorDefect[] = [];
  for (const f of m.fonts) {
    if (f.generic) continue;
    checked['brand.fonts'] += 1;
    if (!f.loaded) out.push(defect('brand.fonts', '-', m.viewport, `${f.family} cargada`, f.declared ? 'declarada sin cargar' : 'sin @font-face', `la fuente "${f.family}" (${f.count} elementos) no se carga: cae a la del sistema`));
  }
  return out;
}

function motionDefects(m: PageMeasure, budget: number, checked: SensorReport['checked']): SensorDefect[] {
  checked['page.motion'] += 1;
  const animated = m.sections.filter((s) => s.revealed > 0);
  return animated.slice(budget).map((s) => defect('page.motion', s.key, m.viewport, `≤${budget} secciones con entrada`, String(animated.length), `${s.role} entra animada al hacer scroll; la página ya gastó su presupuesto de ${budget}`));
}

/** Lo que el composer decidió para una sección: sus hojas de texto (de page.json) y el TSX que emitió el
 * runner. Viene de page.json y no de render-input.json: render-input se arma con el mismo recorrido que
 * emite el TSX, así que pierde lo mismo (los botones vacíos de pricing en 8ae26d51). */
export interface EmittedSection {
  key: string;
  leaves: string[];
  source: string;
}

// Claves de page.json que no son texto en pantalla: estructura, variantes, rutas e iconos.
const NOT_TEXT = new Set(['component', 'layout', 'text', 'variant', 'size', 'align', 'justify', 'gap', 'cols', 'width', 'surface', 'padding', 'role', 'href', 'src', 'icon', 'id', 'tone', 'kind', 'as', 'type', 'alt', 'provenance', 'image', 'emphasis', 'motion', 'density', 'inverse', 'target', 'rel', 'name', 'ratio', 'fit', 'position', 'orientation', 'theme', 'accent']);
const MIN_LEAF_CHARS = 4;
const normText = (t: string): string => t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Hojas de texto de una sección de page.json. Un valor que no tiene espacio ni mayúscula (secondary, md,
 * start) es un enum, no copy; una ruta, un ancla o un icono tampoco se ven. */
export function textLeaves(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) { node.forEach((n) => textLeaves(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (NOT_TEXT.has(k)) continue;
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length < MIN_LEAF_CHARS || !/\p{L}/u.test(t) || /^(icon:|#|\/|https?:|mailto:|tel:)/.test(t)) continue;
      if (!/\s/.test(t) && t === t.toLowerCase()) continue;
      out.push(t);
    } else textLeaves(v, out);
  }
  return out;
}

function emittedDefects(m: PageMeasure, emitted: readonly EmittedSection[], checked: SensorReport['checked']): SensorDefect[] {
  const out: SensorDefect[] = [];
  for (const e of emitted) {
    const seen = m.sections.find((s) => s.key === e.key);
    if (!seen || seen.domText === undefined) continue;
    const dom = normText(seen.domText);
    // El runner emite el texto como literal JSON: se deshacen sus escapes antes de buscarlo.
    const source = normText(e.source.replace(/\\(["'\\])/g, '$1').replace(/\\n/g, ' '));
    for (const leaf of new Set(e.leaves)) {
      checked['content.emitted'] += 1;
      const want = normText(leaf);
      if (dom.includes(want)) continue;
      const inSource = source.includes(want);
      out.push(defect('content.emitted', e.key, m.viewport, `"${leaf.slice(0, 60)}" en pantalla`, inSource ? 'en el TSX, no en el DOM' : 'no está en el TSX', `${seen.role}: "${leaf.slice(0, 60)}" está en page.json y no llega a la página (${inSource ? 'el bloque no lo pinta' : 'el runner no lo emitió'})`, inSource ? 'B' : 'L6'));
    }
  }
  return out;
}

/** El idioma esperado: el del contrato, o el que domina el texto visible de la página si no lo hay. */
export function expectedLang(m: PageMeasure, e: PageExpect): Lang | undefined {
  return e.lang ?? detectLang(m.sections.map((s) => s.text).join(' '));
}

// Una franja (logos, banda de confianza) no es una sección con foco propio: se mide por su altura.
const BAND_MAX_HEIGHT = 160;

/** Cada sección de contenido trae un elemento focal (visual, colección, acordeón o acción con fondo) y al menos un
 * detalle de soporte (chip, etiqueta con icono, nota en letra chica). Calibrado en v0 Mini, Stitch y Figma Make: 0;
 * c9c5a540: beneficios (icono + título + texto) y la FAQ sin nota. */
function detailDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  return m.sections.flatMap((s) => {
    if (s.frame || !s.support || s.height < BAND_MAX_HEIGHT) return [];
    checked['section.detail'] += 1;
    const focal = visualKinds(s.visuals).length > 0 || s.collections.length > 0 || (s.visuals?.interactive ?? 0) >= 2 || s.support.action;
    const support = s.support.chips + s.support.iconLabels + s.support.notes;
    if (focal && support > 0) return [];
    const missing = !focal ? 'elemento focal' : 'detalle de soporte';
    return [defect('section.detail', s.key, m.viewport, 'focal + soporte', `sin ${missing}`, `${s.role} no tiene ${missing} (${!focal ? 'visual, tarjetas, acordeón o acción' : 'chip, etiqueta con icono o nota'})`)];
  });
}

function iconDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  return m.sections.flatMap((s) => {
    if (!s.brokenIcons) return [];
    checked['icon.rendered'] += 1;
    // Uno por sección: los iconos rotos de una sección comparten causa (el set de iconos), no son N defectos.
    const n = s.brokenIcons.length;
    return n ? [defect('icon.rendered', s.key, m.viewport, 'iconos de trazo', `${n} con relleno sólido o vacíos`, `${s.role}: ${n} icono${n > 1 ? 's' : ''} pinta${n > 1 ? 'n' : ''} relleno o no pinta${n > 1 ? 'n' : ''} nada (glifo roto), p. ej. en "${s.brokenIcons[0]}"`)] : [];
  });
}

const pathOf = (src: string): string => { try { return new URL(src, 'http://x').pathname; } catch { return src; } };

/** Uno por sección: una imagen pendiente es "focal sin imagen"; una lisa que no está pendiente es image.blank. */
function imageDefects(m: PageMeasure, pending: readonly string[], checked: SensorReport['checked']): SensorDefect[] {
  const failed = new Set(pending);
  return m.sections.flatMap((s) => {
    if (!s.images?.length) return [];
    checked['image.pending'] += 1;
    const missing = s.images.find((i) => failed.has(pathOf(i.src)));
    if (missing) return [defect('image.pending', s.key, m.viewport, 'imagen generada', pathOf(missing.src), `${s.role}: focal sin imagen: el generador falló (${pathOf(missing.src)})`)];
    checked['image.blank'] += 1;
    const blank = s.images.find((i) => i.flat === true);
    return blank ? [defect('image.blank', s.key, m.viewport, 'imagen con contenido', `${pathOf(blank.src)} de un solo color`, `${s.role}: la imagen ${pathOf(blank.src)} pinta un solo color (placeholder o asset vacío)`)] : [];
  });
}

const RADIUS_TOLERANCE = 2;

/** Las acciones con el mismo fondo comparten borde y radio: el estilo más usado manda (empate: el primero en la
 * página) y cada sección con otro estilo es un defecto. */
function buttonDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  const all = m.sections.flatMap((s) => (s.actions ?? []).filter((a) => a.bg).map((a) => ({ ...a, s })));
  checked['button.unified'] += all.length;
  const out: SensorDefect[] = [];
  for (const bg of new Set(all.map((a) => a.bg))) {
    const group = all.filter((a) => a.bg === bg);
    const styles = [...new Set(group.map((a) => a.border))].flatMap((border) => [...new Set(group.filter((a) => a.border === border).map((a) => a.radius))].map((radius) => ({ border, radius, n: group.filter((a) => a.border === border && Math.abs(a.radius - radius) <= RADIUS_TOLERANCE).length })));
    const ref = styles.reduce((best, x) => (x.n > best.n ? x : best), styles[0]!);
    const same = (a: (typeof group)[number]) => a.border === ref.border && Math.abs(a.radius - ref.radius) <= RADIUS_TOLERANCE;
    const seen = new Set<string>();
    for (const a of group.filter((x) => !same(x))) {
      if (seen.has(a.s.key)) continue;
      seen.add(a.s.key);
      out.push(defect('button.unified', a.s.key, m.viewport, `borde ${ref.border}, radio ${ref.radius}px`, `borde ${a.border}, radio ${a.radius}px`, `${a.s.role}: "${a.text}" pinta fondo ${bg} con borde ${a.border} y radio ${a.radius}px; las demás acciones con ese fondo usan borde ${ref.border} y radio ${ref.radius}px`));
    }
  }
  return out;
}

function portraitDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  return m.sections.flatMap((s) => {
    if (!s.initials) return [];
    checked['portrait.empty'] += 1;
    return s.initials.length ? [defect('portrait.empty', s.key, m.viewport, 'foto en el retrato', `iniciales ${s.initials.join(', ')}`, `${s.role}: el retrato pinta las iniciales "${s.initials[0]}" en vez de una foto (slot de foto vacío)`)] : [];
  });
}

// Títulos que deja la plantilla del generador cuando nadie escribe el de la página (Figma Make: "Figma Make App").
const TEMPLATE_TITLE = /^(?:vite(?: \+ react(?: \+ ts)?)?(?: app)?|react app|create next app|figma make app|lovable(?: app)?|v0 app|my v0 project|untitled|document)$/i;

/** El <title> es el de la página y no el de la plantilla: es lo que se ve en la pestaña y en el resultado de búsqueda. */
function titleDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  checked['page.title'] += 1;
  const t = m.title.trim();
  return !t || TEMPLATE_TITLE.test(t) ? [defect('page.title', '-', m.viewport, 'título de la página', t || '(vacío)', `<title>${t || ''}</title> es el de la plantilla, no el de la página`)] : [];
}

/** Scroll horizontal: el documento más ancho que el viewport (Figma Make a 375: 465 px). Se afirma en cada ancho. */
function overflowDefects(m: PageMeasure, checked: SensorReport['checked']): SensorDefect[] {
  if (!m.overflow) return [];
  checked['page.overflow'] += 1;
  const { scrollWidth, clientWidth } = m.overflow;
  return scrollWidth > clientWidth ? [defect('page.overflow', '-', m.viewport, `≤${clientWidth}px`, `${scrollWidth}px`, `a ${m.viewport} px la página mide ${scrollWidth} px de ancho: hay scroll horizontal`)] : [];
}

// Sin data-wt-role el navbar y el footer no se miden como sección: su entrada del plan no tiene contra qué afirmarse.
const PLAN_FRAME = /^(navbar|header|footer)$/;
const SURFACES = /^(base|muted|raised|inverse)\b/i;
// Letras y dígitos solamente: el titular puede partirse en spans (highlight) o en un <br>, y el plan lo cita con comillas.
const planKey = (t: string): string => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const QUOTED = /["“«]([^"”»]{4,})["”»]/g;

/** plan.exists: el archivo está, tiene entradas y cada entrada trae sus campos (planDefects). */
function planExistsDefects(m: PageMeasure, plan: PagePlanMd | null, checked: SensorReport['checked']): SensorDefect[] {
  checked['plan.exists'] += 1;
  if (!plan) return [defect('plan.exists', '-', m.viewport, 'page-plan.md', 'no está', 'el agente no escribió page-plan.md antes de las secciones')];
  if (!plan.sections.length) return [defect('plan.exists', '-', m.viewport, 'entradas ## NN-<rol>', '0', 'page-plan.md no tiene ninguna entrada de sección que se pueda leer')];
  return planDefects(plan).map((d) => defect('plan.exists', d.slug, m.viewport, 'entrada completa', d.message, `${d.slug}: ${d.message} en page-plan.md`));
}

/** plan.copy, plan.count, plan.surface y plan.detail: el código de cada sección obedece a su entrada (ADR 0012, RF3). */
// HACK: los items del código son la clave de objeto que se repite tantas veces como pide el plan (question ×5). Contar
// el array que recibe la prop de items del bloque cuando el catálogo declare cuál es.
const repeatsKey = (source: string, n: number): boolean => {
  const counts = new Map<string, number>();
  for (const [, k] of source.matchAll(/\b(\w+)\s*:/g)) counts.set(k!, (counts.get(k!) ?? 0) + 1);
  return [...counts.values()].includes(n);
};

function planSectionDefects(m: PageMeasure, plan: PagePlanMd, e: PageExpect, checked: SensorReport['checked']): SensorDefect[] {
  return plan.sections.flatMap((p): SensorDefect[] => {
    const s = m.sections.find((x) => x.key === p.slug);
    if (!s) {
      if (PLAN_FRAME.test(p.role)) return [];
      checked['plan.copy'] += 1;
      return [defect('plan.copy', p.slug, m.viewport, 'sección en la página', 'no está', `${p.slug} está en el plan y no en la página (data-wt-slug)`)];
    }
    const dom = planKey(s.domText ?? s.text);
    const out: SensorDefect[] = [];
    const titular = p.fields.titular?.replace(/^["“«]|["”»]$/g, '');
    // El "titular" de navbar y footer es la marca, que suele ser un logo sin texto ("Acme (wordmark)", gen 999ea0e0).
    if (titular && !PLAN_FRAME.test(p.role)) {
      checked['plan.copy'] += 1;
      if (!dom.includes(planKey(titular))) out.push(defect('plan.copy', p.slug, m.viewport, titular, '(no está en el DOM)', `el titular del plan "${titular}" no aparece en ${p.slug}`));
    }
    const want = planCount(p);
    // HACK: solo cuenta colecciones en grid o flex-wrap; una lista vertical (acordeón de FAQ, pasos apilados) no se
    // afirma. Contar hijos repetidos de cualquier contenedor cuando una sección así salga con un conteo distinto.
    if (want !== undefined && s.collections.length) {
      checked['plan.count'] += 1;
      // Un bloque con variantes que muestran una parte (FAQ columns, tabs) pinta menos de los que recibe: cuenta su código.
      const used = usedBlock(s, e);
      if (!s.collections.some((c) => c.items === want) && !(used && repeatsKey(used.source, want))) out.push(defect('plan.count', p.slug, m.viewport, String(want), s.collections.map((c) => c.items).join('/'), `el plan pide ${p.fields.conteo} y ${p.slug} pinta ${s.collections[0]!.items}`));
    }
    const surface = SURFACES.exec(p.fields.superficie ?? '')?.[1]?.toLowerCase();
    if (surface && s.surface) {
      checked['plan.surface'] += 1;
      const actual = s.surface.declared ?? 'base';
      if (actual !== surface) out.push(defect('plan.surface', p.slug, m.viewport, surface, actual, `el plan pide superficie ${surface} y ${p.slug} declara ${actual}`));
    }
    out.push(...planDetailDefects(m, p, s, dom, checked));
    return out;
  });
}

/** El detalle del plan es una descripción ("chip con el dato al pie"): se afirma lo citado entre comillas como texto y,
 * si no cita nada, que la sección pinte algún soporte (chip, etiqueta con icono o nota). Navbar, footer y FAQ no
 * necesitan soporte (planDefects): ahí solo cuenta lo citado. */
function planDetailDefects(m: PageMeasure, p: PlanSection, s: MeasuredSection, dom: string, checked: SensorReport['checked']): SensorDefect[] {
  const { slug, fields: { detalle } } = p;
  if (!detalle || /^(ninguno|none|nada)\.?$/i.test(detalle)) return [];
  const quoted = [...detalle.matchAll(QUOTED)].map((q) => q[1]!);
  if (quoted.length) {
    checked['plan.detail'] += 1;
    const lost = quoted.filter((q) => !dom.includes(planKey(q)));
    return lost.length ? [defect('plan.detail', slug, m.viewport, lost.join(' · '), '(no está en el DOM)', `el detalle del plan "${lost[0]}" no aparece en ${slug}`)] : [];
  }
  if (!s.support || s.frame || optionalFocal(p)) return [];
  checked['plan.detail'] += 1;
  const n = s.support.chips + s.support.iconLabels + s.support.notes;
  return n ? [] : [defect('plan.detail', slug, m.viewport, detalle, 'sin chip, etiqueta ni nota', `el plan promete "${detalle}" y ${slug} no pinta ningún detalle de soporte`)];
}

// El focal del plan es texto libre ("mockup de conversación", "métricas grandes"); el de la dirección, una palabra.
const FOCAL_WORDS: Record<Focal, RegExp> = {
  foto: /\b(foto|imagen|fotografia)/,
  mockup: /\b(mockup|maqueta|captura|chat|conversacion)/,
  cifra: /\b(cifra|metrica|numero|dato|estadistica|kpi)|%/,
  tabla: /\b(tabla|comparativa|planes)/,
  cita: /\b(cita|testimonio|quote)/,
  iconos: /\b(icono|iconografia)/,
  'acordeón': /\b(acordeon|accordion|desplegable)/,
  logos: /\b(logo|marcas|clientes)/,
  'acción': /\b(accion|boton|cta)/,
  abstracto: /\b(abstract|generativ|shader|degradado|gradiente|textura|patron)/,
};
// El catálogo no tiene `cases`: los casos de éxito son testimonios con cifras. Los slugs en español que el vocabulario
// del brief no cubre a propósito ("preguntas" sola no pide una FAQ) se resuelven aquí, donde sí son un slug.
const SLUG_ROLE: Record<string, string> = { cases: 'testimonials', preguntas: 'faq', cierre: 'cta' };
// HACK: la forma en el DOM se mide solo por la fila más ancha de sus colecciones (3 o más = grilla), porque la medida
// no trae columnas. Medir columnas en page-sensors.browser.js cuando una forma de dos columnas se desvíe sin grilla.
const GRID_FORMS = new Set<string>(['card-grid', 'grid-cards']);
const ONE_ITEM_FORMS = new Set<string>(['split-media', 'single-quote', 'narrow-accordion', 'inline-band']);
// Con Bloque en la fila, la página pinta la forma del bloque elegido (ADR 0011 enmienda 1): la de la dirección si el
// bloque la pinta, que es lo que pickBlock garantiza; si no (un direction.md de otro catálogo), la primera del bloque.
const domFormOf = (form: DirectionRole['form'], block?: BlockCandidate): DirectionRole['form'] => (!block || !block.forms.length || block.forms.includes(form) ? form : block.forms[0]);
export const directionRole = (slug: string): string => { const r = roleOfKey(slug); return SLUG_ROLE[r] ?? SLUG_ROLE[roleOfSlug(slug)] ?? r; };

/** plan.direction: el plan cita la dirección entregada y cada sección lleva su forma, focal y superficie; sin pack,
 * la página pinta el par tipográfico de la dirección. */
function directionDefects(m: PageMeasure, plan: PagePlanMd, want: NonNullable<PageExpect['direction']>, checked: SensorReport['checked']): SensorDefect[] {
  const d = want.direction;
  const out: SensorDefect[] = [];
  const add = (section: string, expected: string, actual: string, message: string) => out.push(defect('plan.direction', section, m.viewport, expected, actual, message));
  checked['plan.direction'] += 1;
  if (plan.direction !== d.id) add('-', d.id, plan.direction ?? '(sin direccion:)', `el plan ${plan.direction ? `cita la dirección ${plan.direction}` : 'no cita la dirección'} y la entregada es ${d.id}`);
  for (const p of plan.sections) {
    const measured = m.sections.find((s) => s.key === p.slug);
    // Manda el rol medido: "casos" puede ser la fila stats de la dirección o sus testimonios (fac2bce5: stats-row).
    const role = measured && Object.hasOwn(d.roles, measured.role) ? measured.role : directionRole(p.slug);
    const r = d.roles[role as keyof Direction['roles']];
    if (!r) continue;
    checked['plan.direction'] += 1;
    const form = fold(p.fields.forma ?? '').replace(/\s+/g, '-');
    if (!form.startsWith(r.form)) add(p.slug, `forma ${r.form}`, p.fields.forma ?? '(sin forma)', `${p.slug}: la dirección ${d.id} pide la forma ${r.form} y el plan dice ${p.fields.forma ?? 'nada'}`);
    if (!FOCAL_WORDS[r.focal].test(fold(p.fields.focal ?? ''))) add(p.slug, `focal ${r.focal}`, p.fields.focal ?? '(sin focal)', `${p.slug}: la dirección ${d.id} pide focal ${r.focal} y el plan dice ${p.fields.focal ?? 'nada'}`);
    const surface = SURFACES.exec(p.fields.superficie ?? '')?.[1]?.toLowerCase();
    if (surface !== r.surface) add(p.slug, `superficie ${r.surface}`, surface ?? '(sin superficie)', `${p.slug}: la dirección ${d.id} pide superficie ${r.surface} y el plan dice ${surface ?? 'nada'}`);
    const widest = Math.max(0, ...(measured?.collections ?? []).flatMap((c) => c.rows));
    const shape = domFormOf(r.form, want.blocks?.[role as keyof typeof d.roles]);
    const domForm = !measured ? null : GRID_FORMS.has(shape) ? widest >= 3 : ONE_ITEM_FORMS.has(shape) ? widest < 3 : null;
    if (domForm === null) continue;
    checked['plan.direction'] += 1;
    if (!domForm) add(p.slug, `forma ${shape} en el DOM`, widest ? `fila de ${widest}` : 'sin colección', `${p.slug}: ${shape === r.form ? `la dirección ${d.id} pide` : 'el bloque pinta'} ${shape} y el DOM ${widest >= 3 ? `pinta una fila de ${widest} tarjetas` : 'no pinta ninguna fila de 3'}`);
  }
  if (!want.brandFonts) {
    const painted = m.fonts.filter((f) => !f.generic && f.loaded && f.count > 0).map((f) => fold(f.family));
    const lost = [d.type.display, d.type.body].filter((f) => !painted.some((x) => x.startsWith(fold(f))));
    if (lost.length) add('-', `${d.type.display} + ${d.type.body}`, m.fonts.filter((f) => !f.generic).map((f) => f.family).join(', ') || '(ninguna)', `la dirección ${d.id} pide ${d.type.display} y ${d.type.body}; la página no pinta ${lost.join(' ni ')}`);
  }
  return out;
}

/** Una medida por viewport; lang, fuentes y motion se afirman sobre el primero (el ancho de escritorio). */
export function pageSensors(measures: readonly PageMeasure[], e: PageExpect = {}, emitted: readonly EmittedSection[] = []): SensorReport {
  const checked = Object.fromEntries(Object.keys(FIELD_OWNER).map((k) => [k, 0])) as SensorReport['checked'];
  const defects: SensorDefect[] = [];
  measures.forEach((m, i) => {
    defects.push(...collectionDefects(m, checked), ...alignDefects(m, e, checked), ...gutterDefects(m, e, checked), ...contractDefects(m, checked), ...overflowDefects(m, checked));
    if (i > 0) return;
    defects.push(...langDefects(m, expectedLang(m, e), checked), ...titleDefects(m, checked), ...fontDefects(m, checked), ...motionDefects(m, e.motionBudget ?? DEFAULT_MOTION_BUDGET, checked), ...iconDefects(m, checked), ...detailDefects(m, checked), ...emittedDefects(m, emitted, checked), ...imageDefects(m, e.pendingImages ?? [], checked), ...buttonDefects(m, checked), ...portraitDefects(m, checked));
    if (e.plan !== undefined) defects.push(...planExistsDefects(m, e.plan, checked), ...(e.plan ? planSectionDefects(m, e.plan, e, checked) : []));
    if (e.plan && e.direction) defects.push(...directionDefects(m, e.plan, e.direction, checked));
  });
  return { checked, defects };
}
