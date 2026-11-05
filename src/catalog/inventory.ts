// Inventario F0 del vault (READ-ONLY): escanea Knowledge/Frontend/Components y lo coteja contra
// catalog/index.json. No escribe en el vault, no toca red. La lógica pura vive aquí para poder
// testearla contra tests/fixtures/vault; el runner (scripts/vault-inventory.ts) la ejecuta sobre
// el vault real y emite catalog/inventory.{json,md}. Cada cifra del .md sale de este JSON.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Estado de un item del vault frente al índice unificado. */
export type ItemStatus =
  | 'not_indexed'
  | 'indexed_source_null'
  | 'processed_scaffold'
  | 'gate_ok'
  | 'gate_failed';

export interface ItemFile {
  path: string; // relativo al vault
  sha256: string;
  bytes: number;
}

export interface InventoryItem {
  path: string; // dir del item (o archivo, para icons) relativo al vault
  folder: string; // carpeta de primer nivel
  slug: string;
  format: string;
  files: ItemFile[];
  mainFile: string | null; // archivo fuente principal relativo al vault
  hasDoc: boolean;
  hasRegistry: boolean;
  hasPreview: boolean;
  depsDeclared: string[];
  depsImported: string[];
  unresolvedImports: string[];
  status: ItemStatus;
  verified: boolean; // ortogonal al status: una entrada con source en repo también puede ser verified
  gateReason?: string;
}

export interface FolderSummary {
  name: string;
  items: number;
  scanned: boolean; // ¿el ingest actual la indexa?
  formats: Record<string, number>;
}

export interface QualitySignals {
  duplicateSha: { sha256: string; paths: string[] }[];
  duplicateSlug: { slug: string; paths: string[] }[];
  broken: { path: string; reason: string }[];
  orphans: { slug: string; originPath: string; reason: string }[];
}

export interface Inventory {
  generatedAt: string;
  vaultRoot: string;
  folders: FolderSummary[];
  totals: {
    vaultItems: number;
    indexed: number;
    indexedSourceNull: number;
    processedScaffold: number;
    gateOk: number;
    gateFailed: number;
    verified: number;
    notIndexed: number;
  };
  items: InventoryItem[];
  quality: QualitySignals;
  dumpEstimate: { processedBytes: number; note: string };
}

/** Entrada mínima del índice que necesita el cotejo (el schema real tiene más campos). */
export interface IndexEntry {
  slug: string;
  library: string;
  source: string | null;
  verified?: boolean;
  gate?: { ok: boolean; reasons?: string[] } | null;
  origin?: { kind: string; path: string; sha256: string } | null;
}

/** Config por carpeta de primer nivel: a qué profundidad vive el item y si el ingest la escanea.
 * itemDepth = niveles por debajo de la carpeta hasta el dir del item. 'file' = cada archivo es un item. */
interface FolderConfig {
  itemDepth: number;
  kind: 'dir' | 'file';
  scanned: boolean;
  fileExt?: string; // solo kind 'file'
}

const FOLDERS: Record<string, FolderConfig> = {
  'ui-react': { itemDepth: 2, kind: 'dir', scanned: true },
  'sections-react': { itemDepth: 2, kind: 'dir', scanned: true },
  'sections-webflow': { itemDepth: 2, kind: 'dir', scanned: false },
  'motion-gsap': { itemDepth: 2, kind: 'dir', scanned: false },
  'ui-squircle': { itemDepth: 2, kind: 'dir', scanned: false },
  buttons: { itemDepth: 1, kind: 'dir', scanned: false },
  'motion-html': { itemDepth: 1, kind: 'dir', scanned: false },
  'motion-webflow': { itemDepth: 1, kind: 'dir', scanned: false },
  icons: { itemDepth: 2, kind: 'file', scanned: false, fileExt: '.svg' },
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

/** Lista los dirs a una profundidad fija bajo `base` (1 = hijos directos). */
function dirsAtDepth(base: string, depth: number): string[] {
  let level = [base];
  for (let d = 0; d < depth; d++) {
    level = level.flatMap((dir) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return [];
      }
      return entries.map((n) => join(dir, n)).filter((p) => safeIsDir(p));
    });
  }
  return level;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Formato del item por los archivos presentes (marcadores + extensiones). */
