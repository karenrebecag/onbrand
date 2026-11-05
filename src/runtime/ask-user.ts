// La pregunta del agente como datos, no como texto del resumen: v0 la emite como task-ask-user-questions-v1 con sus
// opciones (deob/v0-design-mode/deobfuscated.js:12935) y la respuesta vuelve como answered-questions con la etiqueta
// elegida o texto libre (:10809, webcrack). En 78e0030b (#406) el resumen decía "elige una de estas opciones" sin traer
// ninguna y el builder mostraba los chips del turno anterior.

import type { Suggestion } from './event-model';

export const ASK_TOOL = 'ask_user';
export const ASK_TOOL_FULL = `mcp__wt__${ASK_TOOL}`;

export interface AgentQuestion {
  question: string;
  /** La recomendada primero, como el "(Recommended)" de v0; el clic manda `message`. */
  options: Suggestion[];
}

const MAX_QUESTION = 300;
const MAX_TITLE = 40;
const MAX_MESSAGE = 300;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

/** El input de la tool, validado: una pregunta y 2-3 opciones {title, message}. */
export function parseQuestion(input: unknown): { ok: true; value: AgentQuestion } | { ok: false; error: string } {
  const o = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const question = text(o.question, MAX_QUESTION);
  if (!question) return { ok: false, error: `question: texto de 1 a ${MAX_QUESTION} caracteres` };
  const raw = Array.isArray(o.options) ? o.options : [];
  if (raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) return { ok: false, error: `options: de ${MIN_OPTIONS} a ${MAX_OPTIONS} respuestas, la recomendada primero` };
  const options: Suggestion[] = [];
  for (const [i, opt] of raw.entries()) {
    const r = typeof opt === 'object' && opt !== null ? (opt as Record<string, unknown>) : {};
    const title = text(r.title, MAX_TITLE);
    const message = text(r.message, MAX_MESSAGE);
    if (!title || !message) return { ok: false, error: `options[${i}]: title de hasta ${MAX_TITLE} caracteres y message de hasta ${MAX_MESSAGE}` };
    options.push({ title, message });
  }
  return { ok: true, value: { question, options } };
}

export const ASK_TOOL_DEF = {
  name: ASK_TOOL,
  description: 'Pregunta a la persona por un valor que el mensaje no trae y no se deduce de la página (el texto nuevo de un titular, un precio). Se muestra como botones; la persona elige uno o escribe el suyo, y su respuesta llega como el siguiente mensaje. Después de llamarla no escribas archivos: termina el turno repitiendo la pregunta en una línea.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'la pregunta, en el idioma de la página' },
      options: {
        type: 'array',
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description: 'respuestas posibles sacadas de la página; la recomendada primero',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: `texto del botón, hasta ${MAX_TITLE} caracteres` },
            message: { type: 'string', description: 'el pedido completo que se manda al elegirla, p. ej. "Cambia el titular del hero a: …"' },
          },
          required: ['title', 'message'],
          additionalProperties: false,
        },
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
};
