// Brand packs en el registry: la marca viaja por petición (page.brand = id) y se resuelve contra el mismo
// índice fijado por pin que los componentes, no contra el cwd del server. Un pack publicado es un JSON
// inmutable brands/<id>@<sha>.json con solo lo que applyBrand lee (layout documentado en brand.ts);
// el runner lo baja a un directorio y applyBrand lo aplica igual que a un pack local.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path';
import { loadBrandPack, type ParseBrandOptions } from './brand';
import { FACTS_FILE } from './brand-facts';
import { DESIGN_FILE } from './identity-design';

export const BRAND_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRAND_ID_MAX = 40;
export const isBrandId = (v: unknown): v is string => typeof v === 'string' && v.length <= BRAND_ID_MAX && BRAND_ID.test(v);

/** Carpeta de un pack junto al repo: brand-pack es "base", brand-pack-<id> es <id>. */
export const brandDirName = (id: string): string => (id === 'base' ? 'brand-pack' : `brand-pack-${id}`);
export function brandIdOfDir(name: string): string | undefined {
  if (name === 'brand-pack') return 'base';
  const id = /^brand-pack-(.+)$/.exec(name)?.[1];
  return id && isBrandId(id) ? id : undefined;
}

export interface BrandPackItem {
  id: string;
  name: string;
  files: { path: string; base64: string }[];
}

// Lo que viaja al Blob es un pack de marca, no la carpeta: solo fuentes y su css. Un symlink se rechaza
// porque readFileSync lo seguiría y publicaría un archivo de fuera del pack.
const FONT_FILE = /\.(woff2?|ttf|otf|css)$/i;
function fontFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`brand registry: ${path} es un symlink; un pack solo publica archivos propios`);
    if (e.isDirectory()) return fontFiles(path);
    return FONT_FILE.test(e.name) ? [path] : [];
  });
}

/** Lo publicable de un pack: brand.json, fonts/** si fonts.import los usa, los logos que nombra y su DESIGN.md validado. */
export function readBrandPackItem(id: string, dir: string, opts: Pick<ParseBrandOptions, 'extensionPoints' | 'pin'> = {}): BrandPackItem {
  // Un symlink se rechaza antes de leer: readFileSync lo seguiría y publicaría un archivo de fuera del pack.
  const design = join(dir, DESIGN_FILE);
  if (existsSync(design) && lstatSync(design).isSymbolicLink()) throw new Error(`brand registry: el ${DESIGN_FILE} de "${id}" es un symlink`);
  // La misma validación que al aplicar: lo que se publica es lo que después carga sin error.
  const { brand, facts } = loadBrandPack(dir, opts);
  const paths = ['brand.json'];
  if (facts) paths.push(FACTS_FILE);
  if (brand.fonts?.import?.includes('/fonts/') && existsSync(join(dir, 'fonts'))) paths.push(...fontFiles(join(dir, 'fonts')).map((f) => relative(dir, f).split(sep).join('/')));
  for (const logo of [brand.logo, brand.logoDark]) {
    if (!logo) continue;
    if (lstatSync(join(dir, logo)).isSymbolicLink()) throw new Error(`brand registry: el logo de "${id}" es un symlink`);
    paths.push(logo.split(sep).join('/'));
  }
  if (existsSync(design)) paths.push(DESIGN_FILE);
  return { id, name: brand.name, files: paths.sort().map((path) => ({ path, base64: readFileSync(join(dir, path)).toString('base64') })) };
}

export const brandItemSha = (item: BrandPackItem): string => createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 16);
export const brandItemPath = (id: string, sha: string): string => `brands/${id}@${sha}.json`;

/** Packs hermanos del repo publicables: cada carpeta brand-pack[-<id>] con brand.json. */
export function readBrandPacks(root: string, opts: Pick<ParseBrandOptions, 'extensionPoints' | 'pin'> = {}): BrandPackItem[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'brand.json')))
    .flatMap((e) => {
      const id = brandIdOfDir(e.name);
      return id ? [readBrandPackItem(id, join(root, e.name), opts)] : [];
    })
    .sort((a, z) => a.id.localeCompare(z.id));
}

/** Escribe un pack bajado del registry en `dir`. El JSON viene del Blob: cada ruta se revalida para que
 * no salga del directorio. */
export function writeBrandPack(item: BrandPackItem, dir: string): string {
  writePackFiles(item.id, item.files, dir);
  if (!existsSync(join(dir, 'brand.json'))) throw new Error(`brand registry: el pack "${item.id}" no trae brand.json`);
  return dir;
}

/** Escribe los archivos de un pack bajado del Blob (marca o skill): cada ruta se revalida para que no salga de `dir`. */
export function writePackFiles(id: string, files: readonly { path: string; base64: string }[], dir: string): void {
  for (const f of files) {
    const path = normalize(f.path);
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || typeof f.base64 !== 'string') throw new Error(`registry: ruta inválida "${f.path}" en el pack "${id}"`);
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), Buffer.from(f.base64, 'base64'));
  }
}

/** Sin registry: el pack local junto al repo (WT_BRANDS_ROOT). Una marca pedida que no está falla. */
export function localBrandDir(id: string, root: string): string {
  if (!isBrandId(id)) throw new Error(`brand: id de marca inválido "${id}"`);
  const dir = join(root, brandDirName(id));
  if (!existsSync(join(dir, 'brand.json'))) throw new Error(`brand: la marca "${id}" no existe en ${root} (se esperaba ${posix.join(brandDirName(id), 'brand.json')})`);
  return dir;
}
