// Registry del DS para el store privado (Vercel Blob), forma shadcn: el composer y el runner lo
// consultan bajo demanda en vez de llevar la librería en el paquete. Cada item es AUTOSUFICIENTE
// (código + deps + schema): el runner materializa desde el item sin tocar el vault, que en el deploy
// no existe. Los paths llevan el hash del contenido porque la CDN cachea 60 s: un path nunca cambia
// de contenido y solo el puntero `latest` se reescribe.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { AllowEntry, GateResult, ItemGates } from './ds-skill';
import { validate, type JsonSchema } from './catalog/schema-gen';
import { filesSha } from './files-sha';

export { filesSha };
import { sha256 } from './catalog/hash';
import { locateArcItem, scaffoldPathFor } from './catalog/fetch';
import { arcExportOf, arcSurfaceOf, gateArc, IMPORT_RE, packageOf, scanArc, SCAFFOLD_RENAMED_LIB, type ArcScanItem } from './catalog/ingest-arc';
import type { CatalogGate } from './catalog/schema';

export interface RegistryFile {
  /** Relativo a la raíz del workspace, bajo src/components/arc/ (mismo destino que fetch). */
  path: string;
  content: string;
}

export interface RegistryItem {
  name: string;
  type: 'registry:block' | 'registry:ui' | 'registry:lib';
  dependencies: string[];
  /** Slugs de este mismo registry. */
  registryDependencies: string[];
  files: RegistryFile[];
  /** Campos de registry-item de shadcn: categoría y origen sin tener que abrir `allow`. */
  categories: string[];
  description?: string;
  meta: {
    origin: 'arc' | 'relume' | 'base';
    kind: 'block' | 'layout' | 'component' | 'lib' | 'motion';
    role?: string;
    slots?: AllowEntry['slots'];
    /** Solo motion: contrato DOM (el primero es la raíz) y plugins de GSAP que registra. */
    hooks?: string[];
    plugins?: string[];
  };
  allow?: AllowEntry;
  schema: unknown | null;
}

export interface BuiltItem {
  item: RegistryItem;
  /** Para items sin allow (lib, motion): los gates van solo en el índice. */
  gates?: ItemGates;
  sha: string;
  path: string;
}

const SHA_LEN = 16;

// Los Relume traen `_` (cta13_block). Un `/` o `..` en un slug escribiría fuera de r/ o references/,
// incluso encima de latest.json.
const SLUG = /^[a-z0-9_-]+$/;
const safeSlug = (slug: string): string => {
  if (!SLUG.test(slug)) throw new Error(`registry: slug inválido "${slug}"`);
  return slug;
};

export const itemPath = (slug: string, sha: string): string => `r/${safeSlug(slug)}@${sha}.json`;

/** Hash del item serializado: es lo que hace inmutable `r/<slug>@<sha>.json`. */
export function hashItem(item: RegistryItem): string {
  return sha256(JSON.stringify(item)).slice(0, SHA_LEN);
}

/** Tokens de motion de Arc. El vault los declara como `uikit-motion-tokens` y registryDepsOf los
 * descarta porque el scaffold ya los trae; en el registry no hay scaffold, así que van como item propio
 * y como dependencia de quien los importa. */
export const MOTION_TOKENS = 'arc-motion-tokens';
const MOTION_FILES = ['src/components/arc/motion-tokens.ts', 'src/components/arc/lib/motion-tokens.ts'];
const IMPORTS_MOTION = /from\s+["'][^"']*motion-tokens["']/;

export function readMotionTokens(scaffoldRoot: string): RegistryItem {
  return {
    name: MOTION_TOKENS,
    type: 'registry:lib',
    dependencies: [],
    registryDependencies: [],
    files: MOTION_FILES.map((path) => ({ path, content: readFileSync(join(scaffoldRoot, path), 'utf8') })),
    categories: ['foundation'],
    meta: { origin: 'arc', kind: 'lib' },
    schema: null,
  };
}

/** Libs compartidas de los ports: un archivo suelto en la raíz de src/components/relume/ (collection.ts del
 * contrato de bloque, ADR 0009) o de src/components/ (brand-icons, social-icons… que el codemod deja para
 * los iconos de marca). Como motion-tokens, van como item propio y como dependencia de cada port que las
 * importa; sin eso el item no es autosuficiente y el gate de clausura frena la publicación. */
