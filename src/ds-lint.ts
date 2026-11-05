// Lint del DS sobre lo que escribe el agente (src/sections y src/App.tsx), como el `rg -n "<button|<input|…|style=|TODO"`
// que Figma Make corre después del build: elementos crudos y estilos que se saltan Arc. Va dentro de la tool typecheck y
// cuenta como error, así el turno no se da por verificado con un hit. Puro sobre textos; `dsLintReport` lee el workspace.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LintHit { file: string; line: number; rule: string; text: string }

interface Rule { id: string; test: RegExp; fix: string }

const TSX_RULES: Rule[] = [
  { id: 'button-crudo', test: /<button\b/, fix: 'usa Button o Action de @/components (Action con href para enlaces)' },
  { id: 'campo-crudo', test: /<(input|select|textarea)\b/, fix: 'usa el campo del DS (@/components/arc/input, select, textarea)' },
  // style={{ '--i': n }} fija un token en runtime (stagger, ancho de barra) y es legítimo; cualquier otra clave no.
  { id: 'estilo-inline', test: /style=\{\{\s*(?!['"]--)[\w'"]/, fix: 'clase en el .module.css de la sección con tokens' },
  { id: 'pendiente', test: /\b(TODO|FIXME)\b/, fix: 'termínalo o quítalo' },
];
const CSS_RULES: Rule[] = [
  // Un color escrito a mano no sigue a la marca ni al tema oscuro; un fallback dentro de var(--x, …) tampoco se acepta.
  { id: 'color-crudo', test: /#[\da-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/i, fix: 'usa var(--token) del DS' },
  { id: 'pendiente', test: /\b(TODO|FIXME)\b/, fix: 'termínalo o quítalo' },
];

const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

export function dsLint(file: string, content: string): LintHit[] {
  const isCss = file.endsWith('.css');
  const rules = isCss ? CSS_RULES : TSX_RULES;
  const body = isCss ? stripCssComments(content) : content;
  return body.split('\n').flatMap((text, i) => rules.filter((r) => r.test.test(text)).map((r) => ({ file, line: i + 1, rule: `${r.id}: ${r.fix}`, text: text.trim().slice(0, 120) })));
}

/** Archivos que escribe el agente: las secciones (tsx y css) y App.tsx. El DS de src/components no entra. */
function pageFiles(dir: string): string[] {
  const sections = join(dir, 'src', 'sections');
  const own = existsSync(sections) ? readdirSync(sections).filter((f) => /\.(tsx|css)$/.test(f)).map((f) => `src/sections/${f}`) : [];
  return [...own.sort(), ...(existsSync(join(dir, 'src', 'App.tsx')) ? ['src/App.tsx'] : [])];
}

export function dsLintWorkspace(dir: string): LintHit[] {
  return pageFiles(dir).flatMap((f) => dsLint(f, readFileSync(join(dir, f), 'utf8')));
}

export function formatLint(hits: readonly LintHit[]): string {
  if (!hits.length) return 'Lint del DS: sin elementos crudos ni estilos fuera de tokens.';
  return [`Lint del DS: ${hits.length} hits (cuentan como errores):`, ...hits.slice(0, 30).map((h) => `${h.file}:${h.line}: ${h.rule} → ${h.text}`), ...(hits.length > 30 ? [`… y ${hits.length - 30} más`] : [])].join('\n');
}