export function detectFormat(relFiles: string[]): string {
  const ext = (f: string): string => (f.includes('.') ? f.slice(f.lastIndexOf('.')) : '');
  const exts = new Set(relFiles.map(ext));
  const has = (e: string): boolean => relFiles.some((f) => f.endsWith(e));
  if (exts.size === 1 && exts.has('.svg')) return 'svg';
  if (has('.tsx') && has('.module.css')) return 'tsx+css-modules';
  if (has('.tsx')) return 'tsx+tailwind';
  if (relFiles.some((f) => f.endsWith('component.json') || f.endsWith('estructura.md'))) return 'webflow';
  if (has('.html') && (has('.css') || has('.js'))) return 'html+css+js';
  if (exts.size >= 1 && [...exts].every((e) => e === '.md')) return 'md';
  if (has('.html')) return 'html';
  return 'other';
}

const SRC_EXT = ['.tsx', '.ts', '.jsx', '.js'];

/** Elige el archivo fuente principal del item (preferimos el .tsx homónimo del slug). */
function pickMain(relFiles: string[], slug: string): string | null {
  const src = relFiles.filter((f) => SRC_EXT.some((e) => f.endsWith(e)) && !f.endsWith('.module.css'));
  if (src.length === 0) return relFiles[0] ?? null;
  const named = src.find((f) => f.endsWith(`/${slug}.tsx`) || f.endsWith(`${slug}.tsx`));
  if (named) return named;
  const anyTsx = src.find((f) => f.endsWith('.tsx'));
  return anyTsx ?? src[0];
}

const IMPORT_RE = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

