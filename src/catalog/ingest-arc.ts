// Lado Arc del ingest automático (`scripts/catalog-ingest.ts`): escanea `ui-react/{blocks,components}`
// del vault (READ-ONLY), clasifica cada bloque en un rol del core por sus keywords, deriva superficie
// y geometría, y corre el GATE automático sobre el source: existe, exporta, deps npm declaradas en
// el scaffold, registryDependencies presentes en el vault e imports resolubles. Nada se copia ni se
// construye aquí: el gate dice si `catalog fetch` + build pueden pasar, no sustituye al render visto.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Role, SurfaceByTheme } from '../types';
import { deriveArcSurface } from '../adapters/arc-surface';
import { scaffoldPathFor } from './fetch';
import { sha256 } from './hash';
import { parseArcDoc, registryDepsOf, type KnownItem } from './manifest-arc';
import { APP_UI, type CatalogEntry, type CatalogGate } from './schema';

export type ArcKind = 'block' | 'component';

export interface ArcScanItem {
  slug: string;
  kind: ArcKind;
  name: string;
  /** `Free` o `Pro` según la línea `- Access:` de la doc (ausente = Pro). */
  access: 'free' | 'pro';
  keywords: string[];
  /** Carpeta del item relativa al vault (`ui-react/blocks/<slug>`). */
  dir: string;
  /** Archivo principal relativo al vault. */
  mainFile: string;
  npmDeps: string[];
  registryDeps: string[];
  /** Rutas declaradas en registry.json (`registry/blocks/<slug>/x`, `lib/x`). */
  files: string[];
  doc: string;
  tsx: string | undefined;
}

const UI = 'ui-react';
const kindDir = (kind: ArcKind): string => (kind === 'block' ? 'blocks' : 'components');

const keywordsOf = (doc: string): string[] =>
  (/^- Keywords:\s*(.+)$/m.exec(doc)?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean);

/** Lee doc.md + registry.json de cada item de una rama. Orden fijo por slug (determinista). */
export function scanArc(vaultRoot: string, kind: ArcKind): ArcScanItem[] {
  const root = join(vaultRoot, UI, kindDir(kind));
  return readdirSync(root).sort().flatMap((slug) => {
    const abs = join(root, slug);
    if (!statSync(abs).isDirectory() || !existsSync(join(abs, 'registry.json'))) return [];
    const raw = readFileSync(join(abs, 'registry.json'), 'utf8');
    const reg = JSON.parse(raw) as { title?: unknown; dependencies?: unknown; files?: unknown };
    const doc = existsSync(join(abs, 'doc.md')) ? readFileSync(join(abs, 'doc.md'), 'utf8') : '';
    const files = Array.isArray(reg.files) ? reg.files.map((f) => (f as { path?: unknown }).path).filter((p): p is string => typeof p === 'string') : [];
    const dir = posix.join(UI, kindDir(kind), slug);
    const mainFile = posix.join(dir, 'files', mainRegistryFile(slug, kind, files));
    const mainAbs = join(vaultRoot, mainFile);
    const name = /^# (.+)$/m.exec(doc)?.[1]?.trim() ?? (typeof reg.title === 'string' ? reg.title : slug);
    return [{
      slug,
      kind,
      name,
      access: /^- Access:\s*Free/m.test(doc) ? 'free' : 'pro',
      keywords: keywordsOf(doc),
      dir,
      mainFile,
      npmDeps: Array.isArray(reg.dependencies) ? reg.dependencies.filter((d): d is string => typeof d === 'string') : [],
      registryDeps: registryDepsOf(raw),
      files,
      doc,
      tsx: existsSync(mainAbs) ? readFileSync(mainAbs, 'utf8') : undefined,
    }];
  });
}

/** Rol por keywords + slug. El orden importa: hero antes que cta (hero-signup dice "email signup"),
 * pricing antes que features (plan-comparison dice "pricing comparison"). Un bloque de app-UI
 * (dashboards, settings, login) no cruza ninguna regla y queda SIN rol: va a la cola, no al índice. */
