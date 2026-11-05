// Contrato de eventos del motor (M-CONTRACT), replicado de lo observado en el cliente de v0 en vivo
// (chat j049syuEqqA, 2026-10-22): cada mensaje del asistente es un log de eventos que cualquier pestaña
// sigue y retoma desde un cursor (`/chat/api/chat/resume?messageId=&cursor=`), y cada paso se pinta con
// una etiqueta en curso ("Finding headline") que pasa a pasado al cerrar ("Found headline"). La UI no
// inventa etiquetas: las pone quien emite. Aquí el log es NDJSON append-only, un archivo por messageId,
// y el cursor es el seq (entero, ordenado) en vez del uuid opaco de v0: permite reanudar con `after`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_VERSION, parseEvent, type EngineEvent, type EventBody } from './event-model';

export * from './event-model';

// El messageId termina en una ruta de archivo: sin esto un id con `../` escribe fuera del directorio.
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function assertMessageId(messageId: string): void {
  if (!MESSAGE_ID.test(messageId)) throw new Error(`events: messageId inválido "${messageId}"`);
}

const logPath = (dir: string, messageId: string): string => {
  assertMessageId(messageId);
  return join(dir, `${messageId}.ndjson`);
};

export interface EventLog {
  emit(body: EventBody): EngineEvent;
}

/** Escritor del log de un mensaje. El seq lo lleva el escritor (uno por mensaje), así el orden no
 * depende del reloj. Arranca después del último evento si el archivo ya existe (reanudar tras caída). */
// Observador opcional de cada evento emitido (las trazas de Spotlight); el log en disco sigue siendo la fuente.
// Dueño: scripts/serve.ts (arranque del proceso) fija el sink una vez; es del proceso, no de un Runtime, así que dos Runtime
// en el mismo proceso comparten observador. Mover a una dep del Runtime solo si conviven dos con trazas distintas (decisión D6).
let sink: ((event: EngineEvent) => void) | undefined;
export function setEventSink(fn: ((event: EngineEvent) => void) | undefined): void {
  sink = fn;
}

export function openEventLog(dir: string, messageId: string, now: () => number = Date.now): EventLog {
  const path = logPath(dir, messageId);
  mkdirSync(dir, { recursive: true });
  let next = existsSync(path) ? readEvents(dir, messageId).cursor + 1 : 0;
  return {
    emit(body) {
      const event = { ...body, v: EVENT_VERSION, messageId, seq: next, at: now() } as EngineEvent;
      appendFileSync(path, `${JSON.stringify(event)}\n`);
      next += 1;
      try {
        sink?.(event);
      } catch (err) {
        // La traza nunca tumba el turno: el evento ya quedó en disco.
        process.stderr.write(`events: sink falló: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return event;
    },
  };
}

export interface ReadResult {
  events: EngineEvent[];
  /** seq del último evento leído (-1 si no hay ninguno): se pasa como `after` para seguir. */
  cursor: number;
  done: boolean;
}

/** Lee el log de un mensaje desde `after` (exclusivo). Una última línea sin salto es un append en
 * curso y se ignora hasta la siguiente lectura; un hueco en el seq es corrupción y lanza. */
export function readEvents(dir: string, messageId: string, opts: { after?: number } = {}): ReadResult {
  const path = logPath(dir, messageId);
  const after = opts.after ?? -1;
  if (!existsSync(path)) return { events: [], cursor: after, done: false };
  const content = readFileSync(path, 'utf8');
  const complete = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1);
  const lines = complete.split('\n').filter((l) => l.length > 0);
  const all = lines.map((line, i) => {
    try {
      return parseEvent(JSON.parse(line));
    } catch (err) {
      throw new Error(`events: ${path} línea ${i + 1}: ${(err as Error).message}`);
    }
  });
  all.forEach((e, i) => {
    if (e.seq !== i) throw new Error(`events: ${path} seq ${e.seq} en la posición ${i} (hueco o desorden)`);
    if (e.messageId !== messageId) throw new Error(`events: ${path} trae eventos de ${e.messageId}`);
  });
  const events = all.filter((e) => e.seq > after);
  const last = all[all.length - 1];
  // Cerrado = el último message.start tiene su message.end. Un mensaje de plan (H6) lleva dos fases en el mismo log: el
  // message.end del plan no cierra la fase build que reanuda después.
  const lastStart = all.findLastIndex((e) => e.type === 'message.start');
  return { events, cursor: Math.max(after, last ? last.seq : -1), done: all.findLastIndex((e) => e.type === 'message.end') > lastStart };
}