const SHARED_LIBS = [
  { prefix: 'relume-', dir: 'src/components/relume' },
  { prefix: 'components-', dir: 'src/components' },
] as const;
const LIB_FILE = /^[a-z0-9-]+$/;

/** Slug de lib compartida para una ruta local sin extensión, o undefined si no es una lib suelta. */
function sharedLibOf(path: string): string | undefined {
  for (const { prefix, dir } of SHARED_LIBS) {
    const name = path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : '';
    if (LIB_FILE.test(name)) return `${prefix}${name}`;
  }
  return undefined;
}

export const isSharedLib = (slug: string): boolean => SHARED_LIBS.some((l) => slug.startsWith(l.prefix));

export function readSharedLib(slug: string, scaffoldRoot: string): RegistryItem {
  const lib = SHARED_LIBS.find((l) => slug.startsWith(l.prefix));
  if (!lib) throw new Error(`registry: "${slug}" no es una lib compartida`);
  const base = `${lib.dir}/${slug.slice(lib.prefix.length)}`;
  const path = ['.ts', '.tsx'].map((e) => base + e).find((p) => existsSync(join(scaffoldRoot, p)));
  if (!path) throw new Error(`registry: la lib "${slug}" no existe en ${base}.ts(x)`);
  const content = readFileSync(join(scaffoldRoot, path), 'utf8');
  // Una lib que pinta con un componente Arc (relume/action usa el Button) lo declara como dep, igual que un port.
  const local = importsOf(content).filter((spec) => spec.startsWith('.')).map((spec) => posix.normalize(posix.join(lib.dir, spec)));
  const arcDeps = local.map((p) => ARC_SLUG_OF.exec(`${p}/`)?.[1]).filter((d): d is string => d !== undefined && d !== 'lib');
  // Y una lib que importa otra lib suelta (relume/social usa brand-icons y social-network) la arrastra igual.
  const libDeps = local.map(sharedLibOf).filter((d): d is string => d !== undefined);
  return {
    name: slug,
    type: 'registry:lib',
    dependencies: [],
    registryDependencies: [...new Set([...arcDeps, ...libDeps])].sort(),
    files: [{ path, content }],
    categories: ['foundation'],
    meta: { origin: lib.prefix === 'relume-' ? 'relume' : 'arc', kind: 'lib' },
    schema: null,
  };
}

const MOTION_DIR = 'src/components/arc/lib/motion';
export const MOTION_RUNTIME = 'motion-runtime';

const stringList = (src: string, name: string): string[] => {
  const body = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)?.[1] ?? '';
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

/** Descripción por slug desde motion-gsap/_listado.md del vault, líneas `- **Nombre** (<slug>, tipo) - texto`. */
export function motionListing(md: string): Record<string, string> {
  return Object.fromEntries([...md.matchAll(/^- \*\*[^*]+\*\* \(`([\w-]+)`[^)]*\) - (.+)$/gm)].map((m) => [m[1], m[2].trim()]));
}

/** Módulos de motion del scaffold (W6): no son componentes de página ni pasan por verify; el composer los
 * declara por sus hooks DOM y el runner los materializa. Uno por archivo de lib/motion. */
export function readMotionItems(scaffoldRoot: string, listing: Record<string, string>): RegistryItem[] {
  const dir = join(scaffoldRoot, MOTION_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => {
      const slug = f.replace(/\.ts$/, '');
      const content = readFileSync(join(dir, f), 'utf8');
      const runtime = slug === 'runtime';
      const hooks = stringList(content, 'REQUIRED_HOOKS');
      const plugins = stringList(content, 'GSAP_PLUGINS');
      // Los de motion-html (Osmo) traen su CSS al lado; viaja en el mismo item o el import no resuelve.
      const styles = importsOf(content)
        .filter((spec) => /^\.\/[\w-]+\.css$/.test(spec) && existsSync(join(dir, spec)))
        .map((spec) => ({ path: `${MOTION_DIR}/${spec.slice(2)}`, content: readFileSync(join(dir, spec), 'utf8') }));
      // motion-html no tiene _listado.md: la primera línea del módulo describe el efecto.
      const description = listing[slug] ?? /^\/\/ (.+)$/m.exec(content)?.[1]?.trim();
      return {
        name: runtime ? MOTION_RUNTIME : `motion-${slug}`,
        type: 'registry:lib' as const,
        // Las reales las deriva npmDepsOf de los imports al publicar.
        dependencies: [],
        registryDependencies: runtime ? [MOTION_TOKENS] : [MOTION_RUNTIME],
        files: [{ path: `${MOTION_DIR}/${f}`, content }, ...styles],
        categories: [runtime ? 'foundation' : 'motion'],
        ...(description ? { description } : {}),
        meta: { origin: 'arc' as const, kind: runtime ? ('lib' as const) : ('motion' as const), ...(hooks.length ? { hooks } : {}), ...(plugins.length ? { plugins } : {}) },
        schema: null,
      };
    });
}

