// docs/estandares.md B5: un atajo marcado con HACK nombra su disparador; sin él es deuda muda. Alcance del ledger:
// src apps/builder/src scripts tests (31 en 782d021b; tools/ salió con el porter en #911). Se mide en el bloque de comentario que abre la marca
// (la línea y las de comentario que la siguen), buscando el giro que introduce la condición. Hoy los 31 lo tienen,
// así que la lista de excepciones está vacía y la guarda va en verde: un HACK nuevo sin disparador la pone en rojo.
// El tope no se mide aquí: es prosa sin forma fija y queda para el barrido de QA.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeFiles, ROOT } from './estandares-scan';

const SCOPE = ['src', 'apps/builder/src', 'scripts', 'tests'];
// El patrón se arma por partes para que este archivo no se cuente a sí mismo en el grep del ledger.
const MARK = new RegExp(`(#|//) ?${'HACK'}:`);
const COMMENT = /^\s*(\/\/|#)/;
// "cuando X", "si X", "hasta X", "Reactivar con X", "Disparador de mejora: X".
const TRIGGER = /\b(cuando|si|hasta|reactivar|disparador)\b/i;
// Excepciones conocidas sin disparador, como archivo:línea. Vacía en 782d021b.
const KNOWN_WITHOUT: string[] = [];

function blocks(file: string): { at: string; text: string }[] {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const out: { at: string; text: string }[] = [];
  lines.forEach((line, i) => {
    if (!MARK.test(line)) return;
    const parts = [line];
    for (let j = i + 1; j < lines.length && COMMENT.test(lines[j]!) && !MARK.test(lines[j]!); j++) parts.push(lines[j]!);
    out.push({ at: `${file}:${i + 1}`, text: parts.join(' ') });
  });
  return out;
}

const ledger = codeFiles(SCOPE).flatMap(blocks);

test('B5: el ledger no está vacío (el recorrido encuentra las marcas)', () => {
  expect(ledger.length).toBeGreaterThan(0);
});

test('B5: cada HACK del ledger nombra su disparador', () => {
  expect(ledger.filter((b) => !TRIGGER.test(b.text)).map((b) => b.at)).toEqual(KNOWN_WITHOUT);
});
