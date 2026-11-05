// check_layout: valida el árbol de layout del modo v0 (contrato de src/runtime/layout.ts, M-LAYOUT) antes de
// que el runner lo traduzca a TSX. La entrada es salida del modelo, así que se recibe como `unknown` y
// se valida forma por forma; los props de cada componente pasan por verifySection, la misma
// verificación que las secciones `parts[]`, para no tener dos criterios de "prop válido".

import type { AllowEntry } from '../ds-skill';
import { ICON_PREFIX, resolveIcon, type IconLibrary } from '../ds-skill-icons';
import { verifySection, type SchemaStore, type ViolationCode } from './verify';
import { hrefViolations, type HrefPolicy } from './href-check';
import type { LayoutSection } from './layout';

export const SPACES = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
export const ALIGNS = ['start', 'center', 'end', 'stretch'] as const;
export const COLS = [1, 2, 3, 4, 6] as const;
export const JUSTIFY = ['start', 'center', 'end', 'between'] as const;
export const RATIOS = ['1:1', '1:2', '2:1'] as const;
export const TEXT_ROLES = ['display', 'title', 'subtitle', 'body', 'caption'] as const;
export const TEXT_ALIGNS = ['start', 'center'] as const;
export const WIDTHS = ['prose', 'content', 'wide', 'full'] as const;
export const SURFACES = ['base', 'muted', 'raised'] as const;
export const PADDINGS = ['none', 'sm', 'md', 'lg'] as const;
const LAYOUTS = ['stack', 'grid', 'cluster', 'split'] as const;

export type LayoutCode =
  | 'empty-layout'
  | 'unknown-node'
  | 'block-not-alone'
  | 'block-nested'
  | 'bad-enum'
  | 'split-arity'
  | 'slot-not-accepted'
  | 'empty-text'
  | 'href-unresolved'
  | 'unknown-asset'
  | 'stray-key';

export interface LayoutViolation {
  /** Ruta dentro de la sección: `children[0].children[1].props.action.$slot`. */
  path: string;
  component: string;
  code: ViolationCode | LayoutCode;
  detail: string;
}

export interface LayoutVerdict {
  ok: boolean;
  violations: LayoutViolation[];
  /** Mensaje para el reintento del modelo. Vacío si ok. */
  feedback: string;
  /** Corrección determinista que deja la sección válida sin otro infer (hoy: quitar iconos inexistentes). */
  fix?: { section: LayoutSection };
}