/** Alias que trae todo scaffold: src/shims/next-image.tsx aliasado en vite, así que el shim no se publica como item. */
export const STARTER_ALIASES: Readonly<Record<string, string>> = { 'next/image': 'src/shims/next-image.tsx' };
/** El scaffold que asume un índice. El default es el base del core (B9); el registry de una distro pasa el suyo. */
export interface Starter { readonly name: string; readonly aliases: Readonly<Record<string, string>> }
export const BASE_STARTER: Starter = { name: 'base-scaffold', aliases: STARTER_ALIASES };

/** Destino en el scaffold de un archivo del vault, con las libs que el scaffold vendoriza con otro nombre. */
function targetOf(vaultFile: string): string {
  const lib = /^lib\/([\w-]+)(\.\w+)$/.exec(vaultFile);
  const renamed = lib ? SCAFFOLD_RENAMED_LIB.get(lib[1]) : undefined;
  return scaffoldPathFor(renamed && lib ? `lib/${renamed}${lib[2]}` : vaultFile);
}

/** Lee un item Arc del vault con sus archivos ya en la ruta del scaffold. Si el scaffold tiene ese archivo,
 * manda su versión: es la portada que compila (p. ej. avatar con ArcImage y lib/arc-provider), mientras
 * que la del vault puede importar libs que el scaffold renombró. */
/** Archivos de la carpeta del port en el scaffold que el vault no lista, en la misma carpeta que los listados. */
export function readVaultItem(slug: string, vaultRoot: string, allow: AllowEntry | undefined, schema: unknown | null, scaffoldRoot?: string): RegistryItem {
  const located = locateArcItem(slug, vaultRoot);
  if (!located) throw new Error(`registry: "${slug}" no está en el vault`);
  const listed = located.files.map((f) => {
    const path = targetOf(f);
    const ported = scaffoldRoot ? join(scaffoldRoot, path) : null;
    return { path, content: readFileSync(ported && existsSync(ported) ? ported : join(located.dir, 'files', f), 'utf8') };
  });
  const files = scaffoldRoot ? withPortedSiblings(listed, scaffoldRoot) : listed;
  // El tipo sale de dónde vive en el vault, no de si tiene AllowEntry: un componente que el ingest dejó
  // fuera del catálogo sigue siendo un componente, y etiquetarlo lib escondía que faltaba en el pool.
  const type = /[/\\]blocks[/\\]/.test(located.dir) ? 'registry:block' : 'registry:ui';
  return {
    name: slug,
    type,
    dependencies: [...located.npmDeps].sort(),
    registryDependencies: [
      ...new Set([
        ...located.registryDeps,
        ...(files.some((f) => IMPORTS_MOTION.test(f.content)) ? [MOTION_TOKENS] : []),
      ]),
    ].sort(),
    files,
    categories: allow?.category ? [allow.category] : [],
    meta: {
      origin: 'arc',
      kind: allow?.kind === 'block' ? 'block' : 'component',
      ...(allow?.role ? { role: allow.role } : {}),
      ...(allow?.slots ? { slots: allow.slots } : {}),
    },
    // La ruta del repo no existe en el blob: el schema viaja en el mismo item.
    ...(allow ? { allow: { ...allow, schema: schema ? '#schema' : null } } : {}),
    schema,
  };
}

/** Lo que hace falta de una entrada del catálogo para leer un item que no está en el vault. */
export interface SourceEntry {
  kind: string;
  // El catálogo guarda null mientras el source no se vendorizó (CatalogEntry.source); readSourceItem ya lo trata como ausente.
  source?: string | null;
  library: string;
  role?: string;
  category?: string;
}

