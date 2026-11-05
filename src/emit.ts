// Emit: toma el PageResult del finding y una librería (adaptador), copia el template scaffold a
// generated/<brief>/ y GENERA src/App.tsx desde la selección. Escribe SOLO en generated/ — nunca
// pisa app-arc ni ningún archivo de propiedad humana (recomendación B del brief aprobado).
// v1: los bloques se renderizan con sus defaults; copy, imágenes y marca son pasada 2 y el reporte
// los marca como hueco (no se compone copy a mano presentándolo como generado).
// Dos capas (ADR 0001, RF13): un strip resuelto por composeLayers se emite como
// <Layout {...props}><Inner {...innerProps} /></Layout> dentro del MISMO scaffold.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LibraryAdapter } from './adapters/types';
import type { Layer, LayeredPage } from './compose-layers';
import type { RoleCopy } from './copy';
import { applyBrand, activeBrandDir, writeBrandVariants } from './brand';
import { workspaceExtensionPoints } from './brand-components';
import { consumedRoles, unsetOmits } from './catalog/slot-policy';
import { renderSlotProps, slotSlugsOf, type ComponentResolver } from './catalog/slot-value';
import { fillImages } from './images';
import type { PageResult } from './select';
import type { Role, Selection } from './types';
import { RENDER_INPUT, type RenderInputBlock } from './render-gate';
import { importLine } from './catalog/import-line';

const REPO_ROOT = new URL('../', import.meta.url);

/** Props emitidos por bloque, junto a la app: la entrada del render-gate (`scripts/render-gate.ts`). */
export const renderInputOf = (blocks: RenderBlock[]): RenderInputBlock[] =>
  blocks.map((b) => ({ role: b.role, slug: b.slug, props: b.props ?? {}, ...(b.inner ? { inner: { slug: b.inner.slug, props: b.inner.props ?? {} } } : {}) }));

export interface EmitBlock {
  role: string;
  slug: string;
  export: string;
  /** Slug + export del inner cuando el bloque es un layout de dos capas. */
  inner?: { slug: string; export: string };
}

/** Un rol planificado que no llegó a la página, y por qué: el router no tuvo candidato, o el copy no
 * trae ese rol (spec politica-slots-visibles, D3). */
export interface OmittedRole {
  role: string;
  reason: 'sin candidato' | 'sin copy' | 'consumido';
  /** Solo `consumido`: slug del bloque cuyo slot ya pinta el dato de ese rol. */
  by?: string;
}

/** Un bloque emitido con reglas `omit` sin binding: default demo que la política no pudo apagar y que
 * queda a la vista hasta cambiar de bloque o forkearlo (ADR 0005). */
export interface DemoVisible {
  slug: string;
  props: string[];
}

export interface EmitReport {
  dir: string;
  library: string;
  /** Marca del brand pack que la fábrica inyectó como capa de identidad. */
  brand: string;
  blocks: EmitBlock[];
  /** Unión de `omitted` por rol (compatibilidad con flow.json y el runner). */
  omittedRoles: string[];
  omitted: OmittedRole[];
  demoVisible: DemoVisible[];
  simulated: string[];
  appPath: string;
}

/** Nombre de archivo/dir seguro desde el nombre del brief. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

/** Orden visual de los bloques: banner, navbar, strips (en orden del finding), footer. */
function orderedSelections(page: PageResult): Selection[] {
  const out: Selection[] = [];
  if (page.frame.banner) out.push(page.frame.banner);
  if (page.frame.navbar) out.push(page.frame.navbar);
  out.push(...page.strips);
  if (page.frame.footer) out.push(page.frame.footer);
  return out;
}

interface RenderBlock {
  export: string;
  importPath: string;
  exportDefault?: boolean;
  role: string;
  slug: string;
  props?: Record<string, unknown>;
  /** Propless (emittable:false en el índice): no tiene props que clasificar, pinta su demo entero. */
  propless?: true;
  inner?: { export: string; importPath: string; exportDefault?: boolean; slug: string; props?: Record<string, unknown>; propless?: true };
}

/** Sin resolver no hay slots: cualquier `$component` en los props es error (RNF1: el core solo sabe
 * serializar; quién resuelve un slug es el adaptador). */
const NO_SLOTS: ComponentResolver = () => undefined;

/** Genera el contenido de App.tsx: imports + consts de props (copy) + JSX. Un bloque sin copy se
 * emite con sus defaults; uno con copy recibe sus props serializados; un layout envuelve a su inner.
 * Un slot lleno (`$component`, RF6) se escribe como JSX y suma su import, deduplicado con los de bloque. */