export const ARC_ROLE_RULES: ReadonlyArray<[Role, RegExp]> = [
  ['hero', /\bhero\b/],
  ['navbar', /\bnavbar\b|site header/],
  ['footer', /\bfooter\b/],
  ['logos', /logo (cloud|marquee)|trusted by/],
  ['stats', /\bstats\b|\bstatistics\b|metrics band|count up/],
  ['testimonials', /testimonial/],
  ['pricing', /\bpricing\b/],
  ['faq', /\bfaq\b/],
  ['steps', /scroll story|scrollytelling|how it works/],
  ['features', /feature (grid|section|comparison)|\bbento\b/],
  ['cta', /\bcta\b|call to action|newsletter|email capture|contact (section|form)/],
];

/** Organismos de producto de Arc (dashboards, charts, AI, kanban, inbox, scheduling…) que en una
 * landing no son una sección propia pero SÍ son el showcase interior de un strip `features`: el mock
 * de producto interactivo que vende la feature (patrón Linear/Vercel), vía el slot inner del 2-layer
 * (ADR 0001). No entran por keyword porque su vocabulario es de app, no de marketing; es una lista
 * curada y auditable. Quedan FUERA a propósito las pantallas que no son contenido de landing: auth
 * (login/sign-in/otp), settings, billing admin, app shells (sidebars), commerce checkout, forms. */
export const ARC_SHOWCASE: ReadonlySet<string> = new Set([
  'activity-terrain', 'agent-run', 'ai-chat', 'ai-composer', 'ai-side-panel', 'budget-variance',
  'choropleth-explorer', 'cohort-retention', 'command-palette', 'connected-scatter', 'customer-galaxy',
  'inbox-triage', 'journey-flow', 'kpi-drilldown', 'line-replay', 'market-terminal', 'media-player',
  'metric-explorer', 'metrics-dashboard', 'mrr-waterfall', 'notification-center', 'project-board',
  'revenue-explorer', 'revenue-globe', 'semantic-zoom', 'small-multiples', 'support-conversation',
  'support-widget', 'usage-forecast', 'wallet-card', 'week-calendar',
]);

export function roleOfArc(item: Pick<ArcScanItem, 'slug' | 'keywords'>): Role | undefined {
  const text = `${item.slug.replace(/-/g, ' ')} ${item.keywords.join(', ')}`.toLowerCase();
  const byKeyword = ARC_ROLE_RULES.find(([, re]) => re.test(text))?.[0];
  if (byKeyword) return byKeyword;
  return ARC_SHOWCASE.has(item.slug) ? 'features' : undefined;
}

const REGISTRY_TSX = /^registry\/(blocks|components)\/([\w-]+)\/([\w-]+)\.tsx$/;

/** El .tsx principal según el registry.json del item, no según la convención: algunos bloques viven
 * en registry/components/<slug>/ y las variantes de un componente apuntan al archivo de su base. Se
 * prefiere el archivo con el nombre del slug; si no hay, el que se llama como su carpeta. */
export function mainRegistryFile(slug: string, kind: ArcKind, files: readonly string[]): string {
  const own = files.find((f) => REGISTRY_TSX.exec(f)?.[3] === slug);
  if (own) return own;
  const base = files.find((f) => { const m = REGISTRY_TSX.exec(f); return m !== null && m[2] === m[3]; });
  return base ?? posix.join('registry', kindDir(kind), slug, `${slug}.tsx`);
}

/** Slug de la carpeta del registry donde vive el archivo principal: si no es el propio, el item es
 * una variante de documentación de otro (mismo source). */
export function registrySlugOf(mainFile: string): string | undefined {
  return /\/files\/registry\/(?:blocks|components)\/([\w-]+)\//.exec(mainFile)?.[1];
}

/** Import del archivo principal en el scaffold: el mismo mapa que fetch usa para copiarlo. */
export function arcImportPathOf(mainFile: string): string {
  const rel = mainFile.slice(mainFile.indexOf('/files/') + '/files/'.length);
  const m = REGISTRY_TSX.exec(rel);
  if (!m) throw new Error(`ingest-arc: archivo principal fuera de registry/: ${mainFile}`);
  return `@/components/arc/${m[1] === 'blocks' ? `blocks/${m[2]}` : m[2]}/${m[3]}`;
}