interface Ctx {
  allow: Record<string, AllowEntry>;
  schemas: SchemaStore;
  icons?: IconLibrary;
  /** Assets del paso de imagen. Ausente = revalidación del runner, donde la imagen ya llega resuelta. */
  assets?: ReadonlySet<string>;
  out: LayoutViolation[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const isSlot = (v: unknown): v is { $slot: unknown } => isObj(v) && '$slot' in v;

function enumField(n: Obj, key: string, allowed: readonly unknown[], path: string, ctx: Ctx, required = false): void {
  const v = n[key];
  if (v === undefined && !required) return;
  if (!allowed.includes(v as never)) ctx.out.push({ path: at(path, key), component: '-', code: 'bad-enum', detail: `${JSON.stringify(v)} no está en ${JSON.stringify(allowed)}` });
}

function colsField(n: Obj, path: string, ctx: Ctx): void {
  const c = n.cols;
  if (isObj(c)) {
    if (c.base === undefined) ctx.out.push({ path: `${path}.cols.base`, component: '-', code: 'bad-enum', detail: 'cols responsivo necesita base' });
    for (const [bp, v] of Object.entries(c)) {
      if (!['base', 'md', 'lg'].includes(bp)) ctx.out.push({ path: `${path}.cols.${bp}`, component: '-', code: 'bad-enum', detail: `breakpoint ${bp} no existe (base|md|lg)` });
      else if (!COLS.includes(v as never)) ctx.out.push({ path: `${path}.cols.${bp}`, component: '-', code: 'bad-enum', detail: `${JSON.stringify(v)} no está en ${JSON.stringify(COLS)}` });
    }
    return;
  }
  enumField(n, 'cols', COLS, path, ctx, true);
}

/** Quita los `$slot` que no cuelgan de un prop `accepts` (y los reporta) para que verifySection valide
 * el resto de los datos sin tropezar con un nodo que no es suyo. */
function stripStraySlots(v: unknown, path: string, component: string, ctx: Ctx): unknown {
  if (isSlot(v)) {
    ctx.out.push({ path, component, code: 'slot-not-accepted', detail: 'un nodo solo puede ir en un prop que acepta JSX (accepts)' });
    return undefined;
  }
  if (Array.isArray(v)) return v.map((x, i) => stripStraySlots(x, `${path}[${i}]`, component, ctx)).filter((x) => x !== undefined);
  if (isObj(v)) {
    return Object.fromEntries(
      Object.entries(v)
        .map(([k, x]) => [k, stripStraySlots(x, `${path}.${k}`, component, ctx)] as const)
        .filter(([, x]) => x !== undefined),
    );
  }
  return v;
}

const COMPONENT_NODE_KEYS = new Set(['component', 'props']);

function checkComponent(n: Obj, path: string, atRoot: boolean, ctx: Ctx): void {
  const slug = n.component as string;
  const entry = ctx.allow[slug];
  if (entry?.kind === 'block' && !atRoot) {
    ctx.out.push({ path, component: slug, code: 'block-nested', detail: 'un block trae su propio contenedor: solo puede ser el único hijo directo de la sección' });
  }
  // El runner no escribe un nodo con claves fuera de component/props (COMPONENT_KEYS): mismo criterio aquí, antes.
  for (const k of Object.keys(n)) if (!COMPONENT_NODE_KEYS.has(k)) ctx.out.push({ path: `${path}.${k}`, component: slug, code: 'stray-key', detail: `"${k}" va dentro de props (o, si es provenance, a nivel de sección)` });
  const raw = isObj(n.props) ? n.props : {};
  const accepts = new Set(entry?.accepts.map((a) => a.prop) ?? []);
  const props: Obj = {};
  const slotted = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (isSlot(v) && accepts.has(k)) {
      slotted.add(k);
      const inner = v.$slot;
      const nodes = Array.isArray(inner) ? inner : [inner];
      if (!nodes.length) ctx.out.push({ path: `${path}.props.${k}.$slot`, component: slug, code: 'empty-layout', detail: 'slot vacío' });
      nodes.forEach((c, i) => checkChild(c, Array.isArray(inner) ? `${path}.props.${k}.$slot[${i}]` : `${path}.props.${k}.$slot`, false, ctx));
      continue;
    }
    const kept = stripStraySlots(v, `${path}.props.${k}`, slug, ctx);
    if (kept !== undefined) props[k] = kept;
  }
  const verdict = verifySection({ role: '-', parts: [{ component: slug, props }] }, ctx.allow, ctx.schemas, ctx.icons);
  for (const v of verdict.violations) {
    const rel = v.path.replace(/^parts\[0\]/, '');
    // El prop se llenó con un slot que ya se validó arriba; verify solo vio que faltaba.
    if (v.code === 'missing-required' && slotted.has(v.detail)) continue;
    ctx.out.push({ ...v, path: `${path}${rel}` });
  }
}

function checkChild(n: unknown, path: string, atRoot: boolean, ctx: Ctx): void {
  if (!isObj(n)) {
    ctx.out.push({ path, component: '-', code: 'unknown-node', detail: 'se esperaba un nodo layout, text o component' });
    return;
  }
  if (typeof n.layout === 'string') {
    if (!LAYOUTS.includes(n.layout as never)) {
      ctx.out.push({ path: `${path}.layout`, component: '-', code: 'bad-enum', detail: `${JSON.stringify(n.layout)} no está en ${JSON.stringify(LAYOUTS)}` });
      return;
    }
    enumField(n, 'gap', SPACES, path, ctx);
    enumField(n, 'align', ALIGNS, path, ctx);
    if (n.layout === 'grid') colsField(n, path, ctx);
    if (n.layout === 'cluster') enumField(n, 'justify', JUSTIFY, path, ctx);
    if (n.layout === 'split') enumField(n, 'ratio', RATIOS, path, ctx);
    const kids = Array.isArray(n.children) ? n.children : [];
    if (n.layout === 'split' && kids.length !== 2) ctx.out.push({ path: `${path}.children`, component: '-', code: 'split-arity', detail: `split lleva exactamente 2 hijos, llegaron ${kids.length}` });
    else if (!kids.length) ctx.out.push({ path: `${path}.children`, component: '-', code: 'empty-layout', detail: `${n.layout} sin hijos` });
    kids.forEach((c, i) => checkChild(c, `${path}.children[${i}]`, false, ctx));
    return;
  }
  if (typeof n.text === 'string') {
    enumField(n, 'text', TEXT_ROLES, path, ctx, true);
    enumField(n, 'align', TEXT_ALIGNS, path, ctx);
    if (typeof n.value !== 'string' || !n.value.trim()) ctx.out.push({ path: `${path}.value`, component: '-', code: 'empty-text', detail: 'texto sin value' });
    return;
  }
  if (typeof n.component === 'string') {
    checkComponent(n, path, atRoot, ctx);
    return;
  }
  if (typeof n.image === 'string') {
    if (!knownImage(n, ctx.assets)) ctx.out.push({ path, component: '-', code: 'unknown-asset', detail: `"${n.image}" no es un asset generado para esta página` });
    return;
  }
  ctx.out.push({ path, component: '-', code: 'unknown-node', detail: 'se esperaba un nodo layout, text o component' });
}

function feedbackOf(role: string, violations: LayoutViolation[]): string {
  if (!violations.length) return '';
  const lines = violations.map((v) => `- ${v.path} (${v.component}): ${v.code}: ${v.detail}`);
  return `El layout de la sección "${role}" no pasó la verificación. Corrige SOLO esto y devuelve la sección completa otra vez:\n${lines.join('\n')}\nUsa solo los nodos stack/grid/cluster/split, text y componentes del índice; un block va solo, como único hijo de la sección.`;
}

/** Valida una sección del modo v0 con layout. Una sección legada (`parts[]`, sin `children`) se lee
 * como un stack implícito, igual que el runner. */
export function checkLayout(section: unknown, allowlist: Record<string, AllowEntry>, schemas: SchemaStore, icons?: IconLibrary, hrefPolicy?: HrefPolicy, assets?: readonly string[]): LayoutVerdict {
  const ctx: Ctx = { allow: allowlist, schemas, icons, ...(assets ? { assets: new Set(assets) } : {}), out: [] };
  const s = isObj(section) ? section : {};
  const role = typeof s.role === 'string' ? s.role : '?';
  const legacy = !Array.isArray(s.children) && Array.isArray(s.parts);
  const children: unknown[] = Array.isArray(s.children) ? s.children : legacy ? (s.parts as unknown[]) : [];
  const key = legacy ? 'parts' : 'children';
  if (!children.length) {
    ctx.out.push({ path: key, component: '-', code: 'empty-section', detail: `la sección ${role} volvió sin hijos` });
    return { ok: false, violations: ctx.out, feedback: feedbackOf(role, ctx.out) };
  }
  enumField(s, 'width', WIDTHS, '', ctx);
  enumField(s, 'surface', SURFACES, '', ctx);
  enumField(s, 'padding', PADDINGS, '', ctx);
  const isBlock = (c: unknown): boolean => isObj(c) && typeof c.component === 'string' && allowlist[c.component]?.kind === 'block';
  if (children.length > 1) {
    children.forEach((c, i) => {
      if (isBlock(c)) ctx.out.push({ path: `${key}[${i}]`, component: (c as Obj).component as string, code: 'block-not-alone', detail: 'un block solo puede ser el único hijo de la sección' });
    });
  }
  children.forEach((c, i) => checkChild(c, `${key}[${i}]`, true, ctx));
  // Hrefs (brecha #5): con la política de la página, un href que no es ancla de la página, ruta legal,
  // destino externo ni el placeholder `#` es un link roto y se rebota. El `#` no entra aquí.
  if (hrefPolicy) {
    for (const v of hrefViolations(section, hrefPolicy)) ctx.out.push({ path: v.path, component: '-', code: 'href-unresolved', detail: v.detail });
  }
  const verdict: LayoutVerdict = { ok: !ctx.out.length, violations: ctx.out, feedback: feedbackOf(role, ctx.out) };
  // Un icono o una imagen inventados no justifican otro infer de la sección: se quitan, y si lo demás
  // valida, ese es el fix.
  if (ctx.out.length && ctx.out.every((v) => v.code === 'unknown-icon' || v.code === 'unknown-asset')) {
    const fixed = stripUnknownNodes(section, { icons, assets: ctx.assets });
    if (checkLayout(fixed, allowlist, schemas, icons, hrefPolicy, assets).ok) verdict.fix = { section: fixed as LayoutSection };
  }
  return verdict;
}

/** Alias con el nombre que usa el runner de M-LAYOUT. */
export const layoutErrors = (section: unknown, allowlist: Record<string, AllowEntry>, schemas: SchemaStore, icons?: IconLibrary): LayoutViolation[] =>
  checkLayout(section, allowlist, schemas, icons).violations;

/** Política de maquetación que fija el DS (v0.json del skill), no el modelo. */
export interface DsLayoutPolicy {
  /** Alineación de la cabecera de cada sección de árbol (titular y bajada). */
  sectionHeaderAlign?: (typeof TEXT_ALIGNS)[number];
  /** Paleta corta de iconos (`<set>/<Nombre>`, ya verificados contra icons.json) que el modelo ve al maquetar. */
  icons?: readonly string[];
}

const isTextOnlyStack = (n: Obj): boolean =>
  n.layout === 'stack' && Array.isArray(n.children) && n.children.length > 0 && n.children.every((c) => isObj(c) && typeof c.text === 'string');

type TextAlign = NonNullable<DsLayoutPolicy['sectionHeaderAlign']>;

function alignText(n: Obj, align: TextAlign): Obj {
  return typeof n.text === 'string' ? { ...n, align } : { ...n, align, children: (n.children as Obj[]).map((c) => ({ ...c, align })) };
}

/** La cabecera son los textos (o stacks de solo texto) con los que ABRE la sección, antes del primer
 * nodo que no lo es; si la sección abre con un stack contenedor, la cabecera se busca dentro de él. */
function alignHeader(nodes: unknown[], align: TextAlign): unknown[] {
  const out = [...nodes];
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (!isObj(n)) break;
    if (typeof n.text === 'string' || isTextOnlyStack(n)) { out[i] = alignText(n, align); continue; }
    if (i === 0 && n.layout === 'stack' && Array.isArray(n.children)) out[i] = { ...n, children: alignHeader(n.children, align) };
    break;
  }
  return out;
}

