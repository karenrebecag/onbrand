// Lectura del RESUMEN FINAL del agente (texto libre, en el idioma de la página) hacia campos del contrato.
// Stitch cierra cada turno con 3 chips de siguiente paso sacados de su plan (RE 2026-10-27); aquí salen del
// apartado "Siguientes pasos" que el prompt exige, y el builder los pinta como chips.

import { isSuggestion, type Suggestion } from './event-model';

export type { Suggestion };

export const MAX_SUGGESTIONS = 3;
// Lovable separa el chip (title) del pedido que manda (message), dashboard-shared bA: el título largo no cabe en un chip.
const MAX_TITLE = 40;

const HEADING_RE = /^\s*(?:[#>*\-\d.)\s]*)?["“*_]*\s*(?:siguientes pasos|next steps|próximos pasos|proximos pasos)\b.*$/i;
const ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/;
const NEXT_HEADING_RE = /^\s*(?:#{1,6}\s|\d+\.\s+["“*]|["“*_]{1,2}[A-ZÁÉÍÓÚ][^"”]*["”*_]{1,2}\s*:?\s*$)/;

/** Stitch limpia cada sugerencia antes de pintarla: trim, sin punto final (DesignPage :23596) y mayúscula inicial (:52607). */
export function normalizeText(text: string): string {
  const t = text.trim();
  const s = t.endsWith('.') ? t.slice(0, -1).trimEnd() : t;
  return s ? s[0]!.toUpperCase() + s.slice(1) : '';
}

/** "Título: pedido" del prompt. Sin título corto delante, el chip muestra el pedido entero (resúmenes de antes). */
export function toSuggestion(text: string): Suggestion {
  const i = text.indexOf(': ');
  const title = i > 0 ? normalizeText(text.slice(0, i)) : '';
  const message = i > 0 ? normalizeText(text.slice(i + 2)) : '';
  const whole = normalizeText(text);
  return title && message && title.length <= MAX_TITLE ? { title, message } : { title: whole, message: whole };
}

/** Las sugerencias que ya vienen en un page.json: strings de antes de {title, message} o el formato nuevo. */
export function asSuggestions(v: unknown): Suggestion[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((s) => (isSuggestion(s) && s.title.trim() && s.message.trim() ? [{ title: s.title.trim(), message: s.message.trim() }]
    : typeof s === 'string' && s.trim() ? [{ title: s.trim(), message: s.trim() }] : []));
}

/** Las 2-3 sugerencias del apartado "Siguientes pasos" del resumen, sin viñetas ni formato; [] si no hay apartado. */
export function suggestionsFromSummary(summary: string): Suggestion[] {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING_RE.test(l));
  if (start < 0) return [];
  const out: Suggestion[] = [];
  for (const line of lines.slice(start + 1)) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (!line.trim()) { if (out.length) break; continue; }
    const m = ITEM_RE.exec(line);
    if (!m) { if (NEXT_HEADING_RE.test(line) || out.length) break; continue; }
    const text = m[1]!.replace(/\*\*/g, '').replace(/`/g, '').trim();
    if (text) out.push(toSuggestion(text));
  }
  return out;
}

/** Los chips del turno. Un follow-up que cierra sin "Siguientes pasos" (5 de 7 en los workspaces de QA del 2026-10-28)
 * dejaba la conversación sin chips: siguen los del mensaje padre, menos el que se acaba de pedir. */
export function turnSuggestions(summary: string, parent: unknown, prompt: string): Suggestion[] {
  const own = suggestionsFromSummary(summary);
  if (own.length) return own;
  const asked = prompt.trim();
  return asSuggestions(parent).filter((s) => s.message !== asked).slice(0, MAX_SUGGESTIONS);
}
