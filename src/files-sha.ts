// Huella de los archivos que publica un item del registry. La comparten build-registry y cada gate que
// escribe catalog/gates/*.json: un resultado solo vale para el contenido exacto que se publica, y la ruta
// entra al hash porque un archivo movido ya no es lo que se probó. Sin dependencias para que cualquier
// rama la pueda traer sola.

import { createHash } from 'node:crypto';

export function filesSha(files: ReadonlyArray<{ path: string; content: string }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash('sha256').update(sorted.map((f) => `${f.path}\0${f.content}\0`).join(''), 'utf8').digest('hex');
}