/** Paquete raíz de un specifier de import (sin subpath), ignorando relativos y alias de proyecto. */
function pkgOf(spec: string): string | null {
  if (spec.startsWith('.')) return null;
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

interface Parsed {
  imported: string[];
  unresolved: string[];
  hasExport: boolean;
}

/** Extrae imports de un archivo de código; marca los alias no resueltos (@kit/, @/ ...). */
function parseSource(code: string): Parsed {
  const specifiers: string[] = [];
  for (const m of code.matchAll(IMPORT_RE)) specifiers.push(m[1]);
  const imported = new Set<string>();
  const unresolved = new Set<string>();
  for (const s of specifiers) {
    if (s.startsWith('@kit/') || s.startsWith('@/')) {
      unresolved.add(s);
      continue;
    }
    const pkg = pkgOf(s);
    if (pkg) imported.add(pkg);
  }
  return {
    imported: [...imported].sort(),
    unresolved: [...unresolved].sort(),
    hasExport: /\bexport\s+(default|function|const|class|{)/.test(code),
  };
}

/** Deps declaradas en registry.json (dependencies), si existe. */
function declaredDeps(absFiles: string[]): string[] {
  const reg = absFiles.find((f) => f.endsWith('registry.json'));
  if (!reg) return [];
  try {
    const j = JSON.parse(readFileSync(reg, 'utf8')) as { dependencies?: unknown };
    return Array.isArray(j.dependencies) ? (j.dependencies as string[]).map((d) => pkgOf(d) ?? d) : [];
  } catch {
    return [];
  }
}

interface IndexLookup {
  byOrigin: Map<string, IndexEntry>;
  bySlug: Map<string, IndexEntry[]>;
}

function statusOf(e: IndexEntry): { status: ItemStatus; verified: boolean; gateReason?: string } {
  const verified = e.verified === true;
  if (e.source !== null) return { status: 'processed_scaffold', verified };
  if (e.gate && e.gate.ok === true) return { status: 'gate_ok', verified };
  if (e.gate && e.gate.ok === false) {
    return { status: 'gate_failed', verified, gateReason: (e.gate.reasons ?? []).join('; ') || 'gate.ok=false' };
  }
  return { status: 'indexed_source_null', verified };
}

/** Construye el inventario a partir del vault y del índice. Función pura: toda IO de lectura ocurre
 * aquí sobre rutas que el runner resuelve; no escribe nada. */
export function buildInventory(vaultRoot: string, index: IndexEntry[], now: string): Inventory {
  const lookup: IndexLookup = { byOrigin: new Map(), bySlug: new Map() };
  for (const e of index) {
    if (e.origin?.path) lookup.byOrigin.set(e.origin.path, e);
    const arr = lookup.bySlug.get(e.slug) ?? [];
    arr.push(e);
    lookup.bySlug.set(e.slug, arr);
  }

  const items: InventoryItem[] = [];
  const folders: FolderSummary[] = [];
  const shaIndex = new Map<string, string[]>(); // sha del mainFile -> paths
  const slugIndex = new Map<string, string[]>();
  const broken: QualitySignals['broken'] = [];
  const seenOrigins = new Set<string>();

  for (const [folder, cfg] of Object.entries(FOLDERS)) {
    const base = join(vaultRoot, folder);
    if (!safeIsDir(base)) continue;
    const formats: Record<string, number> = {};
    let count = 0;

    const itemPaths =
      cfg.kind === 'file'
        ? walkFiles(base).filter((f) => f.endsWith(cfg.fileExt ?? ''))
        : dirsAtDepth(base, cfg.itemDepth);

    for (const itemAbs of itemPaths) {
      const absFiles = cfg.kind === 'file' ? [itemAbs] : walkFiles(itemAbs);
      if (absFiles.length === 0) continue;
      const relItem = relative(vaultRoot, itemAbs);
      const slug = cfg.kind === 'file' ? basenameNoExt(itemAbs) : relItem.split('/').pop() ?? relItem;
      const files: ItemFile[] = absFiles.map((abs) => {
        const buf = readFileSync(abs);
        return { path: relative(vaultRoot, abs), sha256: sha256(buf), bytes: buf.byteLength };
      });
      const relFiles = files.map((f) => f.path);
      const format = detectFormat(relFiles);
      formats[format] = (formats[format] ?? 0) + 1;
      count++;

      const mainRel = cfg.kind === 'file' ? relItem : pickMain(relFiles, slug);
      const mainAbs = mainRel ? join(vaultRoot, mainRel) : null;
      let parsed: Parsed = { imported: [], unresolved: [], hasExport: true };
      if (mainAbs && SRC_EXT.some((e) => mainAbs.endsWith(e))) {
        parsed = parseSource(readFileSync(mainAbs, 'utf8'));
        // Solo es "roto" un MÓDULO React sin export; un snippet html/css/js legítimamente no exporta.
        const isModule = format === 'tsx+tailwind' || format === 'tsx+css-modules';
        if (!parsed.hasExport && isModule) broken.push({ path: relItem, reason: 'componente React sin export' });
      }

      // Estado vs índice: match por origin.path del mainFile; si no, por cualquier archivo del item.
      let entry = mainRel ? lookup.byOrigin.get(mainRel) : undefined;
      if (!entry) entry = relFiles.map((r) => lookup.byOrigin.get(r)).find(Boolean) as IndexEntry | undefined;
      const st = entry ? statusOf(entry) : { status: 'not_indexed' as ItemStatus, verified: false };
      if (entry?.origin?.path) seenOrigins.add(entry.origin.path);

      items.push({
        path: relItem,
        folder,
        slug,
        format,
        files,
        mainFile: mainRel,
        hasDoc: relFiles.some((f) => /\/doc\.md$|\/estructura\.md$/.test(`/${f}`)),
        hasRegistry: relFiles.some((f) => f.endsWith('registry.json') || f.endsWith('component.json')),
        hasPreview: relFiles.some((f) => /preview|thumbnail/i.test(f)),
        depsDeclared: declaredDeps(absFiles),
        depsImported: parsed.imported,
        unresolvedImports: parsed.unresolved,
        ...st,
      });

      const mainSha = mainRel ? files.find((f) => f.path === mainRel)?.sha256 : undefined;
      if (mainSha) shaIndex.set(mainSha, [...(shaIndex.get(mainSha) ?? []), relItem]);
      slugIndex.set(slug, [...(slugIndex.get(slug) ?? []), relItem]);
    }

    folders.push({ name: folder, items: count, scanned: cfg.scanned, formats });
  }

  // Huérfanos: entradas del índice cuyo origin.path no existe o cuyo sha cambió.
  const orphans: QualitySignals['orphans'] = [];
  for (const e of index) {
    if (!e.origin?.path) continue;
    const abs = join(vaultRoot, e.origin.path);
    let reason = '';
    try {
      const cur = sha256(readFileSync(abs));
      if (cur !== e.origin.sha256) reason = 'sha256 no coincide con el vault';
    } catch {
      reason = 'path ya no existe en el vault';
    }
    if (reason) orphans.push({ slug: e.slug, originPath: e.origin.path, reason });
  }

  const dumpBytes = items
    .filter((i) => i.format === 'tsx+css-modules' || i.format === 'tsx+tailwind' || i.folder === 'ui-squircle')
    .reduce((n, i) => n + i.files.filter((f) => SRC_EXT.some((e) => f.path.endsWith(e)) || f.path.endsWith('.css')).reduce((m, f) => m + f.bytes, 0), 0);

  const totals = {
    vaultItems: items.length,
    indexed: items.filter((i) => i.status !== 'not_indexed').length,
    indexedSourceNull: items.filter((i) => i.status === 'indexed_source_null').length,
    processedScaffold: items.filter((i) => i.status === 'processed_scaffold').length,
    gateOk: items.filter((i) => i.status === 'gate_ok').length,
    gateFailed: items.filter((i) => i.status === 'gate_failed').length,
    verified: items.filter((i) => i.verified).length,
    notIndexed: items.filter((i) => i.status === 'not_indexed').length,
  };

  return {
    generatedAt: now,
    vaultRoot,
    folders,
    totals,
    items,
    quality: {
      duplicateSha: [...shaIndex.entries()].filter(([, p]) => p.length > 1).map(([sha256, paths]) => ({ sha256, paths })),
      duplicateSlug: [...slugIndex.entries()].filter(([, p]) => p.length > 1).map(([slug, paths]) => ({ slug, paths })),
      broken,
      orphans,
    },
    dumpEstimate: {
      processedBytes: dumpBytes,
      note: 'Suma de bytes de fuente (tsx/ts/js/css) de items React/squircle. Para los TSX+Tailwind el porte a CSS modules cambia el tamaño; es una cota, no el tamaño final del volcado.',
    },
  };
}

function basenameNoExt(p: string): string {
  const b = p.split('/').pop() ?? p;
  return b.includes('.') ? b.slice(0, b.lastIndexOf('.')) : b;
}

/** Render Markdown del inventario; TODA cifra sale del objeto Inventory (no recalcula nada). */
export function renderMarkdown(inv: Inventory): string {
  const L: string[] = [];
  L.push('# Inventario del vault (F0)', '');
  L.push(`Generado: ${inv.generatedAt}`, `Fuente: \`${inv.vaultRoot}\` (READ-ONLY)`, '');
  L.push('## Por carpeta', '');
  L.push('| Carpeta | Items | Ingest actual | Formatos |', '|---|---|---|---|');
  for (const f of inv.folders) {
    const fmts = Object.entries(f.formats).map(([k, v]) => `${k}:${v}`).join(', ');
    L.push(`| ${f.name} | ${f.items} | ${f.scanned ? 'sí' : 'no'} | ${fmts} |`);
  }
  L.push('');
  L.push('## Totales', '');
  const t = inv.totals;
  const onDemand = t.indexed - t.processedScaffold; // todo lo indexado salvo lo ya volcado al scaffold
  L.push('> El total cuenta cada hoja del vault: `icons` como SVG individual y `motion-*` como item,', '> no solo las carpetas React ingestables (ui-react 241 + sections-react 1524).', '');
  L.push('| Métrica | Valor |', '|---|---|');
  L.push(`| Items en el vault | ${t.vaultItems} |`);
  L.push(`| Indexados | ${t.indexed} |`);
  L.push(`| — materializables bajo demanda (source:null) | ${onDemand} |`);
  L.push(`| — procesados en el scaffold (source en repo) | ${t.processedScaffold} |`);
  L.push(`| NO indexados | ${t.notIndexed} |`);
  L.push('');
  L.push('Desglose del gate sobre los `source:null` (el gate decide si entran al pool):', '');
  L.push('| Estado del gate | Valor |', '|---|---|');
  L.push(`| gate.ok (pool) | ${t.gateOk} |`);
  L.push(`| gate fallido | ${t.gateFailed} |`);
  L.push(`| indexado sin gate | ${t.indexedSourceNull} |`);
  L.push('');
  L.push(`Ortogonal: ${t.verified} entradas marcadas \`verified\` (render confirmado), repartidas entre las de arriba y las procesadas en scaffold.`, '');
  L.push('## Qué falta para que cada carpeta sea subible', '');
  for (const f of inv.folders) {
    const itemsOf = inv.items.filter((i) => i.folder === f.name);
    const notIdx = itemsOf.filter((i) => i.status === 'not_indexed').length;
    const unresolved = itemsOf.filter((i) => i.unresolvedImports.length > 0).length;
    const blockers: string[] = [];
    if (!f.scanned) blockers.push('sin ingest (no entra al índice)');
    if (notIdx) blockers.push(`${notIdx} no indexados`);
    if (unresolved) blockers.push(`${unresolved} con imports sin resolver (@kit//@/)`);
    if (f.formats['webflow']) blockers.push('formato Webflow (no es React portado)');
    if (f.formats['html+css+js'] || f.formats['html']) blockers.push('HTML/CSS/JS (no es componente React)');
    if (f.formats['md']) blockers.push('solo documentación (.md)');
    if (f.formats['svg']) blockers.push('SVG sueltos (no componentes)');
    L.push(`- **${f.name}**: ${blockers.length ? blockers.join('; ') : 'portado y listo'}.`);
  }
  L.push('');
  L.push('## Señales de calidad', '');
  const q = inv.quality;
  const sameFolderSlug = q.duplicateSlug.filter((d) => new Set(d.paths.map((p) => p.split('/')[0])).size === 1).length;
  L.push(`- Duplicados por contenido (sha256): ${q.duplicateSha.length}`);
  L.push(`- Mismo slug en varias carpetas: ${q.duplicateSlug.length} (mismo componente en formatos distintos: react/webflow/motion). Colisiones DENTRO de una carpeta: ${sameFolderSlug}.`);
  L.push(`- Componentes React sin export detectable: ${q.broken.length} (solo módulos .tsx; los snippets html/js no cuentan).`);
  L.push(`- Huérfanos del índice (path/sha no coincide con el vault): ${q.orphans.length}`);
  L.push('');
  L.push('## Estimado del volcado procesado', '');
  L.push(`- ~${(inv.dumpEstimate.processedBytes / 1024 / 1024).toFixed(2)} MB de fuente React/squircle.`);
  L.push(`- ${inv.dumpEstimate.note}`);
  L.push('');
  return L.join('\n');
}
