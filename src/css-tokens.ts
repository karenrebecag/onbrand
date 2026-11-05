// Tokens CSS (`--x`) que las secciones usan sin que nadie los defina (live6: `.features { background: var(--surface-muted) }`
// cayó a transparente y la banda muted pintó el fondo de página). Se revisa con los tipos, dentro del turno, para que el
// agente lo corrija antes de mirar el preview. Puro sobre textos; `undefinedTokenReport` solo lee el workspace.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFINED_RE = /(^|[\s;{])(--[A-Za-z0-9_-]+)\s*:/g;
// Solo var(--x) sin fallback: con `var(--x, y)` el autor ya decidió qué pasa si --x no existe.
const USED_RE = /var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g;
// Lo que el TSX fija en runtime (`style={{ '--i': n }}`, `setProperty('--x', …)`): el stagger de las secciones y los
// componentes del DS lo usan, y una hoja que lo lee no está rota.
const SCRIPT_DEFINED_RE = /['"`](--[A-Za-z0-9_-]+)['"`]\s*[:,]/g;

export function definedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(DEFINED_RE)) out.add(m[2] as string);
  return out;
}

export function scriptDefinedTokens(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(SCRIPT_DEFINED_RE)) out.add(m[1] as string);
  return out;
}

export function usedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(USED_RE)) out.add(m[1] as string);
  return out;
}

/** `var(--x)` de cada hoja de `sections` cuyo `--x` no define ninguna hoja de `defining` (ni la propia). */
export function undefinedTokens(sections: ReadonlyMap<string, string>, defining: readonly string[], alsoDefined: ReadonlySet<string> = new Set()): Map<string, string[]> {
  const defined = new Set<string>(alsoDefined);
  for (const css of [...defining, ...sections.values()]) for (const t of definedTokens(css)) defined.add(t);
  const out = new Map<string, string[]>();
  for (const [file, css] of sections) {
    for (const t of usedTokens(css)) if (!defined.has(t)) out.set(t, [...(out.get(t) ?? []), file]);
  }
  return out;
}

function filesOf(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f.startsWith('.')) return [];
    return statSync(p).isDirectory() ? filesOf(p, ext) : ext.test(f) ? [p] : [];
  });
}
const cssFiles = (dir: string): string[] => filesOf(dir, /\.css$/);

/** Una línea para la salida de typecheck: qué tokens inventó el agente en `src/sections/*.css` y dónde. */
export function undefinedTokenReport(dir: string): string {
  const src = join(dir, 'src');
  const sectionsDir = join(src, 'sections');
  const sections = new Map(cssFiles(sectionsDir).map((p) => [relative(sectionsDir, p), readFileSync(p, 'utf8')] as const));
  if (sections.size === 0) return 'Tokens CSS: sin hojas en src/sections.';
  const defining = cssFiles(src).filter((p) => !p.startsWith(sectionsDir)).map((p) => readFileSync(p, 'utf8'));
  const fromScripts = new Set(filesOf(src, /\.tsx?$/).flatMap((p) => [...scriptDefinedTokens(readFileSync(p, 'utf8'))]));
  const missing = undefinedTokens(sections, defining, fromScripts);
  if (missing.size === 0) return 'Tokens CSS: todos los var(--x) de src/sections existen.';
  const list = [...missing].map(([t, files]) => `${t} (${files.join(', ')})`).join('; ');
  return `${missing.size} token${missing.size === 1 ? '' : 's'} CSS que no existen en src/sections (caen a transparente o al valor inicial; usa los del DS o defínelos): ${list}`;
}
