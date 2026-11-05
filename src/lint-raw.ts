// lint.raw: lo que Figma Make verifica con rg antes de cerrar el turno (RE 2026-10-27) sobre las secciones que
// escribe el agente. Un <button> o <input> a mano esquiva el componente del DS (foco, tamaños, estados), un
// style= inline esquiva los tokens y un TODO es trabajo que el turno dejó sin hacer. Front lo corre en el turno;
// el banco lo afirma sobre el workspace.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RawKind = 'button' | 'input' | 'style' | 'todo';

export interface RawHit { file: string; line: number; kind: RawKind; text: string }

const RULES: [RawKind, RegExp][] = [
  ['button', /<button\b/],
  ['input', /<input\b/],
  ['style', /\bstyle=\{/],
  ['todo', /\b(?:TODO|FIXME|XXX)\b/],
];

// Un trigger con asChild (Drawer, Dialog, Tooltip de Arc) necesita un elemento nativo como hijo: el <button> es
// el del componente, no uno a mano. Se mira la línea anterior y la misma.
const AS_CHILD = /\basChild\b/;

export function lintRaw(files: readonly { file: string; text: string }[]): RawHit[] {
  const out: RawHit[] = [];
  for (const f of files) {
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      for (const [kind, re] of RULES) {
        if (!re.test(l)) continue;
        if (kind === 'button' && AS_CHILD.test(`${lines[i - 1] ?? ''} ${l}`)) continue;
        out.push({ file: f.file, line: i + 1, kind, text: l.trim().slice(0, 120) });
      }
    });
  }
  return out;
}

/** Las secciones del workspace (src/sections/*.tsx), en el orden del nombre. */
export function sectionFiles(ws: string): { file: string; text: string }[] {
  const dir = join(ws, 'src', 'sections');
  return readdirSync(dir).filter((f) => f.endsWith('.tsx')).sort().map((f) => ({ file: `src/sections/${f}`, text: readFileSync(join(dir, f), 'utf8') }));
}
