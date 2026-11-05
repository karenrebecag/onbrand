import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// CA1 (RF1): el runtime (src/) no puede importar el tooling. Si lo hace, el MCP que bundlee src/
// arrastraría TypeScript/Tailwind/Playwright al runtime, que es justo lo que la spec evita.
const SRC = join(import.meta.dir, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return tsFiles(abs);
    return /\.(ts|tsx)$/.test(name) ? [abs] : [];
  });
}

/** Specifiers de import/export/import() de un archivo. */
function specifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

const FORBIDDEN = /(?:^|\/)(scripts|tools\/porter)\//;

describe('frontera runtime/tooling (CA1)', () => {
  test('ningún archivo bajo src/ importa tools/porter ni scripts/', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.test(spec)) offenders.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
