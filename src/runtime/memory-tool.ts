// Tool `remember` del agente (M2, spec contexto-agente §1): guarda un hecho duradero de la marca. Aquí solo viven la
// definición y la respuesta de la tool; la escritura del archivo y el evento memory.write son del transport (agent-mcp).
// Los topes, el formato y el filtro de datos personales son los de memory-edit.ts, los mismos que aplica el PUT de la persona.

import { addFact, MAX_FACT_CHARS, MAX_MEMORY_LINES } from './memory-edit';

export const REMEMBER_TOOL = 'remember';
export const REMEMBER_TOOL_FULL = `mcp__wt__${REMEMBER_TOOL}`;

export const REMEMBER_DEF = {
  name: REMEMBER_TOOL,
  description: `Guarda un hecho duradero de la marca (tono, público, algo que la persona pidió que siempre se cumpla) para los próximos mensajes de esta marca. Una frase de hasta ${MAX_FACT_CHARS} caracteres, sin correos, teléfonos ni claves. La memoria guarda hasta ${MAX_MEMORY_LINES} hechos: si está llena, pasa en \`replaces\` un texto que esté en el hecho que sustituyes.`,
  input_schema: {
    type: 'object',
    properties: {
      fact: { type: 'string', maxLength: MAX_FACT_CHARS, description: `el hecho, hasta ${MAX_FACT_CHARS} caracteres, en el idioma de la persona` },
      replaces: { type: 'string', description: 'texto que contiene el único hecho guardado que este sustituye' },
    },
    required: ['fact'],
    additionalProperties: false,
  },
};

/** Lo que el transport hace con el resultado: `ok:false` → error de la tool con `reply`; `ok:true` → escribe `text` en
 * memory.md y emite memory.write {fact, replaced?} salvo que `added` sea false (ya la sabía). */
export type RememberOutcome =
  | { ok: true; reply: string; text: string; added: boolean; fact: string; replaced?: string }
  | { ok: false; reply: string };

export function rememberFact(current: string, input: unknown, ctx: { messageId: string; date: string }): RememberOutcome {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  if (typeof o.fact !== 'string') return { ok: false, reply: 'fact: texto con el hecho a recordar' };
  if (o.replaces !== undefined && typeof o.replaces !== 'string') return { ok: false, reply: 'replaces: texto de un hecho guardado' };
  const r = addFact(current, { fact: o.fact, messageId: ctx.messageId, date: ctx.date, ...(o.replaces ? { replaces: o.replaces } : {}) });
  if (!r.ok) return { ok: false, reply: r.error };
  if (!r.added) return { ok: true, reply: 'Ya lo sabía: no agregué otra línea.', text: r.text, added: false, fact: r.fact };
  return { ok: true, reply: r.replaced ? 'Recordado: sustituí el hecho anterior.' : 'Recordado.', text: r.text, added: true, fact: r.fact, ...(r.replaced ? { replaced: r.replaced } : {}) };
}