const pascal = (slug: string): string => slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

/** Export principal: el PascalCase del slug si el source lo exporta; si no, el primer `export function`. */
export function arcExportName(slug: string, tsx: string): string | undefined {
  return arcExportOf(slug, tsx)?.name;
}

/** Igual que arcExportName, y si el source solo trae `export default function X`, ese X marcado como
 * default: el import tiene que ir sin llaves (import-line.ts). */
export function arcExportOf(slug: string, tsx: string): { name: string; isDefault: boolean } | undefined {
  const wanted = pascal(slug);
  if (new RegExp(`^export (function|const) ${wanted}\\b`, 'm').test(tsx)) return { name: wanted, isDefault: false };
  const named = /^export function (\w+)/m.exec(tsx)?.[1];
  if (named) return { name: named, isDefault: false };
  const dflt = /^export default function (\w+)/m.exec(tsx)?.[1];
  return dflt ? { name: dflt, isDefault: true } : undefined;
}

const GEOMETRY_RULES: ReadonlyArray<[string, RegExp]> = [
  ['bento', /\bbento\b/], ['table', /\btable\b/], ['marquee', /marquee/], ['slider', /slider|carousel/],
  ['band', /\bband\b/], ['split', /\bsplit\b/], ['centered', /centered/], ['grid', /\bgrid\b/],
];

/** Geometría por keywords (vocabulario que ya usan las entradas curadas); `standard` si nada cruza. */
export const arcGeometry = (keywords: string[]): string =>
  GEOMETRY_RULES.find(([, re]) => re.test(keywords.join(', ').toLowerCase()))?.[0] ?? 'standard';

/** Superficie derivada del CSS module prístino del vault; undefined si no hay módulo o raíz. */
export function arcSurfaceOf(item: ArcScanItem, vaultRoot: string): SurfaceByTheme | undefined {
  const css = join(vaultRoot, item.mainFile.replace(/\.tsx$/, '.module.css'));
  if (!existsSync(css)) return undefined;
  const d = deriveArcSurface(readFileSync(css, 'utf8'));
  if (!d || d.light === undefined || d.dark === undefined) return undefined;
  return { light: d.light, dark: d.dark };
}

/** Paquetes que el scaffold Arc resuelve además de sus deps npm: `next/image` va por el shim del
 * vite.config (alias) y `motion/react` es subpath de `motion`. */
export const SCAFFOLD_EXTRA_RESOLVABLE: ReadonlySet<string> = new Set(['next/image']);

/** lib del vault que el scaffold vendoriza con otro nombre: el vault renombró arc-provider a
 * uikit-provider. Traerla dejaría dos providers y el componente no leería el ArcProvider del
 * scaffold, así que no es instalable hasta reconciliar el provider en el vault. */
export const SCAFFOLD_RENAMED_LIB: ReadonlyMap<string, string> = new Map([['uikit-provider', 'arc-provider']]);

export const packageOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
/** Imports de una o varias líneas. */
export const IMPORT_RE = /^import\b[\s\S]*?\bfrom\s+["']([^"']+)["'];?$/gm;
const EXTS = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx'];

/** Cierre transitivo de registryDependencies sobre el escaneo; las que falten se devuelven aparte. */
export function closureOf(item: ArcScanItem, byslug: ReadonlyMap<string, ArcScanItem>): { items: ArcScanItem[]; missing: string[] } {
  const seen = new Set<string>([item.slug]);
  const items: ArcScanItem[] = [item];
  const missing: string[] = [];
  const queue = [...item.registryDeps];
  while (queue.length) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    const dep = byslug.get(next);
    if (!dep) { missing.push(next); continue; }
    items.push(dep);
    queue.push(...dep.registryDeps);
  }
  return { items, missing };
}

const ARC_DIR = posix.join('src', 'components', 'arc');

/** Ruta en el scaffold -> ruta bajo `files/` del vault (inversa de scaffoldPathFor): los bloques
 * viven en `registry/blocks/`, la lib en `lib/` y los components en `registry/components/`. */