export function renderApp(blocks: RenderBlock[], briefSummary: string, resolve: ComponentResolver = NO_SLOTS): string {
  const slotImports: string[] = [];
  const propsConst = (name: string, props: Record<string, unknown>): string => {
    const r = renderSlotProps(props, resolve);
    slotImports.push(...r.imports);
    return `const ${name} = ${r.code} as const;`;
  };
  const consts = blocks
    .flatMap((b, i) => [
      ...(b.props ? [propsConst(`props${i}`, b.props)] : []),
      ...(b.inner?.props ? [propsConst(`inner${i}`, b.inner.props)] : []),
    ])
    .join('\n\n');
  const blockImports = blocks.flatMap((b) => [importLine(b), ...(b.inner ? [importLine(b.inner)] : [])]);
  const imports = [...new Set([...blockImports, ...slotImports])].join('\n');
  const jsx = blocks
    .map((b, i) => {
      const spread = b.props ? ` {...props${i}}` : '';
      // El wrapper data-wt-* deja que el render-gate atribuya texto e imágenes visibles a su slug y rol;
      // display:contents no genera caja, así que el layout del bloque no cambia.
      const open = `      <div data-wt-role="${b.role}" data-wt-slug="${b.slug}" style={{ display: 'contents' }}>`;
      const close = '      </div>';
      if (!b.inner) return [open, `        <${b.export}${spread} />  {/* ${b.role}: ${b.slug} */}`, close].join('\n');
      const innerSpread = b.inner.props ? ` {...inner${i}}` : '';
      return [
        open,
        `        <${b.export}${spread}>  {/* ${b.role}: ${b.slug} (layout) */}`,
        `          <${b.inner.export}${innerSpread} />  {/* inner: ${b.inner.slug} */}`,
        `        </${b.export}>`,
        close,
      ].join('\n');
    })
    .join('\n');
  return `// GENERADO por el runner (scripts/run.ts) desde un brief — NO editar a mano.
// Brief: ${briefSummary}
// Copy inyectado por la capa de copy (pasada 2). Imágenes y tema fino siguen como hueco.
${imports}

${consts}

export default function App() {
  return (
    <>
${jsx}
    </>
  );
}
`;
}

const layerFor = (page: PageResult | LayeredPage, sel: Selection): Layer | undefined =>
  'layers' in page ? page.layers.find((l) => l.role === sel.role && l.layout.slug === sel.pick.slug) : undefined;

/** Un strip de dos capas se resuelve desde la capa (el layout no es un item del adaptador inner). */
function resolveLayer(layer: Layer, sel: Selection, innerPropless: boolean, isDefault: (slug: string) => boolean): RenderBlock {
  const { inner, ...layoutProps } = layer.props;
  const { props: innerProps, ...innerRest } = inner;
  return {
    export: layer.layout.export,
    importPath: layer.layout.importPath,
    ...(isDefault(layer.layout.slug) ? { exportDefault: true } : {}),
    role: sel.role,
    slug: layer.layout.slug,
    ...(Object.keys(layoutProps).length ? { props: layoutProps } : {}),
    inner: { export: layer.inner.export, importPath: layer.inner.importPath, ...(isDefault(innerRest.slug) ? { exportDefault: true } : {}), slug: innerRest.slug, ...(innerProps ? { props: innerProps } : {}), ...(innerPropless ? { propless: true as const } : {}) },
  };
}

/** ¿Tiene copy el rol? `RoleCopy` es 1:1 con `Role`; `banner` no lleva copy y nunca se omite por esto.
 * Un `logos` sin marcas cuenta como ausente: el bloque las rellenaría con las de su demo (D4). */
export const hasRoleCopy = (copy: RoleCopy, role: Role): boolean => {
  if (role === 'banner') return true;
  if (role === 'logos') return (copy.logos?.brands?.length ?? 0) > 0;
  return copy[role as keyof RoleCopy] !== undefined;
};

/** Resuelve qué se emite y qué se omite. Un rol sin copy no se emite (D3): su bloque mostraría el
 * default demo entero; una capa cuyo inner es de ese rol cae completa, para no dejar el shell vacío. */
export function resolveBlocks(page: PageResult | LayeredPage, adapter: LibraryAdapter, copy: RoleCopy): { resolved: RenderBlock[]; omitted: OmittedRole[] } {
  const omitted: OmittedRole[] = [];
  const resolved = orderedSelections(page).flatMap((sel): RenderBlock[] => {
    if (!hasRoleCopy(copy, sel.role)) {
      omitted.push({ role: sel.role, reason: 'sin copy' });
      return [];
    }
    const layer = layerFor(page, sel);
    if (layer) return [resolveLayer(layer, sel, adapter.entry(layer.inner.slug)?.emittable === false, (slug) => adapter.entry(slug)?.exportDefault === true)];
    const e = adapter.entry(sel.pick.slug);
    if (!e) return [];
    const props = adapter.propsFor(sel.pick.slug, copy);
    return [{ export: e.export, importPath: e.importPath, ...(e.exportDefault ? { exportDefault: true } : {}), role: sel.role, slug: sel.pick.slug, ...(props ? { props } : {}), ...(e.emittable === false ? { propless: true as const } : {}) }];
  });
  return dropConsumed(resolved, omitted);
}

/** Un rol que otro bloque ya consumió por un slot (`fill.from`) no se emite como bloque propio: el
 * mismo dato no se pinta dos veces (como Relume: un rol alimenta una sección). Pura. */
