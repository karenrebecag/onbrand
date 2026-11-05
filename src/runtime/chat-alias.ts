// Base por chat en el Runtime local (docs/spec/orquestador-enrutamiento.md §1.1, opción A de orq): el builder usa
// `/chats/:id/<fila>` en los dos modos. Detrás del orquestador esa fila llega a la VM ya traducida; aquí se traduce con la MISMA
// tabla (route-table.ts), así una ruta que en producción da 404 tampoco existe en local. Solo datos: el dueño y el chat de cada
// :m o :g los comprueba el router.

import { matchRoute, vmPath } from '../orchestrator/route-table';
import { MESSAGE_ID } from './shared';

/** §4: hasta 50 rutas por pedido, solo las dos familias que van a un `<img src>`. */
export const MEDIA_PATHS_MAX = 50;
/** Lo mismo que el token media del orquestador: el builder pide de nuevo al repintar. */
export const MEDIA_TTL_MS = 5 * 60_000;

/** Filas de §3.3-§3.4 que un chat solo reservado atiende para su dueño (spec §3.4: el builder abre el chat al entrar y pide por él
 * marcas, conectores, adjuntos, voz y prompt antes de la primera corrida; detrás del orquestador ese chat ya existe). Ninguna lee
 * el workspace del chat. Lista explícita (condición de Arq): una fila nueva bajo /brands o /connectors no entra sola. */
export const RESERVED_CHAT_ROWS: ReadonlySet<string> = new Set([
  'GET /brands', 'GET /brands/:id/instructions', 'PUT /brands/:id/instructions', 'GET /brands/:id/memory', 'PUT /brands/:id/memory',
  'GET /connectors/apps', 'GET /connectors/accounts', 'POST /connectors/connect', 'DELETE /connectors/accounts',
  'POST /uploads', 'POST /transcribe', 'POST /prompt-enhancements', 'POST /preview/heartbeat',
]);

export type ChatAlias =
  /** Fila de §3 cuya ruta en la VM no es `/chats/:chat/...`: `parts` es la ruta VM y `row` la fila (`MÉTODO /ruta` de la tabla). */
  | { readonly kind: 'route'; readonly chatId: string; readonly parts: string[]; readonly row: string }
  | { readonly kind: 'media-urls'; readonly chatId: string };

/** undefined = la ruta no es del alias y el router la atiende como hoy: las filas cuya ruta VM ya es `/chats/:chat/...` (hilo,
 * lienzo, plan, aprobación), las que el orquestador no expone y los métodos fuera de la tabla. */
export function chatAlias(method: string, parts: readonly string[]): ChatAlias | undefined {
  if (parts[0] !== 'chats' || parts.length < 3) return undefined;
  const chatId = parts[1]!;
  if (!MESSAGE_ID.test(chatId)) return undefined;
  if (method === 'POST' && parts.length === 3 && parts[2] === 'media-urls') return { kind: 'media-urls', chatId };
  const hit = matchRoute(method, `/${parts.slice(2).join('/')}`);
  if (!hit || hit === 'method' || hit.route.vm.startsWith('/chats/:chat')) return undefined;
  return { kind: 'route', chatId, parts: vmPath(hit.route, chatId, hit.params).split('/').filter(Boolean), row: `${hit.route.method} ${hit.route.path}` };
}

/** `{paths}` de POST media-urls validado como §4. Lanza con el motivo; el router lo responde 400 sin firmar nada. */
export function mediaPaths(body: unknown): string[] {
  const paths = (body as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MEDIA_PATHS_MAX) throw new Error(`paths debe ser una lista de 1 a ${MEDIA_PATHS_MAX} rutas`);
  for (const p of paths) {
    const hit = typeof p === 'string' ? matchRoute('GET', `/${p}`) : undefined;
    if (!hit || hit === 'method' || !hit.route.media) throw new Error(`ruta sin imagen firmable: ${String(p).slice(0, 200)}`);
  }
  return paths as string[];
}