const PORT_EXT = /\.(tsx?|css)$/;
// Un import a src/components/arc/<slug>/ o arc/blocks/<slug>/ es una dep del registry; lib/ la cubre
// motion-tokens y blocks/ no es un slug.
const ARC_SLUG_OF = /^src\/components\/arc\/(?:blocks\/)?([a-z0-9_-]+)\//;

/** Un port que solo vive en el scaffold (los Relume): su carpeta entera, porque los hermanos (.module.css)
 * se importan por ruta relativa, y sus deps Arc salen de esos mismos imports. */
function readPortedItem(slug: string, entry: SourceEntry & { source: string }, allow: AllowEntry | undefined, schema: unknown | null, scaffoldRoot: string): RegistryItem {
  const at = entry.source.indexOf('src/components/');
  if (at < 0) throw new Error(`registry: la fuente de "${slug}" no está bajo src/components/: ${entry.source}`);
  const dir = posix.dirname(entry.source.slice(at));
  const files = readdirSync(join(scaffoldRoot, dir)).filter((f) => PORT_EXT.test(f)).sort().map((f) => ({ path: posix.join(dir, f), content: readFileSync(join(scaffoldRoot, dir, f), 'utf8') }));
  const local = files.flatMap((f) => importsOf(f.content).filter((spec) => spec.startsWith('.') || spec.startsWith('@/')).map((spec) => (spec.startsWith('.') ? posix.normalize(posix.join(dir, spec)) : `src/${spec.slice(2)}`)));
  const arcDeps = local.map((p) => ARC_SLUG_OF.exec(`${p}/`)?.[1]).filter((d): d is string => d !== undefined && d !== 'lib');
  const libs = local.map((p) => sharedLibOf(p.replace(/\.tsx?$/, ''))).filter((d): d is string => d !== undefined);
  const kind = entry.kind === 'layout' ? 'layout' : 'block';
  return {
    name: slug,
    type: 'registry:block',
    dependencies: [],
    registryDependencies: [...new Set([...arcDeps, ...libs, ...(files.some((f) => IMPORTS_MOTION.test(f.content)) ? [MOTION_TOKENS] : [])])].sort(),
    files,
    categories: allow?.category ? [allow.category] : entry.category ? [entry.category] : [],
    meta: {
      origin: entry.library === 'relume' ? 'relume' : 'arc',
      kind,
      ...(allow?.role ?? entry.role ? { role: allow?.role ?? entry.role } : {}),
      ...(allow?.slots ? { slots: allow.slots } : {}),
    },
    ...(allow ? { allow: { ...allow, schema: schema ? '#schema' : null } } : {}),
    schema,
  };
}

/** La fuente de un item: el vault (con la portada del scaffold encima) cuando lo tiene, si no la fuente
 * portada que declara el catálogo. Es la regla de avatar aplicada a cualquier origen. */
export function readSourceItem(slug: string, entry: SourceEntry | undefined, vaultRoot: string, allow: AllowEntry | undefined, schema: unknown | null, scaffoldRoot: string): RegistryItem {
  if (locateArcItem(slug, vaultRoot)) return readVaultItem(slug, vaultRoot, allow, schema, scaffoldRoot);
  if (entry?.source) return readPortedItem(slug, { ...entry, source: entry.source }, allow, schema, scaffoldRoot);
  throw new Error(`registry: "${slug}" no está en el vault ni tiene fuente portada en el catálogo`);
}

/** Los slugs pedidos más el cierre de sus registryDependencies: un item cuya dep no está publicada
 * deja al runner sin poder materializar. */
export function closure(slugs: string[], depsOf: (slug: string) => string[]): string[] {
  const seen = new Set<string>();
  const queue = [...slugs];
  while (queue.length) {
    const s = queue.shift() as string;
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(...depsOf(s));
  }
  return [...seen].sort();
}