function dropConsumed(resolved: RenderBlock[], omitted: OmittedRole[]): { resolved: RenderBlock[]; omitted: OmittedRole[] } {
  const consumedBy = new Map<string, string>();
  for (const b of resolved) {
    for (const role of consumedRoles(b.slug, b.props)) if (!consumedBy.has(role)) consumedBy.set(role, b.slug);
    if (b.inner) for (const role of consumedRoles(b.inner.slug, b.inner.props)) if (!consumedBy.has(role)) consumedBy.set(role, b.inner.slug);
  }
  const kept = resolved.filter((b) => !consumedBy.has(b.role) || consumedBy.get(b.role) === b.slug || consumedBy.get(b.role) === b.inner?.slug);
  const dropped = resolved.filter((b) => !kept.includes(b)).map((b): OmittedRole => ({ role: b.role, reason: 'consumido', by: consumedBy.get(b.role) as string }));
  return { resolved: kept, omitted: [...omitted, ...dropped] };
}

/** Reglas `omit` sin binding de cada bloque emitido, inner incluido (RF4). Un propless no tiene
 * props tipados que clasificar: se lista entero (`*`), porque todo lo que pinta es demo (RF8). */
const demoOf = (b: { slug: string; props?: Record<string, unknown>; propless?: true }): DemoVisible =>
  ({ slug: b.slug, props: b.propless ? ['*'] : unsetOmits(b.slug, b.props) });

export const demoVisibleOf = (blocks: RenderBlock[]): DemoVisible[] =>
  blocks
    .flatMap((b) => [demoOf(b), ...(b.inner ? [demoOf(b.inner)] : [])])
    .filter((d) => d.props.length > 0);

/**
 * Emite la app generada a generated/<brief>/ y devuelve el reporte.
 * `omittedRoles` son los roles que el plan pidió pero el router no tuvo candidato (el finding los
 * omite; no se inventan). Aquí se suman los roles sin copy.
 */
export async function emit(briefName: string, briefSummary: string, adapter: LibraryAdapter, page: PageResult | LayeredPage, omittedRoles: string[], copy: RoleCopy): Promise<EmitReport> {
  const name = slugify(briefName);
  const outUrl = new URL(`generated/${name}/`, REPO_ROOT);
  const outDir = fileURLToPath(outUrl);
  const templateDir = fileURLToPath(new URL(`${adapter.scaffold}/`, REPO_ROOT));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(templateDir, outDir, { recursive: true });

  const { resolved, omitted: withoutCopy } = resolveBlocks(page, adapter, copy);
  const omitted: OmittedRole[] = [...omittedRoles.map((role) => ({ role, reason: 'sin candidato' as const })), ...withoutCopy.filter((o) => !omittedRoles.includes(o.role))];

  // Materializa dentro de outDir cada bloque elegido que no esté vendorizado (blob -> archivos reales
  // solo de lo que la página usa). Un bloque ya en el template es no-op. Un slug que no se pueda
  // materializar se descarta antes de referenciarlo, para no emitir un import roto.
  const slugs = [...new Set(resolved.flatMap((b) => [b.slug, ...(b.inner ? [b.inner.slug] : []), ...slotSlugsOf(b.props), ...slotSlugsOf(b.inner?.props)]))];
  const materialized = new Map(await Promise.all(slugs.map(async (s) => [s, await adapter.materialize(s, outDir)] as const)));
  const buildable = resolved.filter((b) => materialized.get(b.slug) !== false && (!b.inner || materialized.get(b.inner.slug) !== false));

  // Capa de imágenes: rellena los placeholder de Relume con imágenes reales deterministas por bloque.
  const filled = buildable.map((b) => ({
    ...b,
    ...(b.props ? { props: fillImages(b.props, b.slug) } : {}),
    ...(b.inner?.props ? { inner: { ...b.inner, props: fillImages(b.inner.props, b.inner.slug) } } : {}),
  }));

  writeFileSync(`${outDir}src/App.tsx`, renderApp(filled, briefSummary, (slug) => adapter.entry(slug)));
  // El render-gate necesita los props tal como se emitieron: App.tsx lleva JSX en los slots llenos
  // y no se puede leer como JSON.
  writeFileSync(`${outDir}${RENDER_INPUT}`, `${JSON.stringify(renderInputOf(filled), null, 2)}\n`);

  // Capa 1: inyecta la identidad del brand pack activo sobre el contrato del DS (capa 2).
  const extensionPoints = workspaceExtensionPoints(outDir);
  const brand = applyBrand(outDir, activeBrandDir(), { extensionPoints });
  writeBrandVariants(outDir, extensionPoints, brand);

  const withCopy = buildable.filter((r) => r.props || r.inner?.props).length;
  const simulated = ['imágenes'];
  if (withCopy < buildable.length) simulated.unshift('copy de algunos bloques (defaults de muestra)');

  return {
    dir: `generated/${name}`,
    library: adapter.id,
    brand: brand.name,
    blocks: buildable.map((r) => ({ role: r.role, slug: r.slug, export: r.export, ...(r.inner ? { inner: { slug: r.inner.slug, export: r.inner.export } } : {}) })),
    omittedRoles: omitted.map((o) => o.role),
    omitted,
    demoVisible: demoVisibleOf(buildable),
    simulated,
    appPath: `generated/${name}/src/App.tsx`,
  };
}
