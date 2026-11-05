// Transformer de motion-gsap: cada componente vive como documentación multi-framework en el vault
// (motion-gsap/components/<slug>/react.md), con el código React dentro de bloques fenced. Esto EXTRAE
// el componente React y su CSS del markdown a archivos importables, lee el encabezado (nombre,
// descripción, categoría) y las deps de los imports. No inventa nada: solo lo que el .md declara.
//   bun scripts/motion-gsap-extract.ts [<slug>] [--out <dir>]   (sin slug: lista los disponibles)

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_ROOT } from '../src/catalog/load';

export const MOTION_DIR = join(VAULT_ROOT, 'motion-gsap', 'components');

export interface MotionFile { header: string; lang: string; code: string }
export interface MotionComponent {
  slug: string;
  name: string;
  description: string;
  category: string;
  /** Archivo React principal (primer bloque .jsx que no es "Usage example"). */
  component: MotionFile;
  css?: MotionFile;
  usage?: MotionFile;
  /** Paquetes npm importados por el componente (gsap/* colapsa a gsap). */
  deps: string[];
}

/** Pares `### header` + ```lang ... ``` del markdown, en orden. Ignora bloques sin header `###`
 * previo (el bash de install y el json de selectores de Webflow no cuelgan de un `###`). */
export function parseFences(md: string): MotionFile[] {
  const lines = md.split('\n');
  const out: MotionFile[] = [];
  let header = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^###\s+(.+)$/.exec(lines[i]);
    if (h) { header = h[1].trim(); continue; }
    const fence = /^```(\w+)?\s*$/.exec(lines[i]);
    if (!fence) continue;
    const lang = fence[1] ?? '';
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
    if (header) { out.push({ header, lang, code: body.join('\n') }); header = ''; }
  }
  return out;
}

const packageOf = (spec: string): string => {
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return pkg === 'gsap' || pkg.startsWith('gsap/') ? 'gsap' : pkg;
};

/** Deps npm de un código React: solo de statements `import ... from "x"` reales (no un `from "..."`
 * dentro de un comentario o string), gsap/* colapsado a gsap, sin react. */
export function depsOf(code: string): string[] {
  const specs = [...code.matchAll(/^import\b[\s\S]*?\bfrom\s+["']([^"'.][^"']*)["'];?$/gm)].map((m) => packageOf(m[1]));
  return [...new Set(specs)].filter((p) => p !== 'react').sort();
}

export function extractComponent(slug: string): MotionComponent {
  const path = join(MOTION_DIR, slug, 'react.md');
  if (!existsSync(path)) throw new Error(`motion-gsap: no existe ${path}`);
  const md = readFileSync(path, 'utf8');
  const lines = md.split('\n');
  const name = (/^#\s+(.+?)(?:\s*-\s*react)?\s*$/.exec(lines[0])?.[1] ?? slug).trim();
  const description = (lines[1] ?? '').trim();
  const category = (/^Category:\s*(.+)$/m.exec(md)?.[1] ?? 'ui-component').trim();
  const fences = parseFences(md);
  const jsx = fences.filter((f) => (f.lang === 'jsx' || f.lang === 'tsx') && !/usage/i.test(f.header));
  const component = jsx[0];
  if (!component) throw new Error(`motion-gsap (${slug}): sin bloque React en react.md`);
  const css = fences.find((f) => f.lang === 'css');
  const usage = fences.find((f) => /usage/i.test(f.header));
  return { slug, name, description, category, component, ...(css ? { css } : {}), ...(usage ? { usage } : {}), deps: depsOf(component.code) };
}

/** Escribe el componente (.tsx) y su CSS en `<outDir>/<slug>/`. El import de CSS del source se
 * conserva tal cual (GSAP consulta por clase/atributo: CSS plano, no modules). */
export function writeComponent(c: MotionComponent, outDir: string): { tsx: string; css?: string } {
  const dir = join(outDir, c.slug);
  mkdirSync(dir, { recursive: true });
  const file = c.component.header.replace(/\.jsx$/, '.tsx');
  const tsxPath = join(dir, file);
  writeFileSync(tsxPath, c.component.code.endsWith('\n') ? c.component.code : `${c.component.code}\n`);
  let cssPath: string | undefined;
  if (c.css) { cssPath = join(dir, c.css.header); writeFileSync(cssPath, c.css.code); }
  return { tsx: tsxPath, ...(cssPath ? { css: cssPath } : {}) };
}

export const listSlugs = (): string[] =>
  readdirSync(MOTION_DIR).filter((d) => existsSync(join(MOTION_DIR, d, 'react.md'))).sort();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--'));
  if (!slug) { console.log(listSlugs().join('\n')); return; }
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join('/tmp', 'motion-gsap-out');
  const c = extractComponent(slug);
  const paths = writeComponent(c, out);
  console.log(`${c.slug}: "${c.name}" [${c.category}] deps=${c.deps.join(',') || '-'}`);
  console.log(`  componente: ${c.component.header} (${c.component.code.split('\n').length} líneas) -> ${paths.tsx}`);
  if (c.css) console.log(`  css: ${c.css.header}`);
}

if (import.meta.main) await main();