/** Autocorrección de check_layout: sin criterio, el modelo centra las cabeceras de las secciones de
 * árbol (0/4 a la izquierda en 817da32c, v0 10/10), así que la alineación la fija el DS y se aplica sin
 * reintento. Solo toca la cabecera; el cuerpo (grids de items) y el interior de los componentes quedan
 * como el modelo los maquetó. */
export function applyHeaderAlign<T>(section: T, policy?: DsLayoutPolicy): T {
  const align = policy?.sectionHeaderAlign;
  if (!align || !isObj(section) || !Array.isArray(section.children)) return section;
  return { ...section, children: alignHeader(section.children, align) } as T;
}

interface Known {
  icons?: IconLibrary;
  assets?: ReadonlySet<string>;
}

/** Al componer, una imagen vale solo si su id es un asset del paso (el modelo no puede citar otra). En la
 * revalidación del runner ya no hay lista: vale la que el motor resolvió a un archivo local. */
const knownImage = (n: Obj, assets?: ReadonlySet<string>): boolean =>
  assets ? assets.has(n.image as string) : typeof n.src === 'string' && n.src.startsWith('/images/');

const isUnknown = (n: unknown, k: Known): boolean =>
  isObj(n) && ((typeof n.component === 'string' && n.component.startsWith(ICON_PREFIX) && !(k.icons && resolveIcon(k.icons, n.component.slice(ICON_PREFIX.length))))
    || (typeof n.image === 'string' && !knownImage(n, k.assets)));

