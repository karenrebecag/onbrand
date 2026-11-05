// Recorrido común de las guardas de docs/estandares.md: qué archivos son código propio del repo.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
const CODE = /\.(ts|tsx|js|mjs)$/;
// node_modules y salidas de build no son nuestras; el resto de lo que hay bajo estos dirs sí.
const SKIP = new Set(['node_modules', 'dist', 'build', '.git']);

/** Rutas relativas a la raíz, con `/`, de todo el código bajo `dirs`. */
export function codeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE.test(e.name)) out.push(relative(ROOT, p).split('\\').join('/'));
    }
  };
  for (const d of dirs) walk(join(ROOT, d));
  return out.sort();
}
