// Export de una versión (H9): el código por `git archive` del commit y el sitio desde el snapshot de dist, que no está en
// git. Sin dependencias: git trae el zip del código y el del sitio es un ZIP "store" (sin compresión) sobre zlib.crc32.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { extname, join, posix, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { gitEnv } from './git-env';

export const EXPORT_FORMATS = ['source', 'site', 'design-md', 'brief', 'page'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/** Tope del archivo exportado; por encima, 413. Un ws normal pesa unos pocos MB. */
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;

export class ExportTooLarge extends Error {}
/** La versión tiene algo que no se exporta (symlinks en el árbol). */
export class ExportRefused extends Error {}

const GIT_TIMEOUT_MS = 30_000;
export const MAX_ENTRIES = 65_535; // sin ZIP64 el directorio central cuenta en 16 bits; igual tope para el árbol del MCP

export const parseExportFormat = (raw: string | null): ExportFormat | undefined =>
  (EXPORT_FORMATS as readonly string[]).includes(raw ?? '') ? (raw as ExportFormat) : undefined;

/** kebab-case ASCII del título (sin acentos ni símbolos); vacío → "pagina". */
export function exportSlug(title: string): string {
  const s = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return s || 'pagina';
}

export function exportFilename(title: string, sha: string, format: ExportFormat): string {
  const slug = exportSlug(title);
  const sha7 = sha.slice(0, 7);
  if (format === 'source') return `${slug}-${sha7}-codigo.zip`;
  if (format === 'site') return `${slug}-${sha7}-sitio.zip`;
  if (format === 'design-md') return 'DESIGN.md';
  if (format === 'page') return `${slug}-${sha7}.html`;
  return `${slug}-brief.md`;
}

const SHA = /^[0-9a-f]{40}$/;

/** P1 (H9, export-zip-mcp.md §4, decisión B): archivos del commit que no son la página y no salen en el export ni en el
 * árbol del MCP. `request.json`/`instructions.json` llevan el prompt, la memoria y los hechos de la marca, y rutas de
 * adjuntos del servidor; quien descarga o lee quiere la página, no eso. */
export const SOURCE_EXCLUDE = ['request.json', 'instructions.json'] as const;

/** Todo lo commiteado en `commit` (sin .wt ni node_modules, que git ignora) bajo `<prefix>/`, menos `SOURCE_EXCLUDE`. */
export function sourceZip(dir: string, commit: string, prefix: string): Buffer {
  if (!SHA.test(commit)) throw new Error(`export: commit inválido ${commit}`);
  // El .git del ws lo puede tocar el agente: sin config global/sistema ni fsmonitor, y con tope de tiempo.
  const opts = { cwd: dir, maxBuffer: EXPORT_MAX_BYTES, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' as const, env: gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }) };
  const git = (args: string[]): Buffer => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', ...args], opts);
  try {
    // Un symlink commiteado sale como symlink en el zip y apunta fuera de la carpeta al extraerlo.
    if (/^120000 /m.test(git(['ls-tree', '-r', commit]).toString('utf8'))) throw new ExportRefused('la versión tiene symlinks en el árbol: no se exporta');
    return git(['archive', '--format=zip', `--prefix=${prefix}/`, commit, '--', '.', ...SOURCE_EXCLUDE.map((p) => `:(exclude)${p}`)]);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOBUFS') throw new ExportTooLarge(`el código pasa de ${EXPORT_MAX_BYTES} bytes`);
    throw e;
  }
}

// `\`, `:` y controles son legales en un nombre de Linux pero separadores o unidades al extraer en Windows (zip-slip).
const UNSAFE_NAME = /[\\:\x00-\x1f]/;

/** Archivos regulares de `root` con su ruta relativa y tamaño. No sigue symlinks (mismo criterio que saveDist), omite
 * `.base` (marcador interno) y los nombres inseguros; corta por tamaño y cantidad antes de leer nada. */
function distFiles(root: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  let total = 0;
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (UNSAFE_NAME.test(name)) continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile() || r === '.base') continue;
      total += st.size;
      if (total > EXPORT_MAX_BYTES) throw new ExportTooLarge(`el sitio pasa de ${EXPORT_MAX_BYTES} bytes`);
      if (out.push({ rel: r, size: st.size }) > MAX_ENTRIES) throw new ExportTooLarge(`el sitio pasa de ${MAX_ENTRIES} archivos`);
    }
  };
  walk('');
  return out;
}

