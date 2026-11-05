// Allowlist de rutas por chat del orquestador (docs/spec/orquestador-enrutamiento.md §3). Una ruta existe si está aquí con método y
// scope; el resto es 404, y un método fuera de la fila de una ruta que sí existe es 405. Solo datos y el casador: ni red ni sesión.

import type { Scope } from '../runtime/session';

export type BodyKind = 'none' | 'json' | 'multipart' | 'image';

export interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Relativa a `/chats/:chat`; `:x` es un parámetro con el formato de PARAMS. */
  readonly path: string;
  /** Ruta en el Runtime; `:chat` es el id del chat. */
  readonly vm: string;
  /** Todos a la vez. La VM los vuelve a comprobar con la identidad firmada. */
  readonly scopes: readonly Scope[];
  readonly body: BodyKind;
  /** Parámetros de query que se reenvían; el resto se descarta. */
  readonly query?: readonly string[];
  /** Tipos de respuesta permitidos además de application/json. */
  readonly types?: readonly string[];
  /** Solo POST /runs abre una corrida con gasto y recibe el token de la corrida. */
  readonly runToken?: boolean;
  readonly maxBytes?: number;
  /** Descarga: sale siempre como `attachment` (nombre de la VM si es simple, si no sintetizado) y con CSP sandbox: un HTML del agente no se renderiza bajo el origen de la API. */
  readonly attachment?: boolean;
  /** Se puede abrir con un token media en la URL (sin Bearer): solo las imágenes que el builder pone en un `<img src>`. */
  readonly media?: boolean;
  /** La atiende el orquestador con el puerto `connectors` del perfil, nunca la VM (spec §8): la credencial de Pipedream no entra en una VM que corre código del agente.
   * Sin el puerto la ruta responde 501 `connectors-unavailable`. */
  readonly connector?: 'apps' | 'accounts' | 'connect' | 'disconnect';
  /** La VM contesta `{ always: <tool> }` cuando guardó un "siempre": el orquestador lo escribe en el índice global y lo quita de la respuesta (spec §8). */
  readonly captureAlways?: boolean;
  /** La atiende el orquestador con el registro de aprobaciones (spec §8.1): lo que la tarjeta muestra sale de ahí y no de lo que diga la VM. */
  readonly pending?: boolean;
  /** Respuesta larga sin buffer que el orquestador corta antes del `maxDuration` del despliegue: `resume` = fin limpio y el cliente reconecta por cursor;
   * `error` = no hay cursor, así que un corte es un error visible y no un texto truncado que parezca completo. */
  readonly stream?: 'resume' | 'error';
}

export const JSON_MAX_BYTES = 1024 * 1024;
/** Una Function no recibe más de 4,5 MiB de cuerpo (spec §7); 4 MiB deja margen para el multipart. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const ID = /^[a-z0-9-]{1,63}$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const PARAMS: Readonly<Record<string, RegExp>> = { m: ID, g: ID, callId: NAME, name: NAME, file: NAME, id: NAME, tool: NAME };

const R = (method: Route['method'], path: string, scopes: readonly Scope[], body: BodyKind, more: Partial<Route> = {}): Route =>
  ({ method, path, vm: more.vm ?? path, scopes, body, ...more });
const READ: readonly Scope[] = ['chat:read'];
const WRITE: readonly Scope[] = ['chat:write'];

export const ROUTES: readonly Route[] = [
  // Corridas y lectura de una versión
  R('POST', '/runs', WRITE, 'json', { runToken: true }),
  R('GET', '/runs/:m/events', READ, 'none', { query: ['cursor'], types: ['application/x-ndjson'], stream: 'resume' }),
  R('POST', '/runs/:m/cancel', WRITE, 'none'),
  R('POST', '/runs/:m/publish', WRITE, 'none'),
  R('GET', '/runs/:m/files', READ, 'none'),
  R('GET', '/runs/:m/diff', READ, 'none'),
  R('GET', '/runs/:m/versions', READ, 'none'),
  R('GET', '/runs/:m/export', READ, 'none', { query: ['format'], types: ['application/zip', 'text/html', 'text/markdown'], attachment: true }),
  R('GET', '/runs/:m/shots/:file', READ, 'none', { types: IMAGE_TYPES, media: true }),
  R('POST', '/variants/:g/cancel', WRITE, 'none'),
  // Chat, lienzo, plan, aprobaciones
  R('GET', '', READ, 'none', { vm: '/chats/:chat' }),
  R('GET', '/canvas', READ, 'none', { vm: '/chats/:chat/canvas' }),
  R('PUT', '/canvas', WRITE, 'json', { vm: '/chats/:chat/canvas' }),
  R('POST', '/canvas/files', WRITE, 'image', { vm: '/chats/:chat/canvas/files', query: ['name'], maxBytes: UPLOAD_MAX_BYTES }),
  R('GET', '/canvas/files/:name', READ, 'none', { vm: '/chats/:chat/canvas/files/:name', types: IMAGE_TYPES, media: true }),
  R('GET', '/plans/:m', READ, 'none', { vm: '/chats/:chat/plans/:m' }),
  R('GET', '/approvals/:callId', READ, 'none', { vm: '/chats/:chat/approvals/:callId', pending: true }),
  R('POST', '/approvals/:callId', WRITE, 'json', { vm: '/chats/:chat/approvals/:callId', captureAlways: true }),
  // Archivos, voz, prompt, latido
  R('POST', '/uploads', WRITE, 'multipart', { maxBytes: UPLOAD_MAX_BYTES }),
  R('POST', '/transcribe', ['chat:write', 'spend'], 'multipart', { maxBytes: UPLOAD_MAX_BYTES }),
  R('POST', '/prompt-enhancements', ['chat:write', 'spend'], 'json', { types: ['text/plain'], stream: 'error' }),
  R('POST', '/preview/heartbeat', READ, 'json'),
  // Estado del dueño colgado de un chat (spec §3.4)
  R('GET', '/brands', READ, 'none'),
  R('GET', '/brands/:id/instructions', READ, 'none'),
  R('PUT', '/brands/:id/instructions', ['brand:write'], 'json'),
  R('GET', '/brands/:id/memory', READ, 'none'),
  R('PUT', '/brands/:id/memory', ['brand:write'], 'json'),
  // Conectores (spec §8): el puerto `connectors` del perfil los atiende en el orquestador, por dueño; `vm` no se usa.
  R('GET', '/connectors/apps', READ, 'none', { query: ['q', 'after'], connector: 'apps' }),
  R('GET', '/connectors/accounts', READ, 'none', { connector: 'accounts' }),
  R('POST', '/connectors/connect', WRITE, 'json', { connector: 'connect' }),
  R('DELETE', '/connectors/accounts', WRITE, 'none', { query: ['id'], connector: 'disconnect' }),
];

/** Conectores del dueño, sin chat: las mismas filas de arriba, vistas desde la raíz (`/connectors/...`). Las del chat quedan como alias hasta el 2026-12-05
 * (propuesta: la confirman Karen y UI cuando el builder migre) y entonces se quitan de ROUTES. */
