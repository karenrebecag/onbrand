// Rutas del orquestador (docs/spec/deploy-sandbox.md §0, §3, §4): función pura `(Request) => Response`, sin servidor ni SDK. Autentica
// a la persona, lleva el índice global de chats, firma la identidad y el token de gasto de cada corrida y reenvía al Runtime del chat.
// El Runtime no ve la sesión de la persona, solo `x-wt-identity`; el CLI no ve ninguna llave, solo `x-wt-run-token`.

import { createPublicKey, type KeyObject } from 'node:crypto';
import { REJECTION_STATUS, REJECTION_TEXT, WWW_AUTHENTICATE, type Rejection, type Scope, type Session } from '../runtime/session';
import { argsHash, dayWindow, ChatExistsError, PendingInputError, PendingLimitError, TOOL_NAME, type ChatEntry, type ChatIndex } from './chat-index';
import { APPROVAL_TIMEOUT_MS, SPEND_TOOLS } from '../runtime/approvals';
import { MAX_TTL_MS, verify as verifyToken } from '../signed-token';
import { issueGrant, issueIdentity, issueMediaToken, issueRunToken } from './identity';
import { CONNECTOR_REPLY_MAX_BYTES } from '../runtime/connector-mcp';
import { filterQuery, IMAGE_TYPES, JSON_MAX_BYTES, matchGw, matchOwnerRoute, matchRoute, vmPath, type Route } from './route-table';

/** Tope diario por dueño en USD cuando el entorno no fija otro (cifra de Karen, 2026-11-05). */
export const DEFAULT_OWNER_CAP_USD = 5;
/** Vida de un token de corrida y su techo: una corrida del agente dura minutos; 2 h cubre la más larga sin dejar un token olvidado. */
export const DEFAULT_RUN_TTL_MS = 30 * 60_000;
export const MAX_RUN_TTL_MS = 2 * 3_600_000;
const IDENTITY_TTL_MS = 5 * 60_000;
const MAX_BODY_BYTES = JSON_MAX_BYTES;
const MULTIPART = /^multipart\/form-data; boundary=[\w'()+,.\/:=? -]{1,70}$/i;
const CACHEABLE = /^(no-store|private(, max-age=\d{1,9})?(, immutable)?)$/;
const EXPORT_EXT: Readonly<Record<string, string>> = { 'application/zip': '.zip', 'text/html': '.html', 'text/markdown': '.md' };
const ATTACHMENT = /^attachment; filename="[\w.-]{1,128}"$/;
// HACK: 100 chats por dueño y 10 altas por minuto por instancia (de chat o de enlace de conexión) son cifras de partida, no de Karen. El minuto es en memoria de la Function
// (varias instancias suman más) y el tope de chats lee la lista y crea después, sin atomicidad: N altas paralelas pasan el tope por N,
// acotadas por la tasa. Subirlas o moverlas al índice (reserva condicional como reserveSpend) cuando un dueño legítimo las toque.
// El mapa de la tasa guarda (cubo, dueño) y no se limpia: un cubo por acción (chat, connect, gw-connectors, gw-forward) multiplica las claves por dueño, y 120
// reenvíos por minuto es una cifra de partida para el agente. Barrerlo por antigüedad cuando el número de dueños por instancia lo justifique.
const DEFAULT_MAX_CHATS = 100;
const CREATES_PER_MINUTE = 10;
const FORWARDS_PER_MINUTE = 120;
// Lo que sigue al id lo casa la allowlist de route-table.ts: `..`, `%2e%2e`, `%2f`, `.` y vacíos no casan con ningún parámetro.
const MAX_MEDIA_PATHS = 50;
// Sin `_` al inicio, al final ni doble: así `mcp__<slug>__<tool>` se lee de una sola forma (`a` + `_b` y `a_` + `b` no chocan).
const APP_SLUG = /^(?=.{1,100}$)[a-z0-9]+(?:_[a-z0-9]+)*$/;
const RESERVED_SERVERS: ReadonlySet<string> = new Set(['wt', 'approval']);
const TOOL_OF_APP = /^mcp__([a-z0-9]+(?:_[a-z0-9]+)*)__.+$/;
const CHAT = /^\/chats\/([a-z0-9-]{26,63})(\/.*)?$/;

export interface OrchestratorDeps {
  /** La persona detrás del request (Clerk u otro, del perfil). Rechazo = 401/403 con su `code`. */
  readonly authenticate: (req: Request) => Promise<Session | Rejection>;
  readonly index: Pick<ChatIndex, 'createChat' | 'getChat' | 'listChats' | 'readSpend' | 'readAlways' | 'addAlways' | 'removeAlways' | 'registerPending' | 'readPending' | 'decidePending' | 'revertPending' | 'takeGrant' | 'useGrant'>;
  readonly privateKey: KeyObject;
  /** Base URL del Runtime que sirve ese chat (hoy un Runtime local; con Sandbox, la VM del chat). Sin barra final. */
  readonly runtimeUrl: (chat: ChatEntry) => string | Promise<string>;
  /** El proxy de Gateway (createGatewayProxy) para `/gw/claude-code/*`; el orquestador solo enruta. */
  readonly gateway: (req: Request) => Promise<Response>;
  /** Tope diario por dueño que muestra GET /spend; es el mismo número con el que se construyó el proxy. */
  readonly ownerCapUsd: number;
  readonly runTtlMs?: number;
  readonly forward?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  /** Un fallo interno (Blob, VM) se reporta aquí y el cliente recibe un 502/503 sin detalles. Default console.error. */
  readonly onError?: (e: unknown) => void;
  /** Tope de chats por dueño (default 100). */
  readonly maxChatsPerOwner?: number;
  /** Catálogo de modelos de la persona (lo aporta el perfil): `/models` y `/image-models` se sirven aquí, sin despertar una VM. Ausente = 404. */
  readonly catalog?: Catalog;
  /** Conectores de la persona (lo aporta el perfil). Ausente = 501 `connectors-unavailable`. */
  readonly connectors?: ConnectorsPort;
  /** Una respuesta en stream (events, enhancer) se corta a los N ms, antes del maxDuration del despliegue; el cliente reconecta por cursor. */
  readonly streamMaxMs?: number;
}

/** Puerto `connectors` del perfil: cuentas de apps (Pipedream u otro) por dueño. La credencial vive en el orquestador; la VM nunca la ve. */
export interface ConnectorsPort {
  apps(q: string, after: string): Promise<unknown>;
  accounts(owner: string): Promise<unknown>;
  connect(owner: string, app: string): Promise<unknown>;
  /** false = esa cuenta no es de este dueño. */
  disconnect(owner: string, id: string): Promise<boolean>;
  /** Para las corridas del agente (`/gw/connectors/*`): sin estas dos la VM no recibe apps. */
  mcp?(owner: string, slugs: readonly string[]): Promise<{ apps: readonly string[]; readOnlyTools: readonly string[] }>;
  forward?(owner: string, slug: string, message: unknown, session?: string): Promise<{ status: number; text: string; session?: string }>;
}

export interface CatalogModel { readonly id: string; readonly name: string; readonly provider: string }
export interface Catalog {
  readonly models: readonly CatalogModel[];
  readonly imageModels: readonly CatalogModel[];
  readonly capabilities?: { readonly transcribe: boolean };
}

/** WT_OWNER_CAP_USD, validado: un NaN o un negativo dejaría el tope abierto o a cero sin avisar, así que el arranque falla. */
export function ownerCapFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.WT_OWNER_CAP_USD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_OWNER_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`WT_OWNER_CAP_USD=${raw} debe ser un número finito >= 0 (USD por dueño y día UTC)`);
  return n;
}