/** Lee `rel` sin seguir symlinks: O_NOFOLLOW en el último componente y realpath bajo `root` para los intermedios, contra
 * un cambio entre el lstat del recorrido y la lectura. El tamaño es el del fd, no el del lstat. */
function readInside(root: string, rootReal: string, rel: string, size: number): Buffer {
  const p = join(root, rel);
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !realpathSync(p).startsWith(rootReal + sep)) throw new ExportRefused(`export: ${rel} cambió durante el export`);
    if (st.size !== size) throw new ExportRefused(`export: ${rel} cambió durante el export`);
    const buf = Buffer.alloc(st.size);
    for (let off = 0; off < buf.length; ) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

// Fecha DOS fija (1980-01-01): el mismo dist da los mismos bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** ZIP store (APPNOTE 4.3: local header + datos + central directory + EOCD), sin ZIP64: el tope queda muy por debajo de 4 GB. */
export function siteZip(distDir: string, prefix: string): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const rootReal = realpathSync(distDir);
  for (const { rel, size } of distFiles(distDir)) {
    const data = readInside(distDir, rootReal, rel, size);
    const name = Buffer.from(`${prefix}/${rel}`, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const MIME: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

/** `index.html` del dist en UN archivo: hojas y scripts inline, el resto (imágenes, fuentes, url() del CSS) como data:.
 * Sin red ni archivos hermanos, para pegarlo o abrirlo tal cual. Referencias que salen del dist o no existen se dejan
 * como están.
 * HACK: un script con imports dinámicos a otros chunks no se puede inlinar y se rompe; el build de una landing es un
 * solo bundle. Partir en chunks o reescribir los imports cuando un build lo pida. */
export function pageHtml(distDir: string): string {
  const rootReal = realpathSync(distDir);
  const files = new Map(distFiles(distDir).map((f) => [f.rel, f.size]));
  if (!files.has('index.html')) throw new ExportRefused('el dist no tiene index.html');
  let budget = EXPORT_MAX_BYTES;
  const read = (base: string, ref: string): { rel: string; data: Buffer } | undefined => {
    const clean = ref.split(/[?#]/)[0] ?? '';
    if (!clean || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(clean)) return undefined;
    const rel = clean.startsWith('/') ? posix.normalize(clean.slice(1)) : posix.normalize(posix.join(posix.dirname(base), clean));
    const size = files.get(rel);
    if (size === undefined) return undefined;
    budget -= size;
    if (budget < 0) throw new ExportTooLarge(`la página pasa de ${EXPORT_MAX_BYTES} bytes`);
    return { rel, data: readInside(distDir, rootReal, rel, size) };
  };
  const dataUri = (rel: string, data: Buffer): string => `data:${MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'};base64,${data.toString('base64')}`;
  const inlineUrls = (css: string, base: string): string =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q: string, ref: string) => {
      const f = read(base, ref);
      return f ? `url(${q}${dataUri(f.rel, f.data)}${q})` : m;
    });
  const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined);
  const html = readInside(distDir, rootReal, 'index.html', files.get('index.html') as number).toString('utf8');
  return html
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const href = attr(tag, 'href');
      if (!href) return tag;
      const f = read('index.html', href);
      if (!f) return tag;
      if (/\srel\s*=\s*["']?stylesheet/i.test(tag)) return `<style>${inlineUrls(f.data.toString('utf8'), f.rel).replace(/<\/style/gi, '<\\/style')}</style>`;
      return tag.replace(href, dataUri(f.rel, f.data));
    })
    .replace(/<script\b([^>]*)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)><\/script>/gi, (tag, pre: string, d: string | undefined, sq: string | undefined, post: string) => {
      const f = read('index.html', d ?? sq ?? '');
      if (!f) return tag;
      const attrs = `${pre} ${post}`.replace(/\scrossorigin(=("[^"]*"|'[^']*'))?/gi, '').replace(/\s+/g, ' ').trimEnd();
      return `<script${attrs}>${f.data.toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
    })
    .replace(/<(img|source)\b[^>]*>/gi, (tag) => {
      const src = attr(tag, 'src');
      const f = src ? read('index.html', src) : undefined;
      return f && src ? tag.replace(src, dataUri(f.rel, f.data)) : tag;
    });
}