const vaultRelOf = (scaffoldRel: string): string =>
  scaffoldRel.startsWith('blocks/') ? `registry/${scaffoldRel}` : scaffoldRel.startsWith('lib/') ? scaffoldRel : `registry/components/${scaffoldRel}`;

/** Un import relativo se resuelve en el espacio del SCAFFOLD (ahí `../../lib/x` desde un bloque es
 * `arc/lib/x`; en el vault la lib cuelga de `files/lib`, no de `files/registry`). Existe si está en
 * `files/` del item o de una dep transitiva, o ya vendorizado en el scaffold. */
function relativeResolves(spec: string, item: ArcScanItem, closure: ArcScanItem[], vaultRoot: string, scaffoldRoot: string): boolean {
  const mainVaultRel = item.mainFile.slice(item.dir.length + '/files/'.length);
  const mainScaffoldRel = scaffoldPathFor(mainVaultRel).slice(ARC_DIR.length + 1);
  const scaffoldRel = posix.normalize(posix.join(posix.dirname(mainScaffoldRel), spec));
  const vaultRel = vaultRelOf(scaffoldRel);
  const roots = [...closure.map((c) => join(vaultRoot, c.dir, 'files', vaultRel)), join(scaffoldRoot, ARC_DIR, scaffoldRel)];
  return roots.some((base) => EXTS.some((ext) => existsSync(base + ext)));
}

export interface ArcGateContext {
  vaultRoot: string;
  scaffoldRoot: string;
  declaredNpm: ReadonlySet<string>;
  byslug: ReadonlyMap<string, ArcScanItem>;
  /** Nombre que se espera exportado (ya resuelto por arcExportName). */
  exportName: string | undefined;
  surface: SurfaceByTheme | undefined;
}

/** Gate automático de un bloque. Cada motivo es una línea autocontenida para la cola de revisión. */
export function gateArc(item: ArcScanItem, ctx: ArcGateContext): CatalogGate {
  const reasons: string[] = [];
  if (item.tsx === undefined) return { ok: false, reasons: [`archivo principal ausente en el vault: ${item.mainFile}`] };
  if (!ctx.exportName) reasons.push(`sin export principal (${pascal(item.slug)}) en ${posix.basename(item.mainFile)}`);
  const { items: closure, missing } = closureOf(item, ctx.byslug);
  if (missing.length) reasons.push(`registryDependencies fuera del vault: ${missing.join(', ')}`);
  const npm = [...new Set(closure.flatMap((c) => c.npmDeps))].filter((d) => !ctx.declaredNpm.has(d)).sort();
  if (npm.length) reasons.push(`dep npm ausente en el scaffold: ${npm.join(', ')}`);
  const foreign: string[] = [];
  const unresolved: string[] = [];
  // Si el scaffold ya trae el item portado, lo que compila es esa fuente, no la del vault: es la misma
  // regla que build-registry, que publica el port.
  const ported = join(ctx.scaffoldRoot, 'src', arcImportPathOf(item.mainFile).slice('@/'.length) + '.tsx');
  const tsx = existsSync(ported) ? readFileSync(ported, 'utf8') : item.tsx;
  for (const m of tsx.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      const lib = /(?:^|\/)lib\/([\w-]+)$/.exec(spec)?.[1];
      const renamed = lib ? SCAFFOLD_RENAMED_LIB.get(lib) : undefined;
      if (lib && renamed) { reasons.push(`lib renombrada en el vault: ${lib} (el scaffold la tiene como ${renamed})`); continue; }
      if (!relativeResolves(spec, item, closure, ctx.vaultRoot, ctx.scaffoldRoot)) unresolved.push(spec);
      continue;
    }
    const pkg = packageOf(spec);
    if (spec.startsWith('node:')) foreign.push(`${spec} (API de Node, no apta para el navegador)`);
    else if (!ctx.declaredNpm.has(pkg) && !SCAFFOLD_EXTRA_RESOLVABLE.has(spec) && !npm.includes(pkg)) foreign.push(spec);
  }
  if (foreign.length) reasons.push(`import de paquete ajeno al scaffold: ${[...new Set(foreign)].join(', ')}`);
  if (unresolved.length) reasons.push(`import relativo sin archivo en el item ni en sus deps: ${[...new Set(unresolved)].join(', ')}`);
  if (!ctx.surface && item.kind === 'block') reasons.push('superficie no derivable del CSS module (color literal o sin regla raíz)');
  return { ok: reasons.length === 0, reasons };
}

