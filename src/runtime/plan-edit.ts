// Edición del plan por la persona antes de aprobarlo (plan-mode.md §3 "Edición"). La fase build preserva literal las
// líneas que la persona cambió, así que se marcan con `usuario:`. La marca va DENTRO de la línea porque ENTRY_RE y
// FIELD_RE de page-plan-md están anclados a `^`: un prefijo de línea sacaría la sección del parser.

import { parsePagePlanMd, type PagePlanMd } from '../page-plan-md';

export const USER_MARK = 'usuario:';
export const MAX_PLAN_BYTES = 64 * 1024;

export type PlanEditError = 'too_large' | 'no_changes_section' | 'no_entries' | 'duplicate_slug';
export type PlanEditResult =
  | { ok: true; plan: string; userLines: number }
  | { ok: false; code: PlanEditError; message: string };

const CHANGES_RE = /^##\s+cambios\s*$/i;
const ENTRY_HEAD_RE = /^##\s+\d{2}-/;
const HEADING_RE = /^\s*#/;
const FIELD_LINE_RE = /^(\s*[-*]\s*[a-záéíóú]+\s*:\s*)(.*)$/i;
const BULLET_RE = /^(\s*[-*]\s+)(.*)$/;
const MARKED_BULLET_RE = /^(\s*[-*]\s*)usuario:\s?(.*)$/i;
const MARKED_FIELD_RE = /^(\s*[-*]\s*[a-záéíóú]+\s*:\s*)usuario:\s?(.*)$/i;
const MARKED_PLAIN_RE = /^usuario:\s?(.*)$/i;

const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** Quita la marca de una línea. El orden importa: `- usuario: x` es la viñeta marcada, no un campo llamado `usuario`. */
function stripLine(line: string): string {
  const bullet = MARKED_BULLET_RE.exec(line);
  if (bullet) return bullet[1]! + bullet[2]!;
  const field = MARKED_FIELD_RE.exec(line);
  if (field) return field[1]! + field[2]!;
  const plain = MARKED_PLAIN_RE.exec(line);
  return plain ? plain[1]! : line;
}

const isMarked = (line: string): boolean => stripLine(line) !== line;

/** Los encabezados nunca se marcan: `usuario: ## Cambios` o `usuario: ## 03-hero` dejarían de leerse como tales. */
function markLine(line: string): string {
  if (!line.trim() || HEADING_RE.test(line)) return line;
  const field = FIELD_LINE_RE.exec(line);
  if (field) return `${field[1]}${USER_MARK} ${field[2]}`;
  const bullet = BULLET_RE.exec(line);
  if (bullet) return `${bullet[1]}${USER_MARK} ${bullet[2]}`;
  return `${USER_MARK} ${line}`;
}

export const stripUserMarks = (text: string): string => lines(text).map(stripLine).join('\n');

/** Líneas marcadas, 1-based, con el texto sin la marca: lo que la fase build debe copiar literal. */
export const userLines = (text: string): { line: number; text: string }[] =>
  lines(text).flatMap((l, i) => (isMarked(l) ? [{ line: i + 1, text: stripLine(l) }] : []));

/** Líneas de `## Cambios` hasta el siguiente `## ` que no sea entrada. Sin el corte, `- focal: …` en `## Preguntas` se
 * pegaría como campo a la última sección. null si no hay `## Cambios`. */
export function changesBlock(text: string): string | null {
  const all = lines(text);
  const start = all.findIndex((l) => CHANGES_RE.test(l));
  if (start < 0) return null;
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l) && !ENTRY_HEAD_RE.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Índices de `b` que forman parte de una LCS con `a` (comparación sin espacios finales). */
function commonInB(a: string[], b: string[]): Set<number> {
  const n = a.length;
  const m = b.length;
  const ka = a.map((l) => l.trimEnd());
  const kb = b.map((l) => l.trimEnd());
  // HACK: tabla O(n·m). Con el tope de 64 KiB son ~2-3 M celdas; Myers si el tope sube.
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = ka[i] === kb[j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
  const keep = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { keep.add(j); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
    else j++;
  }
  return keep;
}

/** Índices de línea (del texto completo) de los campos de entradas cuyo slug no estaba en el original: una entrada nueva
 * se marca entera aunque alguna línea suelta coincida con otra del original. */
function newEntryFieldLines(all: string[], originalSlugs: Set<string>): Set<number> {
  const out = new Set<number>();
  const start = all.findIndex((l) => CHANGES_RE.test(l));
  let inNew = false;
  for (let i = start + 1; i < all.length; i++) {
    const l = all[i]!;
    if (/^##\s/.test(l)) {
      if (!ENTRY_HEAD_RE.test(l)) break;
      inNew = !originalSlugs.has(parsePagePlanMd(l).sections[0]?.slug ?? '');
      continue;
    }
    if (inNew && FIELD_LINE_RE.test(l)) out.add(i);
  }
  return out;
}

function validate(block: string | null): { ok: true; plan: PagePlanMd } | Extract<PlanEditResult, { ok: false }> {
  if (block === null) return { ok: false, code: 'no_changes_section', message: 'el plan no tiene la sección "## Cambios"' };
  const plan = parsePagePlanMd(block);
  if (!plan.sections.length) return { ok: false, code: 'no_entries', message: '"## Cambios" no tiene ninguna entrada "## NN-rol"' };
  const seen = new Set<string>();
  for (const s of plan.sections) {
    if (seen.has(s.slug)) return { ok: false, code: 'duplicate_slug', message: `la sección ${s.slug} aparece dos veces` };
    seen.add(s.slug);
  }
  return { ok: true, plan };
}

const tooLarge = (bytes: number): Extract<PlanEditResult, { ok: false }> =>
  ({ ok: false, code: 'too_large', message: `el plan ocupa ${bytes} bytes; el máximo es ${MAX_PLAN_BYTES}` });

/** Fusiona el plan editado con el original del agente (`.wt/plans/<id>.agent.md`). El diff es siempre contra el
 * original y sin marcas, así que guardar el mismo borrador dos veces da el mismo resultado. */
export function mergePlanEdit(original: string, edited: string): PlanEditResult {
  const inBytes = Buffer.byteLength(edited, 'utf8');
  if (inBytes > MAX_PLAN_BYTES) return tooLarge(inBytes);
  const clean = stripUserMarks(edited);
  const checked = validate(changesBlock(clean));
  if (!checked.ok) return checked;

  const base = lines(stripUserMarks(original));
  const next = lines(clean);
  const same = commonInB(base, next);
  const originalSlugs = new Set(parsePagePlanMd(changesBlock(base.join('\n')) ?? '').sections.map((s) => s.slug));
  const forced = newEntryFieldLines(next, originalSlugs);
  const out = next.map((l, i) => (same.has(i) && !forced.has(i) ? l : markLine(l)));
  const plan = out.join('\n');

  const outBytes = Buffer.byteLength(plan, 'utf8');
  if (outBytes > MAX_PLAN_BYTES) return tooLarge(outBytes);
  return { ok: true, plan, userLines: out.filter(isMarked).length };
}