export function matchOwnerRoute(method: string, pathname: string): { readonly route: Route } | 'method' | undefined {
  let pathHit = false;
  for (const route of ROUTES) {
    if (!route.connector || route.path !== pathname) continue;
    if (route.method === method) return { route };
    pathHit = true;
  }
  return pathHit ? 'method' : undefined;
}

/** Rutas de la VM (spec §3.6): se autentican con el token de la corrida (typ `run`), no con la sesión de una persona, y se atienden antes de `authenticate`.
 * Todo `/gw/*` que no esté aquí es 404: una ruta nueva no entra sin fila. `*` al final = cualquier sufijo. */
export interface GwRoute {
  readonly id: 'gateway' | 'always' | 'connectors-mcp' | 'connectors-forward' | 'approvals-pending' | 'approvals-grant';
  readonly method: 'GET' | 'POST' | '*';
  readonly path: string;
}
export const GW_ROUTES: readonly GwRoute[] = [
  { id: 'gateway', method: '*', path: '/gw/claude-code/*' },
  { id: 'always', method: 'GET', path: '/gw/always' },
  { id: 'connectors-mcp', method: 'POST', path: '/gw/connectors/mcp' },
  { id: 'connectors-forward', method: 'POST', path: '/gw/connectors/forward/:slug' },
  { id: 'approvals-pending', method: 'POST', path: '/gw/approvals/pending' },
  { id: 'approvals-grant', method: 'POST', path: '/gw/approvals/grant' },
];
const GW_SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function matchGw(method: string, pathname: string): GwRoute | 'method' | undefined {
  let pathHit = false;
  for (const route of GW_ROUTES) {
    const star = route.path.endsWith('/*');
    const pat = segmentsOf(star ? route.path.slice(0, -2) : route.path);
    const segs = segmentsOf(pathname);
    if (star ? segs.length <= pat.length : segs.length !== pat.length) continue;
    if (!pat.every((p, i) => (p === ':slug' ? GW_SLUG.test(segs[i]!) && segs[i]!.length <= 100 : p === segs[i]))) continue;
    if (route.method === '*' || route.method === method) return route;
    pathHit = true;
  }
  return pathHit ? 'method' : undefined;
}

export type Match = { readonly route: Route; readonly params: Readonly<Record<string, string>> } | 'method' | undefined;

const segmentsOf = (path: string): string[] => (path === '' ? [] : path.slice(1).split('/'));

function matchPath(route: Route, segs: readonly string[]): Record<string, string> | undefined {
  const pat = segmentsOf(route.path);
  if (pat.length !== segs.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p.startsWith(':')) {
      const name = p.slice(1);
      if (!PARAMS[name]!.test(segs[i]!)) return undefined;
      params[name] = segs[i]!;
    } else if (p !== segs[i]) return undefined;
  }
  return params;
}

/** `rest` es lo que sigue a `/chats/:chat` (vacío o con `/` delante). Segmentos con `%`, `..` o vacíos no casan con ningún parámetro. */
export function matchRoute(method: string, rest: string): Match {
  const segs = segmentsOf(rest);
  let pathHit = false;
  for (const route of ROUTES) {
    const params = matchPath(route, segs);
    if (!params) continue;
    if (route.method === method) return { route, params };
    pathHit = true;
  }
  return pathHit ? 'method' : undefined;
}

/** La ruta del Runtime con el chat y los parámetros ya puestos. */
export function vmPath(route: Route, chatId: string, params: Readonly<Record<string, string>>): string {
  return route.vm.split('/').map((s) => (s === ':chat' ? chatId : s.startsWith(':') ? params[s.slice(1)]! : s)).join('/');
}

/** Solo los parámetros de query de la fila, con valores acotados. */
export function filterQuery(route: Route, search: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const name of route.query ?? []) {
    const v = search.get(name);
    if (v !== null && v.length <= 512) out.set(name, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}
