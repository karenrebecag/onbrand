// Historial de tools legible (v0: `user_read_only_context/tool_content/tool-history/*.md`, el contexto grande se descarga a disco
// y el modelo lo abre bajo demanda; research_notes/RE-v0-skills-builtin.md:9-11). Hoy el follow-up solo veía los pasos del turno
// anterior (`turno-anterior.md`); aquí va el stream completo del hilo, paginado, con el mismo tope de caracteres por salida.

import { foldMessage, type EngineEvent } from './events';
import type { TurnTool } from './follow-up-context';

/** Tope de caracteres por salida de tool, el mismo de `turno-anterior.md`. */
export const MAX_OUTPUT = 4000;
/** Pasos por página: 20 salidas de hasta MAX_OUTPUT caben en un solo Read sin acercarse al tope de tokens de una tool. */
export const PAGE_TOOLS = 20;
// HACK: el historial más viejo que MAX_PAGES páginas se descarta (la lista dice cuántos pasos). Subirlo o plegarlo en un resumen
// cuando un chat real pase de 600 pasos y el agente pida lo omitido.
export const MAX_PAGES = 30;
/** Turnos hacia atrás cuyo log se lee: cada uno es un ndjson entero. */
export const MAX_HISTORY_TURNS = 30;

export const fenced = (text: string): string => `~~~\n${text.replaceAll('~~~', '~ ~ ~')}\n~~~`;

export interface ToolHistoryTurn {
  messageId: string;
  prompt: string;
  tools: TurnTool[];
}

/** Los pasos de herramienta que el agente dio en un turno, en orden, con su salida o su error. */
export function toolStepsOf(events: readonly EngineEvent[]): TurnTool[] {
  return foldMessage([...events]).steps
    .filter((s) => s.parentStepId === 'agent:write')
    .map((s) => {
      const out = s.detail?.kind === 'tool' && typeof s.detail.output === 'string' ? s.detail.output : s.error?.message;
      return { label: s.label, status: s.status, ...(out ? { output: out } : {}) };
    });
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** Páginas `tool-history/NN.md` más un `INDEX.md` que dice qué hay en cada una. Rutas relativas a `tool_content/`. */
export function toolHistoryFiles(turns: readonly ToolHistoryTurn[]): { rel: string; text: string }[] {
  type Row = { n: number; turn: number; first: boolean; tool: TurnTool };
  const rows: Row[] = [];
  turns.forEach((t, i) => t.tools.forEach((tool, j) => rows.push({ n: 0, turn: i + 1, first: j === 0, tool })));
  rows.forEach((r, i) => { r.n = i + 1; });
  if (!rows.length) return [];
  const keep = PAGE_TOOLS * MAX_PAGES;
  const omitted = Math.max(0, rows.length - keep);
  const shown = rows.slice(omitted);
  const pages: Row[][] = [];
  for (let i = 0; i < shown.length; i += PAGE_TOOLS) pages.push(shown.slice(i, i + PAGE_TOOLS));
  const name = (p: number): string => `tool-history/${String(p + 1).padStart(2, '0')}.md`;
  const files = pages.map((page, p) => {
    const body = page.flatMap((r) => {
      const t = r.tool;
      const out = t.output ? [fenced(t.output.slice(0, MAX_OUTPUT)), ...(t.output.length > MAX_OUTPUT ? [`(salida cortada: ${MAX_OUTPUT} de ${t.output.length} caracteres)`] : [])] : [];
      return [...(r.first ? [`# Pedido ${r.turn}: ${oneLine(turns[r.turn - 1]!.prompt, 120)}`, ''] : []), `## ${r.n}. ${t.label} (${t.status})`, ...(out.length ? ['', ...out] : []), ''];
    });
    return { rel: name(p), text: [`# Pasos del agente ${page[0]!.n}–${page[page.length - 1]!.n} de ${rows.length}`, '', ...body].join('\n') };
  });
  const index = [
    '# Historial de tools del chat', '',
    `${rows.length} pasos en ${turns.length} turnos, ${pages.length} página${pages.length > 1 ? 's' : ''} de hasta ${PAGE_TOOLS} pasos. Abre solo la página que el mensaje necesite.`,
    ...(omitted ? ['', `Los ${omitted} pasos más viejos no están: este historial guarda los últimos ${keep}.`] : []), '',
    ...pages.map((page, p) => `- \`${name(p).replace('tool-history/', '')}\`: pasos ${page[0]!.n}–${page[page.length - 1]!.n}, ${[...new Set(page.map((r) => r.turn))].map((t) => `pedido ${t}`).join(', ')}`), '',
  ].join('\n');
  return [{ rel: 'tool-history/INDEX.md', text: index }, ...files];
}
