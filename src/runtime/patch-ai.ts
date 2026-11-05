// Vía de parche de "Editar con IA" (H5). Stitch resuelve un pedido acotado con un DomOperationEvent: el modelo devuelve
// operaciones y no la pantalla entera (follow-up 9,7 s y 0 créditos frente a 116 s y 3 de una pantalla, captura del
// 2026-11-03). Aquí un infer chico devuelve operaciones que aplican los mismos aplicadores AST de la edición directa, sin
// agente. Lo que el infer pide fuera de esas operaciones, o que no encaja en el código, vuelve al turno completo: el
// atajo nunca deja una página peor que la que habría dejado el agente.
// A diferencia de Stitch, el elemento se ubica por archivo:línea del JSX (wt-source.ts), no por selector CSS, y el
// recorte que ve el modelo lo arma el transport desde el commit, no lo declara el modelo.

import type { Suggestion } from './events';
import { sameCopyShape } from './change-kind';
import { deleteElement } from './element-delete';
import { replaceImage, validImageSrc } from './image-replace';
import type { Infer } from './infer';
import { SECTION_SLUG, sectionOp } from './section-ops';
import { MAX_EDIT_CHARS, quickEditText } from './text-edit';

type Ts = typeof import('typescript');

export const MAX_ELEMENTS = 20;
export const MAX_OPS = 8;
const MAX_TAG = 32;
const MAX_TEXT = 500;
const MAX_SRC = 2000;
const MAX_GOAL = 200;
const MAX_REASON = 200;
/** Líneas de contexto a cada lado del elemento: suficiente para ver el JSX que lo contiene sin mandar el archivo. */
export const SNIPPET_RADIUS = 30;
// Solo secciones y componentes del ws: ni `..` ni rutas fuera de src/ llegan al modelo ni al aplicador.
const SOURCE_FILE = /^src\/(?:[\w-]+\/)*[\w.-]+\.tsx$/;

export interface PatchElement {
  source: { file: string; line: number; col: number };
  kind: 'text' | 'image';
  tagName: string;
  text: string;
  src?: string;
  section?: string;
}

export type PatchOp =
  | { op: 'set_text'; file: string; before: string; after: string; goal?: string }
  | { op: 'remove'; file: string; kind: 'text'; text: string; goal?: string }
  | { op: 'remove'; file: string; kind: 'image'; src: string; goal?: string }
  | { op: 'replace_image'; src: string; url: string; goal?: string }
  | { op: 'section'; action: 'move' | 'remove' | 'duplicate'; slug: string; to?: 'up' | 'down'; goal?: string };

export type PatchPlan = { route: 'patch'; ops: PatchOp[] } | { route: 'full'; reason: string };

export type Composed =
  | { ok: true; writes: Record<string, string>; deletes: string[]; summary: string; notes: string[]; followUps: Suggestion[]; copyOnly: boolean }
  | { ok: false; reason: string };

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const goalOf = (v: unknown): { goal?: string } => (typeof v === 'string' && v.trim() ? { goal: v.trim().slice(0, MAX_GOAL) } : {});

/** Los elementos elegidos en el lienzo. Undefined si falta alguno o alguno no trae su origen en el código: entonces el
 * pedido sigue el turno normal, como antes de esta vía. */
export function parseElements(raw: unknown): PatchElement[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ELEMENTS) return undefined;
  const out: PatchElement[] = [];
  for (const v of raw) {
    const e = (v ?? {}) as Record<string, unknown>;
    const s = (e.source ?? {}) as Record<string, unknown>;
    const file = str(s.file, 300);
    const line = s.line;
    const col = s.col;
    const tagName = str(e.tagName, MAX_TAG);
    const text = str(e.text, MAX_TEXT);
    if (!file || !SOURCE_FILE.test(file) || !Number.isInteger(line) || (line as number) < 1 || !Number.isInteger(col) || (col as number) < 0) return undefined;
    if ((e.kind !== 'text' && e.kind !== 'image') || !tagName || text === undefined) return undefined;
    const src = e.src === undefined ? undefined : str(e.src, MAX_SRC);
    if (e.src !== undefined && src === undefined) return undefined;
    const section = typeof e.section === 'string' && SECTION_SLUG.test(e.section) ? e.section : undefined;
    out.push({ source: { file, line: line as number, col: col as number }, kind: e.kind, tagName, text, ...(src !== undefined ? { src } : {}), ...(section ? { section } : {}) });
  }
  return out;
}

