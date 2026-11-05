// Plegado del hilo con tope para el follow-up (H18). Make comprime el hilo en el servidor y guarda `{summary, startIndex}`
// que reemplaza los primeros N mensajes (re-sistema/figma-make/datos/contexto-compresion-pipeline.md:11, deob make-chat
// 3277:39278-39301); el cliente solo lo reenvía y el algoritmo es inferido (mismo archivo, "Inferido"). Aquí: los N últimos
// turnos quedan íntegros y los viejos se reducen a un resumen en `conversation_history/summary.md`.

import { boundedSignal, OPTIONAL_TIMEOUT_MS, type Infer } from './infer';
import type { ThreadTurn } from './follow-up-context';

/** Turnos que se vuelcan completos; el resto entra al resumen. Con Make sin compresión hasta 0,341 de ventana (mismo
 * extract, "Observado en 7 turnos") un hilo corto no necesita plegarse. */
export const THREAD_KEEP = 4;
const TURN_CHARS = 600;
const SUMMARY_CHARS = 4000;

export interface ThreadFold { summary: string; count: number }

const SYSTEM = 'Resumes los primeros turnos de un chat de construcción de una página web para que el agente que sigue no los relea. Conserva decisiones, cambios hechos, datos que la persona dio y preferencias; omite pasos y detalles de código. Responde solo JSON: {"summary": string}, en el idioma de los pedidos, hasta 12 viñetas.';

// Mismo hilo, mismos turnos viejos: un follow-up tras otro reutiliza el resumen en vez de volver a pagarlo. Cache acotada.
// Dueño: el proceso; la llave es el texto de los turnos viejos, así que dos Runtime que compartan la cache solo se ahorran
// el pago, no se mezclan datos. Si hubiera dueños distintos por identidad, la llave tendría que incluirlo (D6).
const cache = new Map<string, string>();
const CACHE_MAX = 200;

const firstLine = (s: string): string => s.trim().split('\n')[0].slice(0, 160);
const clip = (s: string): string => (s.length > TURN_CHARS ? `${s.slice(0, TURN_CHARS)}…` : s);

/** Sin modelo (falla, tope o JSON raro) el resumen es la lista de pedidos: menos útil, pero el hilo viejo no se pierde. */
const plain = (old: ThreadTurn[]): string => old.map((t) => `- ${firstLine(t.prompt)}`).join('\n');

export async function foldThread(thread: ThreadTurn[], infer: Infer, signal?: AbortSignal): Promise<{ thread: ThreadTurn[]; folded?: ThreadFold }> {
  if (thread.length <= THREAD_KEEP) return { thread };
  const old = thread.slice(0, thread.length - THREAD_KEEP);
  const recent = thread.slice(-THREAD_KEEP);
  const key = old.map((t) => t.messageId).join('>');
  let summary = cache.get(key);
  if (summary === undefined) {
    try {
      const out = await infer(SYSTEM, JSON.stringify({ turns: old.map((t, i) => ({ n: i + 1, prompt: clip(t.prompt), ...(t.summary ? { agent: clip(t.summary) } : {}) })) }), boundedSignal(OPTIONAL_TIMEOUT_MS, signal));
      const text = typeof out === 'object' && out !== null ? (out as { summary?: unknown }).summary : undefined;
      summary = typeof text === 'string' && text.trim() ? text.trim().slice(0, SUMMARY_CHARS) : undefined;
    } catch { summary = undefined; }
    // Un resumen de respaldo no se cachea: el próximo follow-up reintenta con el modelo.
    if (summary !== undefined) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, summary);
    }
  }
  return { thread: recent, folded: { summary: summary ?? plain(old), count: old.length } };
}
