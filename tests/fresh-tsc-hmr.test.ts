// La edición directa corre sobre el workspace que sirve el vite del preview: cada escritura llega por HMR. Si el cambio
// rompe tipos, el chequeo contra el árbol viejo no puede volver a escribirlo solo para que el llamador lo descarte después
// (el preview pasaba por nuevo, viejo, nuevo y viejo; mapa de replicación §5, re-sistema/onbrand/vivo/hmr-edicion-directa).
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshTscError } from '../src/runtime/direct-edit';
import { commitAll, initRepo } from '../src/runtime/git-workspace';

const FILE = 'src/sections/01-hero.tsx';
const OLD = 'export default function Hero() { return <h1>Hola</h1>; }\n';
const NEW = 'export default function Hero() { return <h1>{titulo}</h1>; }\n';

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-tsc-'));
  mkdirSync(join(dir, 'src', 'sections'), { recursive: true });
  writeFileSync(join(dir, FILE), OLD);
  initRepo(dir);
  commitAll(dir, 'base');
  return dir;
}

/** tsc falso: el error que dé cada árbol según lo que haya en disco, y la secuencia de estados que vio el preview. */
function harness(dir: string, errorsFor: (body: string) => string[]) {
  const seen: string[] = [];
  const at = () => (readFileSync(join(dir, FILE), 'utf8') === NEW ? 'nuevo' : 'viejo');
  const tsc = async () => { seen.push(at()); return errorsFor(readFileSync(join(dir, FILE), 'utf8')).map((m) => `${FILE}(1,40): error TS2304: ${m}`).join('\n'); };
  const apply = () => { writeFileSync(join(dir, FILE), NEW); seen.push('nuevo'); };
  return { seen, tsc, apply, at };
}

test('un cambio que rompe tipos no se reescribe tras el chequeo base: el preview no vuelve a mostrarlo', async () => {
  const dir = ws();
  const h = harness(dir, (body) => (body === NEW ? ["Cannot find name 'titulo'."] : []));
  h.apply();
  const fresh = await freshTscError({ tsc: h.tsc }, dir, 'HEAD', [FILE], h.apply);
  expect(fresh?.message).toBe("Cannot find name 'titulo'.");
  expect(h.seen).toEqual(['nuevo', 'nuevo', 'viejo']);
  expect(h.at()).toBe('viejo');
});

test('con un error que el archivo ya tenía, el cambio se acepta y queda escrito', async () => {
  const dir = ws();
  const h = harness(dir, () => ["Cannot find name 'previo'."]);
  h.apply();
  expect(await freshTscError({ tsc: h.tsc }, dir, 'HEAD', [FILE], h.apply)).toBeUndefined();
  expect(h.at()).toBe('nuevo');
});
