// Valor de slot serializable (spec composicion-slots, RF6). Un slot ReactNode lleno viaja en los props
// como JSON determinista `{ "$component": "<slug>", "props"?: {…}, "children"?: "texto" }` y solo
// renderApp lo vuelve JSX. El slug se resuelve ÚNICAMENTE contra el índice (export + importPath): un
// slug desconocido es error de emit, nunca un import libre. Los props van como un único spread de
// JSON y el texto como expresión `{JSON}`: nada del brief se interpola como código.

import { importLine, type ModuleExport } from './import-line';

export interface SlotComponentValue {
  $component: string;
  props?: Record<string, unknown>;
  children?: string;
}

export type SlotComponentRef = ModuleExport;

/** Resuelve un slug del índice a su export e importPath; undefined si no existe. */
export type ComponentResolver = (slug: string) => SlotComponentRef | undefined;

export interface SlotRender {
  /** Expresión TS/JSX con el mismo formato que JSON.stringify(props, null, 2) salvo en los slots. */
  code: string;
  /** Líneas `import { X } from '…';` únicas, en orden de aparición. */
  imports: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isSlotValue = (v: unknown): v is SlotComponentValue => isRecord(v) && typeof v.$component === 'string';

/** ¿Hay algún `$component` en el árbol? Sin ninguno, los props se serializan como JSON byte a byte. */
export function hasSlotValue(v: unknown): boolean {
  if (isSlotValue(v)) return true;
  if (Array.isArray(v)) return v.some(hasSlotValue);
  if (isRecord(v)) return Object.values(v).some(hasSlotValue);
  return false;
}

/** Slugs de componente referenciados en el árbol (para materializarlos antes de emitir). */
export function slotSlugsOf(v: unknown): string[] {
  if (isSlotValue(v)) return [v.$component, ...slotSlugsOf(v.props)];
  if (Array.isArray(v)) return [...new Set(v.flatMap(slotSlugsOf))];
  if (isRecord(v)) return [...new Set(Object.values(v).flatMap(slotSlugsOf))];
  return [];
}

// El export es un identificador JSX y el path va entre comillas simples: aunque vengan del índice
// (validado al cargar), un valor fuera de forma aquí sería código inyectado en App.tsx.
const IDENT = /^[A-Za-z_$][\w$]*$/;
const SAFE_PATH = /^[\w@./-]+$/;

function resolveRef(slug: string, resolve: ComponentResolver): SlotComponentRef {
  const ref = resolve(slug);
  if (!ref) throw new Error(`slot: componente "${slug}" fuera del índice`);
  if (!IDENT.test(ref.export)) throw new Error(`slot: export inválido para "${slug}": ${ref.export}`);
  if (!SAFE_PATH.test(ref.importPath)) throw new Error(`slot: importPath inválido para "${slug}": ${ref.importPath}`);
  return ref;
}

function renderElement(v: SlotComponentValue, resolve: ComponentResolver, imports: Set<string>): string {
  const ref = resolveRef(v.$component, resolve);
  const name = ref.export;
  imports.add(importLine(ref));
  if (v.props !== undefined && !isRecord(v.props)) throw new Error(`slot: props de "${v.$component}" no es un objeto`);
  if (v.children !== undefined && typeof v.children !== 'string') throw new Error(`slot: children de "${v.$component}" no es texto`);
  const spread = v.props && Object.keys(v.props).length ? ` {...${renderNode(v.props, resolve, imports, '', '')}}` : '';
  return v.children === undefined ? `<${name}${spread} />` : `<${name}${spread}>{${JSON.stringify(v.children)}}</${name}>`;
}

/** Imprime como JSON.stringify(v, null, step) (step '' = compacto) sustituyendo los slots por JSX. */
function renderNode(v: unknown, resolve: ComponentResolver, imports: Set<string>, indent: string, step: string): string {
  if (isSlotValue(v)) return renderElement(v, resolve, imports);
  const inner = indent + step;
  const nl = step ? '\n' : '';
  const sep = step ? ': ' : ':';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${nl}${v.map((it) => inner + renderNode(it, resolve, imports, inner, step)).join(`,${nl}`)}${nl}${indent}]`;
  }
  if (isRecord(v)) {
    const entries = Object.entries(v).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return '{}';
    return `{${nl}${entries.map(([k, val]) => `${inner}${JSON.stringify(k)}${sep}${renderNode(val, resolve, imports, inner, step)}`).join(`,${nl}`)}${nl}${indent}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Props de un bloque como expresión de App.tsx. Sin slots devuelve JSON.stringify(props, null, 2)
 * sin cambios; con slots, el mismo formato con cada `$component` como elemento JSX. */
export function renderSlotProps(props: Record<string, unknown>, resolve: ComponentResolver): SlotRender {
  if (!hasSlotValue(props)) return { code: JSON.stringify(props, null, 2), imports: [] };
  const imports = new Set<string>();
  const code = renderNode(props, resolve, imports, '', '  ');
  return { code, imports: [...imports] };
}