// `.env` solo como ruta de archivo (`'.env'`, `/.env.local`): como selector CSS (`.env {`) es un falso positivo.
// Las claves en minúsculas exigen un valor sin espacios: con espacios son etiquetas de UI ("Personal access token").
const SECRET = [new RegExp([
  String.raw`["'/]\.env(\.\w+)?\b`,
  String.raw`[A-Z_]*TOKEN\s*[:=]\s*["'][^"']{8,}`,
  String.raw`[A-Z_]*KEY\s*=\s*["'][^"']{8,}`,
  String.raw`Bearer\s+[A-Za-z0-9._-]{16,}`,
  String.raw`sk-[A-Za-z0-9]{16,}`,
  String.raw`\b[sr]k_live_[A-Za-z0-9]{16,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{36}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  String.raw`vercel_blob_rw_[A-Za-z0-9_]{16,}`,
].join('|')), /\b\w*(?:api_?key|secret|token|password|passwd)\w*["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i];

/** Un texto con algo que parece un secreto; `sha` es el del contenido que lo disparó, para aceptar solo
 * ese contenido revisado y no el archivo para siempre. */
export interface SecretHit {
  id: string;
  sha: string;
}

export function secretHitsIn(docs: { id: string; content: string }[]): SecretHit[] {
  return docs.filter((d) => SECRET.some((r) => r.test(d.content))).map((d) => ({ id: d.id, sha: sha256(d.content) }));
}

// Los strings tal cual: en JSON.stringify las comillas salen escapadas y el patrón de clave no las ve.
const stringsOf = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...stringsOf(x)]) : [];

/** Archivos y metadatos con algo que parece un secreto: el store es privado pero los items llegan a sandboxes. */
export function secretHits(items: RegistryItem[]): SecretHit[] {
  return secretHitsIn(items.flatMap((i) => {
    const { files, ...meta } = i;
    return [...files.map((f) => ({ id: `${i.name}: ${f.path}`, content: f.content })), { id: `${i.name}: (metadatos)`, content: stringsOf(meta).join('\n') }];
  }));
}

/** Los hits que no son exactamente un contenido revisado a mano (`reviewed`: id -> sha256). */
export function unreviewed(hits: SecretHit[], reviewed: Record<string, string>): string[] {
  return hits.filter((h) => reviewed[h.id] !== h.sha).map((h) => h.id);
}

const INDEX_PATH = /^index@[0-9a-f]{16}\.json$/;

/** El índice al que apunta un latest.json leído del store: solo un `index@<sha>.json` del mismo store. */
export function indexPathOf(latest: unknown): string {
  const p = (latest as { index?: unknown } | null)?.index;
  if (typeof p !== 'string' || !INDEX_PATH.test(p)) throw new Error('registry: latest.json no apunta a un index@<sha>.json; el trinquete falla cerrado');
  return p;
}

/** Entorno del CLI de Vercel al publicar: sin el resto de secretos de la shell, y sin BLOB_STORE_ID, que con
 * el token RW le hace pedir OIDC. */
export function publishEnv(env: Record<string, string | undefined>): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'BLOB_READ_WRITE_TOKEN'];
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k] as string]));
}

export interface RegistryIndex {
  version: string;
  items: Record<string, { path: string; allow?: AllowEntry; hasSchema: boolean; gates?: ItemGates }>;
  /** Categoría (o `block-<rol>`) -> path inmutable de su guía. */
  references: Record<string, string>;
  /** Lo que el workspace tiene que traer: los items asumen este starter y sus alias. */
  starter: Starter;
  /** Id de marca -> path inmutable de su pack (brands/<id>@<sha>.json). */
  brands?: Record<string, string>;
  /** Id de skill -> path inmutable de su pack (skills/<id>@<sha>.json): el skill que lee el agente (ADR 0011). */
  skills?: Record<string, string>;
  /** Path inmutable de las ranuras de marca (extension-points@<sha>.json, spec ranuras-de-marca): va por ruta y no
   * inline para que el pin las cubra sin engordar el índice que se lee en cada corrida. */
  extensionPoints?: string;
}

export const guidePath = (key: string, md: string): string => `references/${safeSlug(key)}@${sha256(md).slice(0, SHA_LEN)}.md`;

export function buildIndex(built: BuiltItem[], guides: Record<string, string>, brands: Record<string, string> = {}, skills: Record<string, string> = {}, extensionPoints?: string, starter: Starter = BASE_STARTER): { index: RegistryIndex; sha: string } {
  const items = Object.fromEntries(built.map((b) => [b.item.name, { path: b.path, ...(b.item.allow ? { allow: { ...b.item.allow, schema: b.item.schema !== null ? `${b.path}#schema` : null } } : {}), hasSchema: b.item.schema !== null, ...(b.gates ? { gates: b.gates } : {}) }]));
  const references = Object.fromEntries(Object.entries(guides).map(([k, md]) => [k, guidePath(k, md)]));
  // Sin marcas, el sha no cambia respecto de los índices publicados antes de que existieran.
  const withBrands = Object.keys(brands).length ? { brands } : {};
  const withSkills = Object.keys(skills).length ? { skills } : {};
  const withPoints = extensionPoints ? { extensionPoints } : {};
  const sha = sha256(JSON.stringify({ starter, items, references, ...withBrands, ...withSkills, ...withPoints })).slice(0, SHA_LEN);
  return { index: { version: sha, starter, items, references, ...withBrands, ...withSkills, ...withPoints }, sha };
}

export const extensionPointsPath = (json: string): string => `extension-points@${sha256(json).slice(0, SHA_LEN)}.json`;

/** El código de cada componente extensible tal como se publica (su item del registry), para que las ranuras salgan de
 * lo mismo que el workspace monta y no de otra copia. */
export function componentSourcesOf(built: readonly BuiltItem[], names: readonly string[]): Record<string, { tsx: string; css: string }> {
  const out: Record<string, { tsx: string; css: string }> = {};
  for (const name of names) {
    const files = built.find((b) => b.item.name === name)?.item.files ?? [];
    const tsx = files.find((f) => f.path.endsWith(`/${name}.tsx`))?.content;
    const css = files.find((f) => f.path.endsWith(`/${name}.module.css`))?.content;
    if (tsx !== undefined && css !== undefined) out[name] = { tsx, css };
  }
  return out;
}

/** Guía por categoría (átomos) o rol (blocks): lo que el composer inyecta de las categorías elegidas. */
export function categoryGuides(built: BuiltItem[]): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const { item } of built) {
    const a = item.allow;
    if (!a) continue;
    const key = a.kind === 'block' ? `block-${a.role ?? a.category ?? 'other'}` : (a.category ?? 'other');
    const nest = a.accepts.length ? `anida: ${a.accepts.map((x) => x.prop).join(',')}` : 'hoja';
    const line = `- \`${item.name}\` · ${a.export} · [${[a.propless ? 'propless' : '', nest].filter(Boolean).join(' · ')}] · ${a.summary ?? ''}`.trimEnd();
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return Object.fromEntries([...groups].map(([k, lines]) => [k, `# ${k}\n\n${lines.sort().join('\n')}\n`]));
}

const EXPORT_FROM_RE = /^export\b[^;]*?\bfrom\s+["']([^"']+)["'];?$/gm;
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx'];

/** La portada puede partir un archivo del vault en varios (#296: plan-comparison-data.ts); el registry.json del vault no
 * los lista, así que lo que un archivo del item importa en relativo y existe en el scaffold entra al item también.
 * Transitivo, sin salir del scaffold y sin pisar lo ya listado. */
export function withPortedSiblings(files: { path: string; content: string }[], scaffoldRoot: string): { path: string; content: string }[] {
  const out = [...files];
  const have = new Set(out.map((f) => f.path));
  for (let i = 0; i < out.length; i++) {
    if (!/\.tsx?$/.test(out[i].path)) continue;
    for (const spec of importsOf(out[i].content)) {
      if (!spec.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(out[i].path), spec));
      if (RESOLVE_EXTS.some((e) => have.has(base + e))) continue;
      const ext = RESOLVE_EXTS.find((e) => existsSync(join(scaffoldRoot, base + e)) && /\.(tsx?|css)$/.test(base + e));
      if (ext === undefined) continue;
      have.add(base + ext);
      out.push({ path: base + ext, content: readFileSync(join(scaffoldRoot, base + ext), 'utf8') });
    }
  }
  return out;
}