function stripNodes(nodes: unknown[], k: Known): unknown[] {
  return nodes.filter((n) => !isUnknown(n, k)).map((n) => stripNode(n, k));
}

function stripNode(n: unknown, k: Known): unknown {
  if (!isObj(n)) return n;
  if (typeof n.layout === 'string' && Array.isArray(n.children)) return { ...n, children: stripNodes(n.children, k) };
  if (typeof n.component !== 'string' || !isObj(n.props)) return n;
  const props: Obj = {};
  for (const [prop, v] of Object.entries(n.props)) {
    if (!isSlot(v)) { props[prop] = v; continue; }
    const kept = stripNodes(Array.isArray(v.$slot) ? v.$slot : [v.$slot], k);
    // Un slot que solo traía el nodo inexistente se va entero: un slot vacío es otra violación.
    if (kept.length) props[prop] = { $slot: Array.isArray(v.$slot) ? kept : kept[0] };
  }
  return { ...n, props };
}

/** Quita los iconos que la librería no tiene y las imágenes que no son assets de la página, en layouts y
 * dentro de slots. Puro. */
export function stripUnknownNodes<T>(section: T, known: Known): T {
  if (!isObj(section) || !Array.isArray(section.children)) return section;
  return { ...section, children: stripNodes(section.children, known) } as T;
}
