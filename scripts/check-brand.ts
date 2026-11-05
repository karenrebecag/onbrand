// Revisa un brand pack con la misma validación que al aplicarlo y publicarlo, y lista todos sus errores.
//   bun scripts/check-brand.ts brands/brand-pack-<id> [--write-design]
// --write-design escribe el frontmatter de DESIGN.md desde brand.json (lo crea con sus secciones si no existe) y
// conserva la prosa: los valores se copian solos, el texto lo sigue escribiendo quien arma la marca.
// Sale con 0 si el pack es válido y con 1 si no.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brandPackErrors, parseBrandPack } from '../src/brand';
import { packDesignFrontmatter } from '../src/identity-ephemeral';

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const SKELETON = '\n## Brand & Style\n\nCómo habla la marca, a quién le habla y qué evita.\n\n## Colors\n\nDónde va el acento y sobre qué fondos vive la página. Nombra solo colores del frontmatter.\n\n## Typography\n\nQué familia va en titulares y cuál en el cuerpo.\n';

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('--'));
if (!dirArg) {
  console.error('uso: bun scripts/check-brand.ts <carpeta del pack> [--write-design]');
  process.exit(2);
}
const dir = resolve(dirArg);

if (args.includes('--write-design')) {
  // Sin un brand.json que parsee no hay valores que copiar: el error sale abajo, con el resto.
  try {
    const brand = parseBrandPack(JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8')));
    const file = join(dir, 'DESIGN.md');
    const body = existsSync(file) ? readFileSync(file, 'utf8').replace(FRONTMATTER, '') : SKELETON;
    writeFileSync(file, packDesignFrontmatter(brand) + body);
    console.log(`DESIGN.md: frontmatter escrito desde brand.json (${file})`);
  } catch {
    console.error('DESIGN.md: no se escribió; brand.json no es válido');
  }
}

const errors = brandPackErrors(dir);
if (errors.length) {
  console.error(`${errors.length} ${errors.length === 1 ? 'error' : 'errores'} en ${dir}:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`pack válido: ${dir}`);