/** Specifiers de import/re-export a nivel de módulo. Anclado a inicio de línea para no contar los
 * ejemplos de código que algunos bloques llevan dentro de strings. */
const SIDE_EFFECT_RE = /^import\s+["']([^"']+)["'];?$/gm;

export function importsOf(content: string): string[] {
  return [...content.matchAll(IMPORT_RE), ...content.matchAll(EXPORT_FROM_RE), ...content.matchAll(SIDE_EFFECT_RE)].map((m) => m[1]);
}

// Los da el starter (React como peer, next/image por alias) y los módulos de Node no se instalan.
const PROVIDED = new Set(['react', 'react-dom', 'next']);

/** dependencies npm del item según sus imports reales (convención shadcn: el item declara lo suyo), con
 * el rango del starter (`gsap@^3.15.0`). Lo declarado en el vault no alcanza: los motion importan gsap
 * sin declararlo y solo resolvían porque el scaffold ya lo trae. */
export function npmDepsOf(files: RegistryFile[], starterVersions: Record<string, string>): string[] {
  const pkgs = new Set<string>();
  for (const f of files.filter((x) => /\.tsx?$/.test(x.path))) {
    for (const spec of importsOf(f.content)) {
      if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('node:')) continue;
      const pkg = packageOf(spec);
      if (!PROVIDED.has(pkg)) pkgs.add(pkg);
    }
  }
  return [...pkgs].sort().map((p) => (starterVersions[p] ? `${p}@${starterVersions[p]}` : p));
}

