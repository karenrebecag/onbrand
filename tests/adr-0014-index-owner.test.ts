// ADR 0014 regla 3: los colaboradores de transport.ts leen el índice con `deps.index()` y lo escriben solo con
// `deps.updateEntry(id, patch)`; la persistencia tiene un dueño. El repo no corre tsc en CI (no hay tsconfig en la raíz),
// así que la regla se mide aquí: todo miembro de un *Deps que entrega entradas (`index`, `entry`) las da como
// `Readonly<MessageEntry>`, y esos archivos más transport.ts compilan sin un solo error: una escritura por alias
// (`entry.plan = …`) es TS2540, y un dep que cambió de forma sin cablear (`index[id]` sobre una función) también rompe.
// `updateEntry(id, patch: Partial<MessageEntry>)` es la única escritura. Compila con el typescript del scaffold por API,
// así que CI lo hace cumplir aunque el repo no corra tsc.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '../templates/base-scaffold/node_modules/typescript';

const SRC = join(import.meta.dir, '..', 'src', 'runtime');

/** El cuerpo de cada interfaz *Deps del archivo. */
const depsBodies = (text: string): string[] => [...text.matchAll(/export interface \w+Deps \{([\s\S]*?)\n\}/g)].map((m) => m[1] as string);

/** Colaboradores = archivos cuyo *Deps menciona MessageEntry. transport.ts es el dueño y no entra. */
function collaborators(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith('.ts') && f !== 'server.ts' && depsBodies(readFileSync(join(SRC, f), 'utf8')).some((b) => b.includes('MessageEntry')));
}

/** Toda mención de una entrada mutable en el archivo del colaborador, no solo en sus deps: una entrada que llega como
 * parámetro de un método público (`cancelPlan(id, entry: MessageEntry)`) se escribe igual sin pasar por deps (ec, #558).
 * Valen `Readonly<MessageEntry>`, `Partial<MessageEntry>` (el patch de updateEntry) y `MessageEntry['campo']`. */
const mutableMembers = (f: string): string[] =>
  readFileSync(join(SRC, f), 'utf8').split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !/^\s*import\b/.test(l) && /(?<!Readonly<|Partial<)\bMessageEntry\b(?!\[)/.test(l))
    .map(({ l, n }) => `${f}:${n} ${l.trim()}`);

test('regla 3: ningún colaborador recibe el índice mutable ni escribe en él fuera de updateEntry', () => {
  const files = collaborators();
  expect(files.length).toBeGreaterThan(0);
  const mutableType = files.flatMap(mutableMembers);
  const checked = [...files, 'server.ts'];
  const program = ts.createProgram(checked.map((f) => join(SRC, f)), { noEmit: true, strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, allowImportingTsExtensions: true, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'] });
  const errors = checked.flatMap((f) => {
    const sf = program.getSourceFile(join(SRC, f));
    return ts.getPreEmitDiagnostics(program, sf)
      .filter((d) => d.file?.fileName === sf?.fileName && d.start !== undefined)
      .map((d) => `${f}:${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  });
  expect({ mutableType, errors }).toEqual({ mutableType: [], errors: [] });
}, 60_000);
