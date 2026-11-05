// Contrato del lenguaje de layout del modo v0. v0 escribe el TSX de cada sección (VERIFIED:
// components/sections/*): maqueta alrededor de componentes del DS que no toca. Aquí el agente emite
// un árbol acotado y el runner lo traduce a ese TSX. Layout sí: orden, grid, stack, espaciado,
// contenedor y fondo de la sección, siempre por token. Interior del componente no: un componente
// solo se nombra por slug y recibe props; en los props que la allowlist marca como slot (`accepts`)
// puede recibir otros nodos.

/** Escala de espaciado; el runner la mapea a var(--space-*) de foundation.css, así el brandpack la repinta. */
export type Space = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Cols = 1 | 2 | 3 | 4 | 6;
/** Un valor fijo, o uno por breakpoint (mobile-first). */
export type Responsive<T> = T | { base: T; md?: T; lg?: T };

/** Columna vertical. */
export interface StackNode {
  layout: 'stack';
  gap?: Space;
  align?: Align;
  children: LayoutChild[];
}
/** Rejilla de columnas iguales. */
export interface GridNode {
  layout: 'grid';
  cols: Responsive<Cols>;
  gap?: Space;
  align?: Align;
  children: LayoutChild[];
}
/** Fila que se envuelve: grupos de botones, badges, logos. */
export interface ClusterNode {
  layout: 'cluster';
  gap?: Space;
  justify?: 'start' | 'center' | 'end' | 'between';
  align?: Align;
  children: LayoutChild[];
}
/** Dos columnas desiguales que se apilan en mobile: texto + visual. */
export interface SplitNode {
  layout: 'split';
  ratio?: '1:1' | '1:2' | '2:1';
  gap?: Space;
  align?: Align;
  children: [LayoutChild, LayoutChild];
}
export type LayoutNode = StackNode | GridNode | ClusterNode | SplitNode;

/** Texto de página (titular, bajada). Arc no trae un componente de tipografía; el rol mapea a
 * --font-display / --text-* para que la tipografía también venga del token. */
export interface TextNode {
  text: 'display' | 'title' | 'subtitle' | 'body' | 'caption';
  value: string;
  align?: 'start' | 'center';
}

/** Imagen de la página. El modelo solo escribe `image` (el id de un asset que generó el paso de imagen
 * del motor); src, alt y tamaño los pone el motor desde el asset, así el modelo no puede citar una URL. */
export interface ImageNode {
  image: string;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
}

/** Asset generado por el paso de imagen, antes de escribirse en public/images. */
export interface PageAsset {
  id: string;
  /** Nombre semántico del archivo (p. ej. `nimbus-dashboard.png`). */
  file: string;
  alt: string;
  width: number;
  height: number;
  mediaType: string;
  /** Bytes en base64; el transport los escribe a public/images y los quita de la página. */
  base64?: string;
  /** Prompt con el que se generó: sin él una imagen borrosa no se puede atribuir al plan o al proveedor. */
  prompt?: string;
}

/** Un nodo dentro de un prop slot. Envoltura explícita para no confundirlo con datos (los `items`
 * de un accordion también son objetos). Solo válido en props listados en `accepts`. */
export interface SlotValue {
  $slot: LayoutChild | LayoutChild[];
}
export type PropValue = string | number | boolean | null | PropValue[] | { [k: string]: PropValue } | SlotValue;

/** Un componente de la allowlist por su slug exacto. */
export interface ComponentNode {
  component: string;
  props?: Record<string, PropValue>;
}

/** Lo que va dentro de un layout o de un slot: nunca un `kind: 'block'`, que trae su propio
 * contenedor y padding de sección. */
export type LayoutChild = LayoutNode | TextNode | ComponentNode | ImageNode;

export interface LayoutSection {
  role: string;
  /** Ancho del contenedor de la sección. */
  width?: 'prose' | 'content' | 'wide' | 'full';
  /** Fondo por token: base = --background, muted = --surface-muted, raised = --surface-raised. */
  surface?: 'base' | 'muted' | 'raised';
  /** Padding vertical de la sección. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hijos directos. Un block solo puede ir aquí, como único hijo, y entonces width/surface/padding
   * se ignoran porque el block los trae. */
  children: LayoutChild[] | [ComponentNode];
  /** Props inventados (no venidos del brief): ruta del árbol → los hechos que afirma ese texto
   * (`claims[]`: cifra, persona, empresa, precio, fecha, cliente). No se renderiza; el builder lo lee
   * para listar qué confirmar, e ignora las rutas que no resuelven contra el árbol. */
  provenance?: Record<string, { claims?: string[] }>;
}

/** Página del modo v0 con layout. `parts[]` (ComposedPage de compose.ts) se sigue aceptando y el
 * runner lo lee como un stack. */
export interface LayoutPage {
  sections: LayoutSection[];
  assets?: PageAsset[];
}

export const SPACE_TOKEN: Record<Space, string> = {
  none: '0',
  xs: 'var(--space-2)',
  sm: 'var(--space-3)',
  md: 'var(--space-4)',
  lg: 'var(--space-6)',
  xl: 'var(--space-10)',
  '2xl': 'var(--space-16)',
};

export const isLayoutNode = (n: unknown): n is LayoutNode =>
  typeof n === 'object' && n !== null && typeof (n as { layout?: unknown }).layout === 'string';
export const isTextNode = (n: unknown): n is TextNode =>
  typeof n === 'object' && n !== null && typeof (n as { text?: unknown }).text === 'string';
export const isImageNode = (n: unknown): n is ImageNode =>
  typeof n === 'object' && n !== null && typeof (n as { image?: unknown }).image === 'string';
export const isComponentNode = (n: unknown): n is ComponentNode =>
  typeof n === 'object' && n !== null && typeof (n as { component?: unknown }).component === 'string';
export const isSlot = (v: unknown): v is SlotValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && '$slot' in v;

/** id del ancla de cada sección, en orden: el rol en kebab-case y, si se repite, `<rol>-2`, `<rol>-3`.
 * Una sola fuente para el runner (que lo escribe) y el composer (que da la lista de anclas válidas a
 * los href del nav y el footer): si cada uno lo calculara, un `#features` podría no resolver. */
export function sectionIds(roles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return roles.map((role) => {
    const base = role.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** Roles que van fuera de <main> como landmarks propios (banner arriba, contentinfo abajo). */
export const LANDMARK_BEFORE_MAIN: ReadonlySet<string> = new Set(['navbar']);
export const LANDMARK_AFTER_MAIN: ReadonlySet<string> = new Set(['footer']);
