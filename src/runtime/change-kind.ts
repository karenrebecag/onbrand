// Q6 (RE de iteración, bloques.md): la verificación proporcional al cambio. Un turno que solo cambió texto en una sección
// no pide capturas al agente: lo cubre el preview-check del transport, que mide a 1440 y 375 el desborde, el CTA partido,
// el contraste y los clics. Make tampoco captura: su agente corre `oxfmt --check <archivos> && pnpm build` y un `rg` de
// autochequeo de valores viejos (re-iteracion/figma-make/net-t4-figmake.network-response:1445, 1449, 1543). Cualquier cambio de clases, estilos o estructura sigue
// pidiendo las dos capturas de página entera, porque ahí es donde se rompe el layout.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitEnv } from './git-env';

const SECTION_TSX = /^src\/sections\/\d+-[\w-]+\.tsx$/;
/** El plan se reescribe con el texto nuevo: tocarlo no convierte un copy en un cambio de estructura. */
const PLAN = 'page-plan.md';

/** El archivo sin su texto: literales de string y texto JSX vacíos. Lo que queda es la forma (tags, props, clases, código). */
export function shapeOf(tsx: string): string {
  return tsx
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '$1$1')
    .replace(/>([^<>{}]*)</g, (_, text: string) => (text.trim() ? '><' : `>${text}<`))
    .replace(/\s+/g, ' ');
}

/** Solo copy: una única sección escrita (más, si acaso, el plan) y la misma forma que en HEAD. Una sección nueva no es copy.
 * Un `className` o un estilo también son strings: sameCopyShape los separa del texto. */
export function isCopyOnly(dir: string, writes: readonly string[]): boolean {
  const sections = writes.filter((w) => w !== PLAN);
  if (sections.length !== 1 || !SECTION_TSX.test(sections[0] ?? '')) return false;
  const file = sections[0] as string;
  const before = spawnSync('git', ['-C', dir, 'show', `HEAD:${file}`], { encoding: 'utf8', env: gitEnv() });
  if (before.status !== 0 || !existsSync(join(dir, file))) return false;
  return sameCopyShape(before.stdout, readFileSync(join(dir, file), 'utf8'));
}

const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
// Un valor de CSS (`8px`, `#fff`, `var(--x)`) o una lista de clases (`text-sm md:px-4`) dentro de un string no es copy.
const CSS_VALUE = /^\s*(?:-?[\d.]+(?:px|rem|em|%|vh|vw|ch|fr|s|ms)?|#[\da-f]{3,8}|(?:var|rgba?|hsla?|oklch|oklab|calc|clamp|min|max)\(.*)\s*$/i;
const CLASS_LIST = /^[a-z\d\-:/[\]._# ]+$/;
const codeLike = (v: string): boolean => CSS_VALUE.test(v) || (CLASS_LIST.test(v) && v.includes('-'));

/** Misma forma, y ningún string que cambió es un valor de CSS o una lista de clases. */
export function sameCopyShape(before: string, after: string): boolean {
  if (shapeOf(before) !== shapeOf(after)) return false;
  const values = (src: string): string[] => [...src.matchAll(LITERAL)].map((m) => m[2] ?? '');
  const [a, b] = [values(before), values(after)];
  return a.length === b.length && a.every((v, i) => v === b[i] || !(codeLike(v) || codeLike(b[i] ?? '')));
}

/** `git diff --check` contra HEAD: marcadores de conflicto y espacios sobrantes en lo que el turno dejó. */
export function diffCheck(dir: string): string {
  const r = spawnSync('git', ['-C', dir, 'diff', '--check', 'HEAD'], { encoding: 'utf8', env: gitEnv() });
  return r.status === 0 ? '' : (r.stdout || r.stderr).trim().slice(0, 1000);
}