export interface ArcEntryInput {
  item: ArcScanItem;
  /** null = bloque de UI de app: entra al catálogo sin rol de landing (category APP_UI). */
  role: Role | null;
  exportName: string;
  exportDefault?: boolean;
  surface: SurfaceByTheme | undefined;
  gate: CatalogGate;
  known: readonly KnownItem[];
  vaultRoot: string;
}

/** Entrada del índice para un bloque Arc ingestado: verified:false y source:null (RF5: el source se
 * trae on-demand con fetch); el manifiesto se parsea de la doc; emittable:false si no hay props de
 * contenido (propless). La superficie no derivable cae a base/base y queda dicha en el gate. */
export function buildArcEntry(i: ArcEntryInput): CatalogEntry {
  const manifest = parseArcDoc(i.item.doc, i.exportName, i.item.slug, i.known);
  const propless = manifest.injection.kind !== 'props';
  return {
    library: 'arc',
    kind: 'block',
    slug: i.item.slug,
    name: i.item.name,
    ...(i.role ? { role: i.role } : {}),
    category: i.role ? `${i.role}-sections` : APP_UI,
    tags: i.item.keywords.slice(0, 6),
    surface: i.surface ?? { light: 'base', dark: 'base' },
    geometry: arcGeometry(i.item.keywords),
    ...(propless ? { emittable: false } : {}),
    verified: false,
    source: null,
    origin: { kind: 'vault', path: i.item.mainFile, sha256: sha256(readFileSync(join(i.vaultRoot, i.item.mainFile))) },
    export: i.exportName,
    ...(i.exportDefault ? { exportDefault: true } : {}),
    importPath: arcImportPathOf(i.item.mainFile),
    ...(i.item.registryDeps.length ? { registryDependencies: [...i.item.registryDeps] } : {}),
    manifest,
    manifestOrigin: 'parsed',
    gate: i.gate,
    notes: `Ingest automático: ${i.role ? 'rol por keywords' : 'UI de app, sin rol de landing'}, superficie del CSS del vault, geometría por keywords; tags = keywords de la doc. ${accessNote(i.item)}${propless ? ' Propless para copy (emittable:false).' : ''}`,
  };
}

export interface ArcComponentInput {
  item: ArcScanItem;
  exportName: string;
  exportDefault?: boolean;
  gate: CatalogGate;
  known: readonly KnownItem[];
  vaultRoot: string;
  /** Ruta del source ya vendorizado en el scaffold (relativa al repo), si existe. */
  source: string | null;
}

/** Entrada de un componente (átomo/molécula): sin rol porque no es sección; los slots de un
 * organismo lo eligen por `semantics`. Los campos que el parser exige van fijos: un componente no
 * tiene superficie ni geometría propias. */
export function buildArcComponentEntry(i: ArcComponentInput): CatalogEntry {
  return {
    library: 'arc',
    kind: 'component',
    slug: i.item.slug,
    name: i.item.name,
    category: 'component',
    tags: [],
    surface: { light: 'base', dark: 'base' },
    geometry: 'component',
    verified: false,
    source: i.source,
    origin: { kind: 'vault', path: i.item.mainFile, sha256: sha256(readFileSync(join(i.vaultRoot, i.item.mainFile))) },
    export: i.exportName,
    ...(i.exportDefault ? { exportDefault: true } : {}),
    importPath: arcImportPathOf(i.item.mainFile),
    ...(i.item.registryDeps.length ? { registryDependencies: [...i.item.registryDeps] } : {}),
    manifest: parseArcDoc(i.item.doc, i.exportName, i.item.slug, i.known),
    manifestOrigin: 'parsed',
    gate: i.gate,
    notes: `Ingest automático (component). ${accessNote(i.item)}`,
  };
}

const accessNote = (item: ArcScanItem): string =>
  item.access === 'free' ? 'Acceso Arc: free (open source).' : 'Acceso Arc: Pro.';