/** Gate de publicación: todo import de un item tiene que resolverse dentro de su clausura de
 * registryDependencies, ser un alias del starter o ser un paquete npm declarado por el item
 * o por el starter. Un item que no compila en un workspace limpio no se publica. */
const localOf = (fromPath: string, spec: string): string | null =>
  spec in STARTER_ALIASES ? null : spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(fromPath), spec)) : spec.startsWith('@/') ? `src/${spec.slice(2)}` : null;

/** El item dueño de una carpeta. Los items de Arc llevan dentro los archivos de sus deps (api-keys trae button.tsx), así
 * que "tener archivos ahí" no basta: gana el item que se llama como la carpeta; si no lo hay, el importador si ya tiene
 * archivos ahí; si no, el más chico de los que los tengan (el más específico). Sin dueño, closureProblems lo reporta. */
function ownerOf(path: string, items: readonly RegistryItem[], importer: RegistryItem): RegistryItem | undefined {
  const dir = posix.dirname(path);
  const inDir = (i: RegistryItem) => i.files.some((f) => posix.dirname(f.path) === dir);
  const named = items.find((i) => i.name === posix.basename(dir) && inDir(i));
  if (named) return named;
  if (inDir(importer)) return importer;
  return [...items.filter(inDir)].sort((a, b) => a.files.length - b.files.length)[0];
}

/** Imports locales que caen fuera de la clausura pero existen en el scaffold: la portada añadió el archivo y el vault no lo
 * lista (#308: arc/button/action-variant.ts, importado por los heros Morphin y relume/action). El archivo entra al item
 * dueño de su carpeta y el importador gana ese item como registryDependency. Fixpoint: lo adoptado puede importar más.
 * Devuelve copias; no toca los items de entrada. */
export function adoptPortedImports(items: readonly RegistryItem[], scaffoldRoot: string): { items: RegistryItem[]; adopted: string[] } {
  const out = items.map((i) => ({ ...i, files: [...i.files], registryDependencies: [...i.registryDependencies] }));
  const byName = new Map(out.map((i) => [i.name, i]));
  const adopted: string[] = [];
  for (let round = 0, changed = true; changed && round < 20; round++) {
    changed = false;
    for (const item of out) {
      const have = new Set(closure([item.name], (n) => byName.get(n)?.registryDependencies ?? []).flatMap((n) => byName.get(n)?.files.map((f) => f.path) ?? []));
      for (const f of item.files.filter((x) => /\.tsx?$/.test(x.path))) {
        for (const spec of importsOf(f.content)) {
          const local = localOf(f.path, spec);
          if (local === null || RESOLVE_EXTS.some((e) => have.has(local + e))) continue;
          const ext = RESOLVE_EXTS.find((e) => /\.(tsx?|css)$/.test(local + e) && existsSync(join(scaffoldRoot, local + e)));
          if (ext === undefined) continue;
          const path = local + ext;
          const owner = ownerOf(path, out, item);
          if (!owner) continue;
          if (!owner.files.some((x) => x.path === path)) {
            owner.files.push({ path, content: readFileSync(join(scaffoldRoot, path), 'utf8') });
            adopted.push(`${owner.name}: ${path}`);
          }
          if (owner !== item && !item.registryDependencies.includes(owner.name)) item.registryDependencies = [...item.registryDependencies, owner.name].sort();
          have.add(path);
          changed = true;
        }
      }
    }
  }
  return { items: out, adopted };
}