/** El código alrededor de cada elemento, con número de línea, leído del commit padre: el equivalente de
 * verified_html_context de Stitch, pero puesto por el transport. Un archivo que no existe en el commit no se manda. */
export function snippets(files: Readonly<Record<string, string>>, elements: readonly PatchElement[]): { file: string; from: number; code: string }[] {
  const byFile = new Map<string, number[]>();
  for (const e of elements) byFile.set(e.source.file, [...(byFile.get(e.source.file) ?? []), e.source.line]);
  return [...byFile].flatMap(([file, lines]) => {
    const src = files[file];
    if (src === undefined) return [];
    const all = src.split('\n');
    const from = Math.max(1, Math.min(...lines) - SNIPPET_RADIUS);
    const to = Math.min(all.length, Math.max(...lines) + SNIPPET_RADIUS);
    return [{ file, from, code: all.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n') }];
  });
}

/** Una op del modelo, validada. Undefined = fuera del schema v1: todo el plan vuelve al turno. */
function parseOp(v: unknown): PatchOp | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  const goal = goalOf(o.goal);
  const file = str(o.file, 300);
  const fileOk = file !== undefined && SOURCE_FILE.test(file);
  if (o.op === 'set_text') {
    const before = str(o.before, MAX_EDIT_CHARS);
    const after = str(o.after, MAX_EDIT_CHARS);
    return fileOk && before && after ? { op: 'set_text', file: file!, before, after, ...goal } : undefined;
  }
  if (o.op === 'remove') {
    if (!fileOk) return undefined;
    if (o.kind === 'text') { const text = str(o.text, MAX_EDIT_CHARS); return text ? { op: 'remove', file: file!, kind: 'text', text, ...goal } : undefined; }
    if (o.kind === 'image') { const src = str(o.src, MAX_SRC); return src ? { op: 'remove', file: file!, kind: 'image', src, ...goal } : undefined; }
    return undefined;
  }
  if (o.op === 'replace_image') {
    const src = str(o.src, MAX_SRC);
    const url = str(o.url, MAX_SRC);
    // Solo https: una subida pasa por el popover, que copia el archivo al ws; el modelo no tiene archivos que subir.
    return src && url && validImageSrc(url) && url.startsWith('https:') ? { op: 'replace_image', src, url, ...goal } : undefined;
  }
  if (o.op === 'section') {
    const slug = typeof o.slug === 'string' && SECTION_SLUG.test(o.slug) ? o.slug : undefined;
    if (!slug) return undefined;
    if (o.action === 'move') return o.to === 'up' || o.to === 'down' ? { op: 'section', action: 'move', slug, to: o.to, ...goal } : undefined;
    return o.action === 'remove' || o.action === 'duplicate' ? { op: 'section', action: o.action, slug, ...goal } : undefined;
  }
  return undefined;
}

export function parsePlan(raw: unknown): PatchPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.route === 'full') return { route: 'full', reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, MAX_REASON) : 'full' };
  if (r.route !== 'patch' || !Array.isArray(r.ops) || r.ops.length === 0) return { route: 'full', reason: 'plan sin ops válidas' };
  if (r.ops.length > MAX_OPS) return { route: 'full', reason: `más de ${MAX_OPS} ops` };
  const ops = r.ops.map(parseOp);
  return ops.every((o): o is PatchOp => o !== undefined) ? { route: 'patch', ops } : { route: 'full', reason: 'op fuera del schema' };
}

