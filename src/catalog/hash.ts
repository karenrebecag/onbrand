import { createHash } from 'node:crypto';

/** Hash con el que el índice pina el archivo principal de cada item en el vault (RF5). */
export const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

/** Hash canónico de un artefacto portado (varios archivos): ordena por nombre y mezcla nombre +
 * contenido, para que el productor (tools/porter) y el consumidor (materialize) obtengan el mismo
 * valor sea cual sea el orden de escritura. Pieza compartida: el runtime la usa para verificar RF2
 * sin importar el tooling. */
export function outputSha256(files: ReadonlyArray<{ name: string; content: string }>): string {
  const canonical = [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}\n${f.content}`)
    .join('\u0000');
  return sha256(canonical);
}