export function closureProblems(items: RegistryItem[], starterNpm: ReadonlySet<string>): string[] {
  const byName = new Map(items.map((i) => [i.name, i]));
  const problems: string[] = [];
  for (const item of items) {
    const files = new Set(closure([item.name], (n) => byName.get(n)?.registryDependencies ?? []).flatMap((n) => byName.get(n)?.files.map((f) => f.path) ?? []));
    const npm = new Set(item.dependencies.map((d) => d.replace(/(.)@[^@]*$/, '$1')));
    for (const f of item.files.filter((x) => /\.tsx?$/.test(x.path))) {
      for (const spec of importsOf(f.content)) {
        // Un alias del starter lo resuelve el workspace, no la clausura.
        if (spec in STARTER_ALIASES) continue;
        const local = (spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(f.path), spec)) : spec.startsWith('@/') ? `src/${spec.slice(2)}` : null);
        if (local !== null) {
          if (!RESOLVE_EXTS.some((e) => files.has(local + e))) problems.push(`${item.name}: ${f.path} importa ${spec}, fuera de su clausura`);
        } else {
          const pkg = packageOf(spec);
          if (spec.startsWith('node:') || PROVIDED.has(pkg)) continue;
          if (!starterNpm.has(pkg)) problems.push(`${item.name}: ${f.path} importa ${spec}, paquete que el starter no instala`);
          else if (!npm.has(pkg)) problems.push(`${item.name}: ${f.path} importa ${spec}, paquete no declarado`);
        }
      }
    }
  }
  return problems;
}

export interface RenderGateRecord {
  sha: string;
  result: 'ok' | 'fail';
  at: string;
}

/** Gates de un item a partir de datos que ya existen; lo que no se corrió queda 'none'. */
export function itemGates(item: RegistryItem, catalogGate: { ok: boolean } | null | undefined, render: Record<string, RenderGateRecord>): ItemGates {
  const examples = (item.schema as { examples?: unknown[] } | null)?.examples;
  const schemaDemo: GateResult = item.schema && Array.isArray(examples) && examples.length
    ? examples.every((ex) => validate(item.schema as JsonSchema, ex).length === 0) ? 'ok' : 'fail'
    : 'none';
  const run = render[item.name];
  return {
    static: catalogGate ? (catalogGate.ok ? 'ok' : 'fail') : 'none',
    schemaDemo,
    renderGate: run && run.sha === filesSha(item.files) ? run.result : 'none',
  };
}

/** Gate estático de un item Arc del vault, con las mismas entradas que catalog-ingest. El ingest no gatea
 * lo curado a mano (lo deja tal cual en el índice), así que sin esto esos blocks salían static 'none'. */
export function staticGateOf(vaultRoot: string, scaffoldRoot: string): (slug: string) => CatalogGate | undefined {
  const items = [...scanArc(vaultRoot, 'block'), ...scanArc(vaultRoot, 'component')];
  const byslug = new Map<string, ArcScanItem>(items.map((i) => [i.slug, i]));
  const pkg = JSON.parse(readFileSync(join(scaffoldRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const declaredNpm = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  return (slug) => {
    const item = byslug.get(slug);
    if (!item) return undefined;
    const exportName = item.tsx ? arcExportOf(slug, item.tsx)?.name : undefined;
    const surface = item.kind === 'block' ? arcSurfaceOf(item, vaultRoot) : undefined;
    return gateArc(item, { vaultRoot, scaffoldRoot, declaredNpm, byslug, exportName, surface });
  };
}

/** Componentes (ui/block) sin AllowEntry: entraron solo por la clausura y el catálogo los dejó fuera, así
 * que el composer no los ve (loadIndex los omite) aunque otros dependan de ellos. */
export const missingAllow = (items: RegistryItem[]): string[] => items.filter((i) => i.type !== 'registry:lib' && !i.allow).map((i) => i.name);

/** Trinquete: un hueco que ya estaba publicado se tolera con aviso, uno nuevo frena. El hueco solo puede
 * achicarse y no hace falta una excepción por nombre. */
export function ratchet(current: string[], previous: ReadonlySet<string>): { blocked: string[]; tolerated: string[] } {
  return { blocked: current.filter((n) => !previous.has(n)), tolerated: current.filter((n) => previous.has(n)) };
}

/** Del índice publicado: los items sin allow (libs y motion incluidos; ratchet solo los cruza con componentes). */
export const withoutAllow = (index: RegistryIndex): Set<string> => new Set(Object.entries(index.items).filter(([, v]) => !v.allow).map(([k]) => k));