export const PATCH_SYSTEM = [
  'Decides si un pedido de edición sobre elementos concretos de una landing React se resuelve con operaciones puntuales en el código, sin reescribir la página.',
  'Recibes el pedido, los elementos elegidos (archivo y línea del JSX que los pinta, etiqueta y texto o imagen actual) y el código alrededor de cada uno, con número de línea.',
  'Devuelve SOLO JSON. Si alcanza con operaciones: {"route":"patch","ops":[…]}. Si no: {"route":"full","reason":"…"}.',
  'Operaciones permitidas (ninguna otra):',
  '- {"op":"set_text","file","before","after","goal"}: cambia un texto visible. `before` es el texto EXACTO tal como aparece en el código del archivo, sin comillas; `after`, el nuevo. Sin { } < > \\ ni ` en `after`.',
  '- {"op":"remove","file","kind":"text","text","goal"} o {"op":"remove","file","kind":"image","src","goal"}: quita ese elemento.',
  '- {"op":"replace_image","src","url","goal"}: cambia el src actual por una URL https que el pedido trae.',
  '- {"op":"section","action":"move"|"remove"|"duplicate","slug","to":"up"|"down","goal"}: mueve, quita o duplica la sección entera.',
  'Usa "full" si el pedido cambia estilos, colores, tipografía, tamaños, clases o layout; si agrega elementos o secciones nuevas; si cambia la identidad de la página; si pide generar una imagen; o si dudas.',
  'No inventes texto que el pedido no pide. `goal` es una frase corta con la intención de cada op.',
].join('\n');

export interface PatchInput {
  prompt: string;
  elements: PatchElement[];
  snippets: { file: string; from: number; code: string }[];
}

/** Un error del modelo o una respuesta ilegible no es un fallo: el pedido sigue al turno completo. */
export async function planPatch(infer: Infer, input: PatchInput, signal?: AbortSignal): Promise<PatchPlan> {
  try {
    return parsePlan(await infer(PATCH_SYSTEM, JSON.stringify(input), signal));
  } catch (e) {
    return { route: 'full', reason: `infer: ${e instanceof Error ? e.message : String(e)}`.slice(0, MAX_REASON) };
  }
}

const only = (files: Readonly<Record<string, string>>, file: string): Record<string, string> => (file in files ? { [file]: files[file]! } : {});

/** Aplica las ops en orden sobre los archivos en memoria con los aplicadores de la edición directa. La primera que no
 * encaja aborta todo: no hay parches parciales. `copyOnly` = solo cambió texto, con la misma forma de código. */
export function composeEdits(ts: Ts, files: Readonly<Record<string, string>>, ops: readonly PatchOp[]): Composed {
  let cur: Record<string, string> = { ...files };
  const deleted = new Set<string>();
  const notes: string[] = [];
  const followUps: Suggestion[] = [];
  const summary: string[] = [];
  for (const op of ops) {
    if (op.op === 'set_text' || op.op === 'remove') {
      // El archivo del elemento acota la búsqueda: el mismo texto en otra sección no vuelve ambigua la op.
      const scope = only(cur, op.file);
      const r = op.op === 'set_text' ? quickEditText(ts, scope, op.before, op.after) : deleteElement(ts, scope, op.kind === 'text' ? { kind: 'text', text: op.text } : { kind: 'image', src: op.src });
      if (!r.ok) return { ok: false, reason: `${op.op}: ${r.reason}` };
      cur = { ...cur, [r.path]: r.source };
      summary.push(`${op.op} ${r.path}`);
    } else if (op.op === 'replace_image') {
      const r = replaceImage(ts, cur, op.src, op.url);
      if (!r.ok) return { ok: false, reason: `replace_image: ${r.reason}` };
      cur = { ...cur, [r.path]: r.source };
      summary.push(`replace_image ${r.path}`);
    } else {
      const r = sectionOp(ts, cur, op.action === 'move' ? { op: 'move', slug: op.slug, to: op.to ?? 'down' } : { op: op.action, slug: op.slug });
      if (!r.ok) return { ok: false, reason: `section: ${r.reason}` };
      const next = { ...cur, ...r.writes };
      for (const d of r.deletes) { delete next[d]; deleted.add(d); }
      cur = next;
      notes.push(...r.notes);
      followUps.push(...r.followUps);
      summary.push(r.summary);
    }
  }
  const writes = Object.fromEntries(Object.entries(cur).filter(([p, v]) => files[p] !== v));
  const deletes = [...deleted].filter((p) => p in files && !(p in cur));
  if (!Object.keys(writes).length && !deletes.length) return { ok: false, reason: 'sin cambios' };
  const copyOnly = ops.every((o) => o.op === 'set_text') && !deletes.length && Object.entries(writes).every(([p, v]) => files[p] !== undefined && sameCopyShape(files[p]!, v));
  return { ok: true, writes, deletes, summary: summary.join('; '), notes, followUps, copyOnly };
}