/** Corta `body` a los `ms` y cancela la request a la VM: `resume` da un fin limpio (el cliente reconecta por cursor) y `error` un error de stream. */
function cutAfter(body: ReadableStream<Uint8Array>, ms: number, mode: 'resume' | 'error'): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cut = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        cut = true;
        reader.cancel().catch(() => undefined);
        // Sin cursor para reanudar, un fin limpio haría pasar un texto truncado por completo: se cierra con error.
        if (mode === 'error') controller.error(new Error('stream cortado por el límite de duración')); else controller.close();
      }, ms);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { clearTimeout(timer); if (!cut) controller.close(); } else controller.enqueue(value);
      } catch (e) {
        // Tras el corte el stream ya está cerrado. Antes del corte es un fallo del upstream (la VM murió): el cliente lo ve como error, no como un fin limpio.
        if (!cut) { clearTimeout(timer); controller.error(e); }
      }
    },
    cancel(reason) { clearTimeout(timer); return reader.cancel(reason); },
  });
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const isRejection = (v: Session | Rejection): v is Rejection => 'code' in v;

export function createOrchestrator(deps: OrchestratorDeps): (req: Request) => Promise<Response> {
  if (!Number.isFinite(deps.ownerCapUsd) || deps.ownerCapUsd < 0) throw new Error('orquestador: ownerCapUsd debe ser un número finito >= 0');
  const runTtl = deps.runTtlMs ?? DEFAULT_RUN_TTL_MS;
  if (!Number.isFinite(runTtl) || runTtl <= 0 || runTtl > MAX_RUN_TTL_MS) throw new Error(`orquestador: runTtlMs debe estar entre 1 y ${MAX_RUN_TTL_MS}`);
  const now = deps.now ?? Date.now;
  const forward = deps.forward ?? ((url, init) => fetch(url, init));
  const publicKey = createPublicKey(deps.privateKey);

  const maxChats = deps.maxChatsPerOwner ?? DEFAULT_MAX_CHATS;
  const reportError = deps.onError ?? ((e: unknown) => console.error('[orquestador]', e));
  const created = new Map<string, number[]>();
  // Un cubo por acción (altas de chat, enlaces de conexión): cada POST de connect crea un enlace y un token en el proveedor.
  const rateOk = (owner: string, bucket = 'chat', limit = CREATES_PER_MINUTE): boolean => {
    const t = now();
    const key = `${bucket}:${owner}`;
    const recent = (created.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= limit) { created.set(key, recent); return false; }
    created.set(key, [...recent, t]);
    return true;
  };

  /** Lee el cuerpo contando bytes: corta en cuanto pasa el tope (content-length primero), sin armarlo entero en memoria. */
  async function readBytes(req: Request, max: number): Promise<Uint8Array | 'too-large'> {
    if (Number(req.headers.get('content-length') ?? 0) > max) return 'too-large';
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = req.body?.getReader();
    if (!reader) return new Uint8Array();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel().catch(() => undefined); return 'too-large'; }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  async function readText(req: Request): Promise<string | 'too-large'> {
    const raw = await readBytes(req, MAX_BODY_BYTES);
    return raw === 'too-large' ? raw : Buffer.from(raw).toString('utf8');
  }
  // Un POST sin application/json es un form o un fetch no-cors de otra página: no se atiende (fuerza preflight al navegador).
  const isJson = (req: Request): boolean => (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';

  async function createChat(session: Session, req: Request): Promise<Response> {
    if (!isJson(req)) return json(415, { code: 'unsupported-media-type' });
    const raw = await readText(req);
    if (raw === 'too-large') return json(413, { code: 'too-large' });
    let title = '';
    try {
      const body: unknown = raw === '' ? {} : JSON.parse(raw);
      if (typeof body === 'object' && body !== null && typeof (body as { title?: unknown }).title === 'string') title = (body as { title: string }).title.slice(0, 200);
    } catch { return json(400, { code: 'bad-json' }); }
    if (!rateOk(session.owner)) return json(429, { code: 'rate-limited' });
    if ((await deps.index.listChats(session.owner)).length >= maxChats) return json(409, { code: 'chat-limit' });
    // El chatId es el messageId de la primera corrida (el ws del Runtime lo toma de ahí) y STRONG_MESSAGE_ID pide 26+ caracteres.
    const chatId = crypto.randomUUID();
    try {
      const entry = await deps.index.createChat({ chatId, owner: session.owner, title, sandbox: { name: '' }, head: { messageId: '', commit: '' }, updatedAt: now(), spend: 0 });
      return json(201, { chatId: entry.chatId });
    } catch (e) {
      if (e instanceof ChatExistsError) return json(409, { code: 'exists' });
      throw e;
    }
  }

  async function spend(session: Session): Promise<Response> {
    const counter = await deps.index.readSpend(session.owner);
    return json(200, { spentUsd: counter.spent, capUsd: deps.ownerCapUsd, window: 'day', resetsAt: dayWindow(now()).resetsAt, updatedAt: counter.updatedAt });
  }

  const typeOf = (res: Response): string => (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const denied = (): Response => json(REJECTION_STATUS.scope, { code: 'scope', error: REJECTION_TEXT.scope });

  /** `/models` e `/image-models` (spec §3.1): sesión sin scope, mismo cuerpo que daría la VM, pero sin despertar una. */
  function catalogRoute(path: string): Response {
    if (!deps.catalog) return json(404, { code: 'not-found' });
    // Se proyecta cada campo: el perfil arma el catálogo y un objeto de un proveedor traería claves o precios que no son del navegador.
    const pick = (m: CatalogModel): CatalogModel => ({ id: m.id, name: m.name, provider: m.provider });
    const res = path === '/models'
      ? json(200, { models: deps.catalog.models.map(pick), capabilities: { transcribe: Boolean(deps.catalog.capabilities?.transcribe) } })
      : json(200, { models: deps.catalog.imageModels.map(pick) });
    res.headers.set('x-content-type-options', 'nosniff');
    res.headers.set('cache-control', 'private, no-store');
    return res;
  }

  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
  const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;

  /** Lo que sale al navegador se proyecta campo a campo: el puerto lo arma un tercero y una cuenta trae más de lo que el cliente debe ver. */
  async function connectorsRoute(kind: NonNullable<Route['connector']>, owner: string, req: Request, url: URL): Promise<Response> {
    const port = deps.connectors!;
    const out = (body: unknown): Response => { const r = json(200, body); r.headers.set('x-content-type-options', 'nosniff'); r.headers.set('cache-control', 'private, no-store'); return r; };
    try {
      if (kind === 'apps') {
        const r = (await port.apps(str(url.searchParams.get('q'), 100), str(url.searchParams.get('after'), 200))) as { apps?: unknown; total?: unknown; next?: unknown } | null;
        const apps = Array.isArray(r?.apps) ? (r.apps as Record<string, unknown>[]).slice(0, 50).map((a) => ({ slug: str(a.slug, 100), name: str(a.name, 200), description: typeof a.description === 'string' ? a.description.slice(0, 500) : null, icon: typeof a.icon === 'string' && a.icon.startsWith('https://') ? a.icon : null })) : [];
        return out({ apps, total: Number(r?.total ?? apps.length) || 0, next: typeof r?.next === 'string' ? r.next.slice(0, 200) : null });
      }
      if (kind === 'accounts') {
        const r = (await port.accounts(owner)) as { accounts?: unknown } | unknown[] | null;
        const list = Array.isArray(r) ? r : Array.isArray(r?.accounts) ? r.accounts : [];
        return out({ accounts: (list as Record<string, unknown>[]).slice(0, 200).map((a) => ({ id: str(a.id, 100), app: str(a.app, 100), name: typeof a.name === 'string' ? a.name.slice(0, 200) : null, state: a.state === 'connected' ? 'connected' : 'reconnect' })) });
      }
      if (kind === 'connect') {
        if (!isJson(req)) return json(415, { code: 'unsupported-media-type' });
        const raw = await readText(req);
        if (raw === 'too-large') return json(413, { code: 'too-large' });
        let app: unknown;
        try { app = (JSON.parse(raw) as { app?: unknown } | null)?.app; } catch { return json(400, { code: 'bad-json' }); }
        if (typeof app !== 'string' || !APP_SLUG.test(app)) return json(400, { code: 'bad-app' });
        if (!rateOk(owner, 'connect')) return json(429, { code: 'rate-limited' });
        const r = (await port.connect(owner, app)) as { url?: unknown; expiresAt?: unknown } | null;
        // Un enlace que no sea https no se entrega: el navegador lo abriría con la sesión de la persona.
        if (typeof r?.url !== 'string' || !r.url.startsWith('https://')) throw new Error('connectors: el puerto no devolvió un enlace https');
        return out({ url: r.url, expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt.slice(0, 40) : null });
      }
      const id = url.searchParams.get('id') ?? '';
      if (!ACCOUNT_ID.test(id)) return json(404, { code: 'not-found' });
      return (await port.disconnect(owner, id)) ? out({ ok: true }) : json(404, { code: 'not-found' });
    } catch (e) {
      reportError(e);
      return json(502, { code: 'bad-gateway' });
    }
  }

  /** POST /chats/:id/media-urls (spec §4): firma un token de 5 min por cada ruta de imagen pedida. Devuelve la ruta con `?wt_media=` relativa a
   * la base del chat, para que el builder la componga con su `api`. Las que no sean una fila `media` de la tabla no se firman. */
  async function mediaUrls(session: Session, req: Request, chatId: string): Promise<Response> {
    if (req.method !== 'POST') return json(405, { code: 'method-not-allowed' });
    if (!session.scopes.has('chat:read')) return denied();
    if (!(await deps.index.getChat(session.owner, chatId))) return json(404, { code: 'not-found' });
    if (!isJson(req)) return json(415, { code: 'unsupported-media-type' });
    const raw = await readText(req);
    if (raw === 'too-large') return json(413, { code: 'too-large' });
    let paths: unknown;
    try { paths = (JSON.parse(raw) as { paths?: unknown } | null)?.paths; } catch { return json(400, { code: 'bad-json' }); }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_MEDIA_PATHS) return json(400, { code: 'bad-body' });
    const urls: Record<string, string> = {};
    for (const p of paths) {
      const hit = typeof p === 'string' && p.length <= 200 && !p.startsWith('/') ? matchRoute('GET', `/${p}`) : undefined;
      if (typeof p !== 'string' || !hit || hit === 'method' || !hit.route.media) return json(400, { code: 'bad-path' });
      urls[p] = `${p}?wt_media=${issueMediaToken(deps.privateKey, session.owner, chatId, p, now)}`;
    }
    return json(200, { urls, expiresAt: now() + MAX_TTL_MS.media });
  }

  /** GET con `?wt_media=` y sin Authorization: el token abre ESA ruta de imagen de ESE chat y se convierte en una sesión `chat:read`
   * del dueño que lo pidió; de ahí en adelante es una petición normal (dueño, tabla, tipos de respuesta). Cualquier defecto es 401. */
  async function mediaGet(req: Request, url: URL, chatId: string, rest: string): Promise<Response> {
    const hit = matchRoute('GET', rest);
    const token = url.searchParams.get('wt_media');
    if (!token || hit === undefined || hit === 'method' || !hit.route.media) return json(401, { code: 'invalid-media-token' });
    const v = verifyToken(publicKey, token, { typ: 'media', chat: chatId, path: rest.slice(1), now: now() });
    if (!v.ok) return json(401, { code: 'invalid-media-token' });
    // Identidad de lectura y nada más: un token media nunca abre algo con chat:write.
    return chatRoute({ owner: v.claims.owner, scopes: new Set<Scope>(['chat:read']) }, req, url, chatId, rest);
  }

  /** Orden (spec §1.3), todo antes de despertar la VM: ruta y método en la allowlist, scope, dueño, forma del cuerpo. */
  async function chatRoute(session: Session, req: Request, url: URL, chatId: string, rest: string): Promise<Response> {
    const startedAt = Date.now();
    if (rest === '/media-urls') return mediaUrls(session, req, chatId);
    const hit = matchRoute(req.method, rest);
    if (hit === undefined) return json(404, { code: 'not-found' });
    if (hit === 'method') return json(405, { code: 'method-not-allowed' });
    const { route, params } = hit;
    if (!route.scopes.every((sc) => session.scopes.has(sc))) return denied();
    const chat = await deps.index.getChat(session.owner, chatId);
    // Mismo 404 para un chat ajeno y uno inexistente: el dueño de otro no se deja adivinar.
    if (!chat) return json(404, { code: 'not-found' });
    if (route.pending) return pendingView(session.owner, chatId, params.callId!);
    // Conectores: los atiende el puerto del perfil aquí, sin VM (spec §8).
    if (route.connector) return deps.connectors ? connectorsRoute(route.connector, session.owner, req, url) : json(501, { code: 'connectors-unavailable' });
    const writes = req.method === 'POST' || req.method === 'PUT';
    const contentType = req.headers.get('content-type') ?? '';
    // Una escritura que un form o un fetch no-cors pueda armar no se atiende: JSON, o multipart con x-wt-request, o una imagen (fuerzan preflight).
    // DELETE no lleva cuerpo y por ser no simple ya fuerza preflight; POST y PUT sí piden JSON.
    if (writes && (route.body === 'json' || route.body === 'none') && !isJson(req)) return json(415, { code: 'unsupported-media-type' });
    if (route.body === 'multipart') {
      if (!MULTIPART.test(contentType)) return json(415, { code: 'unsupported-media-type' });
      if (req.headers.get('x-wt-request') !== '1') return json(403, { code: 'missing-request-header' });
    }
    const imageType = contentType.split(';')[0]!.trim().toLowerCase();
    if (route.body === 'image' && !(IMAGE_TYPES as readonly string[]).includes(imageType)) return json(415, { code: 'unsupported-media-type' });

    const headers = new Headers();
    for (const h of ['accept', 'last-event-id']) { const v = req.headers.get(h); if (v) headers.set(h, v); }
    // Se construyen aquí; lo que el cliente haya mandado con estos nombres no se reenvía (arriba solo pasan dos headers).
    headers.set('x-wt-identity', issueIdentity(deps.privateKey, session, chatId, IDENTITY_TTL_MS, now));
    let body: string | Uint8Array | undefined;
    // El consentimiento es de la petición de la persona, no de lo que conteste la VM: una VM comprometida no puede fabricar un "siempre".
    let approval: ApprovalOutcome | undefined;
    if (route.body === 'json') {
      const raw = await readText(req);
      if (raw === 'too-large') return json(413, { code: 'too-large' });
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return json(400, { code: 'bad-json' }); }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return json(400, { code: 'bad-body' });
      const b = { ...(parsed as Record<string, unknown>) };
      if (route.captureAlways) {
        const verdict = await decideApproval(session, chatId, params.callId!, b);
        if (verdict instanceof Response) return verdict;
        approval = verdict;
      }
      headers.set('content-type', 'application/json');
      // Solo POST /runs abre una corrida con gasto: /cancel, /publish y demás rutas no reciben el token de gasto.
      if (route.runToken) {
        // La primera corrida abre el ws del chat: su messageId ES el chatId. Las siguientes cuelgan de un padre del mismo ws.
        if (b.parentId === undefined) b.messageId = chatId;
        headers.set('x-wt-run-token', issueRunToken(deps.privateKey, session.owner, chatId, '', runTtl, MAX_RUN_TTL_MS, now, requestedApps(b.connectors)));
      }
      body = JSON.stringify(b);
    } else if (route.body === 'multipart' || route.body === 'image') {
      const raw = await readBytes(req, route.maxBytes ?? MAX_BODY_BYTES);
      if (raw === 'too-large') return json(413, { code: 'too-large' });
      headers.set('content-type', route.body === 'image' ? imageType : contentType);
      if (route.body === 'multipart') headers.set('x-wt-request', '1');
      body = raw;
    }
    // redirect manual: un 3xx de la VM (que el agente puede influir) no manda al orquestador a seguir una URL con la identidad firmada.
    let upstream: Response;
    try {
      upstream = await forward(`${await deps.runtimeUrl(chat)}${vmPath(route, chatId, params)}${filterQuery(route, url.searchParams)}`, { method: req.method, headers, redirect: 'manual', ...(body === undefined ? {} : { body: body as NonNullable<RequestInit['body']> }), signal: req.signal });
    } catch (e) {
      if (approval?.decided) await deps.index.revertPending(session.owner, chatId, params.callId!).catch(reportError);
      throw e;
    }
    // La decisión se fijó antes de reenviar (la VM recoge el permiso en cuanto la acepta); si la VM no la acepta, la tarjeta vuelve a poder decidirse.
    if (approval?.decided && upstream.status !== 200) await deps.index.revertPending(session.owner, chatId, params.callId!).catch(reportError);
    if (route.captureAlways && upstream.status === 200) return finishApproval(route, upstream, session.owner, approval, startedAt);
    return passThrough(route, upstream, startedAt);
  }

  interface ApprovalOutcome { readonly wantedAlways: boolean; readonly saveTool?: string; /** La decisión ya quedó en el registro: si la VM no la acepta se revierte. */ readonly decided?: boolean }

  /** Registro de aprobaciones (spec §8.1): lo que la tarjeta muestra y el permiso salen de aquí, no de la VM. Sin registro la decisión no llega a la VM (404): sin la tool que vio
   * la persona no hay con qué ligar el permiso ni el "siempre". */
  async function decideApproval(session: Session, chatId: string, callId: string, b: Record<string, unknown>): Promise<ApprovalOutcome | Response> {
    const decision = b.decision;
    const wantedAlways = decision === 'always';
    if (decision !== 'allow' && decision !== 'always' && decision !== 'skip') return { wantedAlways };
    const rec = await deps.index.readPending(session.owner, chatId, callId);
    // Sin registro no se reenvía: la VM solo exige `spend` para "siempre", y en la ventana del viaje del register la tarjeta sigue viva en ella, así que un allow sin spend ejecutaría la tool de gasto.
    if (!rec) return json(404, { code: 'not-found' });
    // Aprobar una tool de gasto es gastar: pide `spend` (cierra M3 en aprobaciones; `POST /runs` sigue aparte).
    if (decision !== 'skip' && SPEND_TOOLS.has(rec.tool) && !session.scopes.has('spend')) return denied();
    const canRemember = wantedAlways && rec.remember.length > 0;
    // Una tarjeta sin "siempre" (patrón recordable ausente) se decide como allow, igual que en v0 no hay botón.
    if (wantedAlways && !canRemember) b.decision = 'allow';
    const r = await deps.index.decidePending(session.owner, chatId, callId, canRemember || decision === 'skip' ? decision : 'allow');
    if (r === 'decided') return json(409, { code: 'already-decided' });
    return { wantedAlways, decided: true, ...(canRemember ? { saveTool: rec.tool } : {}) };
  }

  /** El cliente recibe `{ ok: true, always?: <bool> }` y nada de lo que conteste la VM; el "siempre" se escribe aquí con el dueño de la sesión. */
  async function finishApproval(route: Route, upstream: Response, owner: string, approval: ApprovalOutcome | undefined, startedAt: number): Promise<Response> {
    await upstream.body?.cancel().catch(() => undefined);
    let saved = false;
    if (approval?.saveTool) {
      try { await deps.index.addAlways(owner, approval.saveTool); saved = true; } catch (e) { reportError(e); }
    }
    return passThrough(route, new Response(JSON.stringify({ ok: true, ...(approval?.wantedAlways ? { always: saved } : {}) }), { status: 200, headers: { 'content-type': 'application/json' } }), startedAt);
  }

  /** GET ${base}/approvals/:callId: la tarjeta pinta esto (una sola fuente con el permiso que se acuña). */
  async function pendingView(owner: string, chatId: string, callId: string): Promise<Response> {
    const rec = await deps.index.readPending(owner, chatId, callId);
    if (!rec) return json(404, { code: 'not-found' });
    const res = json(200, { callId, tool: rec.tool, patterns: rec.patterns, rememberPatterns: rec.remember, input: rec.input, expiresAt: rec.exp, ...(rec.decision ? { decision: rec.decision } : {}) });
    res.headers.set('cache-control', 'private, no-store');
    res.headers.set('x-content-type-options', 'nosniff');
    return res;
  }

  /** `/approvals/always` es del dueño y no de un chat: lo atiende el orquestador sobre el índice global, sin VM. */
  async function alwaysRoute(session: Session, req: Request, url: URL): Promise<Response | undefined> {
    if (url.pathname === '/approvals/always') {
      if (req.method !== 'GET') return json(405, { code: 'method-not-allowed' });
      return session.scopes.has('chat:read') ? json(200, { tools: await deps.index.readAlways(session.owner) }) : denied();
    }
    const m = /^\/approvals\/always\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
    if (!m) return undefined;
    if (req.method !== 'DELETE') return json(405, { code: 'method-not-allowed' });
    if (!session.scopes.has('chat:write')) return denied();
    if (!TOOL_NAME.test(m[1]!)) return json(400, { code: 'bad-tool' });
    await deps.index.removeAlways(session.owner, m[1]!);
    return new Response(null, { status: 204, headers: { 'x-content-type-options': 'nosniff' } });
  }

  /** GET /gw/always: la VM pregunta qué "siempre" tiene el dueño de la corrida. Se autentica con el token de la corrida (el mismo del proxy de
   * Gateway), no con la sesión de una persona; el dueño sale del token. */
  async function vmAlways(req: Request): Promise<Response> {
    const owner = runOwner(req);
    return owner ? json(200, { tools: await deps.index.readAlways(owner) }) : json(401, { code: 'no-session' });
  }

  /** Los slugs de `connectors` del request de la corrida, ya validados; lo que no tiene forma de slug no entra al token. */
  // Mismo criterio que isAgentAppSlug de la VM (connectors.ts): wt y approval son servidores propios del runtime, no apps del dueño.
  const requestedApps = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && APP_SLUG.test(x) && !RESERVED_SERVERS.has(x)))].slice(0, 20) : []);

  /** El dueño y las apps de un token de corrida (typ run, firma y vida); undefined si no sirve. */
  function runClaims(req: Request): { owner: string; chat: string; apps: readonly string[] } | undefined {
    const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const v = bearer ? verifyToken(publicKey, bearer, { typ: 'run', maxTtlMs: MAX_RUN_TTL_MS, now: now() }) : undefined;
    return v?.ok ? { owner: v.claims.owner, chat: v.claims.chat, apps: v.claims.apps ?? [] } : undefined;
  }
  const runOwner = (req: Request): string | undefined => runClaims(req)?.owner;

  // Lo que el CLI necesita para listar y llamar a un MCP; resources/*, prompts/* y demás no pasan.
  const CONNECTOR_METHODS = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list', 'tools/call']);

  // HACK: caché por instancia de 60 s de las tools de solo lectura por (dueño, app): sin ella cada tools/call haría initialize+tools/list al proveedor.
  // Una tool que el proveedor cambie a escritura se sigue aceptando hasta 60 s; subir a un caché compartido o quitarlo si el proveedor cobra por listado.
  const readOnlyCache = new Map<string, { at: number; tools: readonly string[] }>();
  async function readOnlyOf(port: ConnectorsPort, owner: string, slug: string): Promise<readonly string[]> {
    const key = `${owner}\u0000${slug}`;
    const hit = readOnlyCache.get(key);
    if (hit && now() - hit.at < 60_000) return hit.tools;
    const tools = (await port.mcp!(owner, [slug])).readOnlyTools;
    if (readOnlyCache.size >= 500) readOnlyCache.clear();
    readOnlyCache.set(key, { at: now(), tools });
    return tools;
  }

  async function grantCovers(claims: { owner: string; chat: string }, grant: string, callId: string, tool: string, args: unknown): Promise<boolean> {
    const v = verifyToken(publicKey, grant, { typ: 'grant', chat: claims.chat, now: now() });
    if (!v.ok || v.claims.owner !== claims.owner || v.claims.call !== callId || v.claims.tool !== tool || !v.claims.patterns?.includes(`Tool(${tool}:*)`)) return false;
    // Los argumentos que se reenvían son los que la tarjeta registró: el mismo permiso no sirve para otro destinatario u otro recurso.
    if (v.claims.args !== argsHash(args)) return false;
    return deps.index.useGrant(claims.owner, claims.chat, callId, tool);
  }

  /** POST /gw/approvals/{pending,grant}: la VM registra la tarjeta que va a mostrar y, decidida por la persona, recoge el permiso de esa llamada (una vez). Token de corrida. */
  async function vmApprovals(req: Request, id: 'approvals-pending' | 'approvals-grant'): Promise<Response> {
    const claims = runClaims(req);
    if (!claims) return json(401, { code: 'no-session' });
    if (!isJson(req)) return json(415, { code: 'unsupported-media-type' });
    const raw = await readText(req);
    if (raw === 'too-large') return json(413, { code: 'too-large' });
    let body: Record<string, unknown>;
    try { const p: unknown = JSON.parse(raw); if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('forma'); body = p as Record<string, unknown>; } catch { return json(400, { code: 'bad-json' }); }
    const callId = body.callId;
    if (typeof callId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(callId)) return json(400, { code: 'bad-call' });
    const { owner, chat } = claims;
    if (id === 'approvals-grant') {
      if (!rateOk(owner, 'gw-grant', FORWARDS_PER_MINUTE)) return json(429, { code: 'rate-limited' });
      const item = await deps.index.takeGrant(owner, chat, callId);
      if (!item) return json(404, { code: 'no-grant' });
      return json(200, { grant: issueGrant(deps.privateKey, owner, chat, callId, item.tool, item.patterns, item.args, now), tool: item.tool });
    }
    const tool = body.tool;
    if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) return json(400, { code: 'bad-tool' });
    // Los argumentos que la tarjeta muestra y que el permiso cubre quedan en el registro: objeto JSON o nada.
    const input = body.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return json(400, { code: 'bad-input' });
    const spend = SPEND_TOOLS.has(tool);
    // Solo tools que una tarjeta puede pedir: las de gasto y las de una app que esta corrida pidió.
    if (!spend && !claims.apps.includes(TOOL_OF_APP.exec(tool)?.[1] ?? '')) return json(403, { code: 'tool-not-allowed' });
    if (!rateOk(owner, 'gw-pending', FORWARDS_PER_MINUTE)) return json(429, { code: 'rate-limited' });
    try {
      const item = await deps.index.registerPending(owner, chat, callId, tool, spend, APPROVAL_TIMEOUT_MS, input);
      return json(200, { patterns: item.patterns, rememberPatterns: item.remember, expiresAt: item.exp });
    } catch (e) {
      if (e instanceof PendingLimitError) return json(429, { code: 'pending-limit' });
      if (e instanceof PendingInputError) return json(413, { code: 'input-too-large' });
      throw e;
    }
  }

  /** POST /gw/connectors/{mcp,forward/:slug}: la VM del agente usa las apps del dueño del token sin ver la credencial. El token de corrida lo tiene
   * también el agente (mismo uid), así que aquí NO puede pasar una tool que escribe: la tarjeta de aprobación vive en la VM y el orquestador no
   * puede distinguir "la VM reenvía lo aprobado" de "el agente llama directo". Solo tools con readOnlyHint, comprobado aquí contra el puerto. */
  async function vmConnectors(req: Request, path: string): Promise<Response> {
    const claims = runClaims(req);
    if (!claims) return json(401, { code: 'no-session' });
    const owner = claims.owner;
    const port = deps.connectors;
    if (!port?.mcp || !port.forward) return json(501, { code: 'connectors-unavailable' });
    if (req.method !== 'POST') return json(405, { code: 'method-not-allowed' });
    if (!isJson(req)) return json(415, { code: 'unsupported-media-type' });
    const raw = await readText(req);
    if (raw === 'too-large') return json(413, { code: 'too-large' });
    let body: Record<string, unknown>;
    try { const p: unknown = JSON.parse(raw); if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error('forma'); body = p as Record<string, unknown>; } catch { return json(400, { code: 'bad-json' }); }
    if (path === '/gw/connectors/mcp') {
      const slugs = body.slugs;
      if (!Array.isArray(slugs) || slugs.length > 20 || slugs.some((x) => typeof x !== 'string' || !APP_SLUG.test(x))) return json(400, { code: 'bad-app' });
      // Solo las apps que esta corrida pidió: el agente tiene el token, pero no por eso puede leer las demás apps del dueño.
      if ((slugs as string[]).some((x) => !claims.apps.includes(x))) return json(403, { code: 'app-not-requested' });
      if (!rateOk(owner, 'gw-connectors')) return json(429, { code: 'rate-limited' });
      const r = await port.mcp(owner, slugs as string[]);
      const apps = r.apps.filter((a) => (slugs as string[]).includes(a));
      return json(200, { apps, readOnlyTools: r.readOnlyTools.filter((t) => apps.includes(TOOL_OF_APP.exec(t)?.[1] ?? '')).slice(0, 200) });
    }
    const slug = /^\/gw\/connectors\/forward\/([a-z0-9_]{1,100})$/.exec(path)?.[1];
    if (!slug) return json(404, { code: 'not-found' });
    if (!claims.apps.includes(slug)) return json(403, { code: 'app-not-requested' });
    if (!rateOk(owner, 'gw-forward', FORWARDS_PER_MINUTE)) return json(429, { code: 'rate-limited' });
    const msg = body.message as Record<string, unknown> | null | undefined;
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.method !== 'string' || !CONNECTOR_METHODS.has(msg.method)) return json(400, { code: 'bad-message' });
    if (msg.method === 'tools/call') {
      const name = (msg.params as { name?: unknown } | null | undefined)?.name;
      const readOnly = typeof name === 'string' ? await readOnlyOf(port, owner, slug) : undefined;
      const full = `mcp__${slug}__${name as string}`;
      if (!readOnly) return json(403, { code: 'not-read-only' });
      // Una tool que escribe pasa solo con el permiso de ESA llamada que la persona aprobó (spec §8.1); el índice lo consume antes de reenviar.
      if (!readOnly.includes(full)) {
        if (typeof body.grant !== 'string' || typeof body.callId !== 'string') return json(403, { code: 'not-read-only' });
        if (!(await grantCovers(claims, body.grant, body.callId, full, (msg.params as { arguments?: unknown }).arguments))) return json(403, { code: 'bad-grant' });
      }
    }
    const r = await port.forward(owner, slug, msg, typeof body.session === 'string' ? body.session.slice(0, 200) : undefined);
    if (typeof r.status !== 'number' || typeof r.text !== 'string') throw new Error('connectors: respuesta del puerto inválida');
    const reply = JSON.stringify({ status: r.status, text: r.text, ...(typeof r.session === 'string' ? { session: r.session.slice(0, 200) } : {}) });
    // En bytes, como lo mide la VM al leer: recortar en caracteres (UTF-16) dejaba pasar más de lo que la VM acepta, y cortar a la mitad rompería el JSON-RPC.
    if (Buffer.byteLength(reply) > CONNECTOR_REPLY_MAX_BYTES) return json(502, { code: 'too-large' });
    return new Response(reply, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** Solo los tipos de la fila salen hacia el navegador: una VM comprometida no puede servir HTML con scripts bajo el origen de la API. */
  async function passThrough(route: Route, upstream: Response, startedAt: number): Promise<Response> {
    const type = typeOf(upstream);
    const allowed = new Set(['application/json', ...(route.types ?? [])]);
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel().catch(() => undefined); return json(502, { code: 'bad-gateway' }); }
    if (upstream.status !== 204 && !allowed.has(type)) { await upstream.body?.cancel().catch(() => undefined); return json(502, { code: 'bad-gateway' }); }
    const out = new Headers({ 'x-content-type-options': 'nosniff' });
    // Una URL con token no debe viajar en el Referer de lo que la imagen cargue.
    if (route.media) out.set('referrer-policy', 'no-referrer');
    if (type) out.set('content-type', upstream.headers.get('content-type')!);
    // Una VM comprometida no decide el caché: nada de public ni s-maxage (cacheable en el edge). Solo private o no-store.
    const cache = upstream.headers.get('cache-control');
    out.set('cache-control', cache && CACHEABLE.test(cache) ? cache : 'private, no-store');
    if (route.attachment) {
      const disposition = upstream.headers.get('content-disposition');
      out.set('content-disposition', disposition && ATTACHMENT.test(disposition) ? disposition : `attachment; filename="export${EXPORT_EXT[type] ?? ''}"`);
      out.set('content-security-policy', "sandbox; default-src 'none'");
    }
    // La cuenta corre desde que entró la request, no desde que la VM respondió: despertarla también gasta el tiempo de la Function.
    const body = route.stream && deps.streamMaxMs && upstream.body ? cutAfter(upstream.body, Math.max(0, deps.streamMaxMs - (Date.now() - startedAt)), route.stream!) : upstream.body;
    return new Response(body, { status: upstream.status, headers: out });
  }

  return async (req) => {
    try {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/gw/')) {
        // Rutas de la VM (token de corrida): la tabla GW_ROUTES manda; lo que no está es 404 antes de cualquier autenticación.
        const gw = matchGw(req.method, url.pathname);
        if (gw === undefined) return json(404, { code: 'not-found' });
        if (gw === 'method') return json(405, { code: 'method-not-allowed' });
        if (gw.id === 'gateway') return await deps.gateway(req);
        if (gw.id === 'always') return await vmAlways(req);
        if (gw.id === 'approvals-pending' || gw.id === 'approvals-grant') return await vmApprovals(req, gw.id);
        return await vmConnectors(req, url.pathname);
      }
      const media = req.method === 'GET' && !req.headers.has('authorization') && url.searchParams.has('wt_media') ? CHAT.exec(url.pathname) : null;
      if (media) return await mediaGet(req, url, media[1]!, media[2] ?? '');
      const auth = await deps.authenticate(req);
      if (isRejection(auth)) {
        // RFC 6750: un token vencido lleva error="invalid_token"; el builder lo usa para refrescar en vez de mandar a iniciar sesión.
        const res = json(REJECTION_STATUS[auth.code], { code: auth.code, error: REJECTION_TEXT[auth.code] });
        if (auth.code !== 'scope') res.headers.set('www-authenticate', WWW_AUTHENTICATE[auth.code]);
        return res;
      }
      // Cada ruta pide su scope: un token de solo lectura no crea chats y uno de solo chat no ve el gasto.
      const need = (scope: Scope): Response | undefined => (auth.scopes.has(scope) ? undefined : json(REJECTION_STATUS.scope, { code: 'scope', error: REJECTION_TEXT.scope }));
      if (url.pathname === '/chats' && req.method === 'POST') return need('chat:write') ?? await createChat(auth, req);
      if (url.pathname === '/chats' && req.method === 'GET') return need('chat:read') ?? json(200, { chats: await deps.index.listChats(auth.owner) });
      if (url.pathname === '/spend' && req.method === 'GET') return need('spend') ?? await spend(auth);
      // Conectores del dueño, sin chat (spec §3.4); las mismas filas bajo /chats/:id siguen como alias.
      const oc = matchOwnerRoute(req.method, url.pathname);
      if (oc === 'method') return json(405, { code: 'method-not-allowed' });
      if (oc) return oc.route.scopes.every((sc) => auth.scopes.has(sc)) ? (deps.connectors ? await connectorsRoute(oc.route.connector!, auth.owner, req, url) : json(501, { code: 'connectors-unavailable' })) : denied();
      const owned = await alwaysRoute(auth, req, url);
      if (owned) return owned;
      if ((url.pathname === '/models' || url.pathname === '/image-models') && req.method === 'GET') return catalogRoute(url.pathname);
      const m = CHAT.exec(url.pathname);
      if (m) return await chatRoute(auth, req, url, m[1]!, m[2] ?? '');
      return json(404, { code: 'not-found' });
    } catch (e) {
      // El detalle (rutas de Blob, errores de la VM) se queda en el log; al cliente solo le llega que el servicio falló.
      reportError(e);
      return json(502, { code: 'bad-gateway' });
    }
  };
}
