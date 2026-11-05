// Modelo de página y normalización. El runner del modo v0 (composición → TSX → workspace) se retiró con C5
// (decisión 5 de Karen, 2026-11-05): todo compose pasa por el agente, que escribe los archivos en el workspace.
// Lo que queda aquí es el tipo de la página (page.json de cada versión) y normalizePage, que el transport usa antes
// de guardarla. La forma del árbol de layout vive en ./layout; la validación, en el check_layout del agente.

import type { AgentPageInfo } from './agent-composer';
import type { AllowEntry } from '../ds-skill';
import type { IconLibrary } from '../ds-skill-icons';
import { isSlotValue } from '../catalog/slot-value';
import type { EventLog } from './events';
import { isComponentNode, isLayoutNode, isSlot, type LayoutChild, type LayoutSection } from './layout';
import type { DsLayoutPolicy } from './layout-check';
import type { PageDoc } from './page-doc';
import type { BrandPack } from '../brand';
import type { RegistryItem } from './registry';
import type { ExtensionPoints } from '../extension-points';
import type { SchemaStore } from './verify';

// `parts` es ComposedPage de compose.ts (legado, se lee como una secuencia); `children` es el árbol
// de layout. Estructural para no acoplar el modelo al agente.
export interface RunnerPart {
  component: string;
  props?: Record<string, unknown>;
}
export type RunnerSection = Omit<LayoutSection, 'children'> & { parts?: RunnerPart[]; children?: LayoutChild[] };
export interface PageModel {
  /** Estado de página (PageContract, ADR 0008): viaja en page.json de cada versión. */
  page?: PageDoc;
  sections: RunnerSection[];
  /** ADR 0011: el agente escribió los archivos de la página en el workspace. */
  agent?: AgentPageInfo;
}

export type Allowlist = Record<string, AllowEntry>;

type Theme = 'light' | 'dark';

/** Lo que el workspace necesita para validar y resolver, además de la allowlist. Sin schemas, el check
 * de layout es estructural (verify no valida tipos de props que no puede ver). */
export interface Resolve {
  schemas?: SchemaStore;
  icons?: IconLibrary;
  /** Política de maquetación del DS (v0.json del skill): la misma que aplica layout-check al componer. */
  layout?: DsLayoutPolicy;
  /** Tema del documento (`data-theme` de index.html); una sección inverse toma el contrario. */
  rootTheme?: Theme;
}

/** Config del workspace del agente (RuntimeOptions la extiende): scaffold, starter, marca, vault y registry. */
export interface WorkspaceOptions extends Resolve {
  scaffoldDir: string;
  /** assets/starter del DS-skill: se copia ENCIMA del scaffold (como el starter de v0). */
  starterDir?: string;
  /** Brand pack a aplicar una vez al crear el workspace (identity.css, fuentes, data-accent), como el
   * v0.json que v0 aplica en "Set up environment". Sin él el agente declara la identidad en identity.css (#212). */
  brandDir?: string;
  vaultRoot: string;
  /** Items ya resueltos del registry. Presentes = el código sale de ahí y nunca del vault. */
  items?: readonly RegistryItem[];
  /** Ranuras de marca del pin de `items`; sin ellas los <componente>.brand.ts quedan como los trae el registry. */
  extensionPoints?: ExtensionPoints;
  /** Marca ya aplicada al workspace por quien llama: sus variantes van a los tipos de cada componente. */
  brand?: BrandPack;
  /** false = los componentes ya están en el workspace: sin paso de fetch. */
  fetch?: boolean;
  /** Log del mensaje en curso (events.ts). El ciclo de vida del mensaje es de quien llama. */
  log?: EventLog;
}

/** El modelo a veces pone `children` al nivel del nodo, como en el formato legado de slot (legacySlot), y no
 * dentro de props. El emisor y la validación solo leen props, así que se perdía en silencio (los botones
 * vacíos de pricing en 8ae26d51). Se lleva a props.children antes de validar; si props ya trae children,
 * se deja donde está y la validación lo rechaza como clave desconocida. */
export function normalizePage(page: PageModel): PageModel {
  return { ...page, sections: page.sections.map((s) => ({ ...s, ...(s.children ? { children: s.children.map(normalizeChild) as LayoutChild[] } : {}), ...(s.parts ? { parts: s.parts.map(normalizeChild) as RunnerPart[] } : {}) })) };
}

function normalizeChild(n: unknown): unknown {
  if (isLayoutNode(n as LayoutChild)) return { ...(n as object), children: (n as { children: unknown[] }).children.map(normalizeChild) };
  if (!isComponentNode(n)) return n;
  const { props, children, ...rest } = n as unknown as Record<string, unknown> & { props?: Record<string, unknown> };
  const lift = children !== undefined && props?.children === undefined;
  const merged = lift ? { ...(props ?? {}), children } : props;
  return { ...rest, ...(merged ? { props: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, normalizeValue(v)])) } : {}), ...(children !== undefined && !lift ? { children } : {}) };
}

function normalizeValue(v: unknown): unknown {
  if (isSlot(v)) return { ...v, $slot: Array.isArray(v.$slot) ? v.$slot.map(normalizeChild) : normalizeChild(v.$slot) };
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (typeof v === 'object' && v !== null && !isSlotValue(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeValue(x)]));
  return v;
}
