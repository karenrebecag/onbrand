// Router HTTP del transport: chequeo de origen, guard de escritura, tabla de rutas y listen. No tiene estado de corridas:
// todo lo que arranca, corta o lee una corrida entra por deps (start, cancel, reads, agentMcp...). Paso 10 de la partición
// de transport.ts (ADR 0014, fila http-router).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentMcp } from './agent-mcp';
import type { ApiHandlers } from './api-handlers';
import type { Approvals } from './approvals';
import type { BrandStore } from './brand-store';
import { CanvasError } from './canvas-store';
import { chatAlias, MEDIA_TTL_MS, mediaPaths, RESERVED_CHAT_ROWS, type ChatAlias } from './chat-alias';
import type { ChatReservations } from './chat-reservations';
import { UpstreamError } from './connectors';
import type { Suggestion } from './events';
import { HttpError, isTrustedRequest, json, MUTATING, readBody, requireNonSimple } from './http';
import { isRejection, localVerifier, providerVerifier, REJECTION_STATUS, REJECTION_TEXT, scopeDenied, WWW_AUTHENTICATE, type Scope, type Session, type SessionVerifier } from './session';
import { loopbackTwins } from './loopback';
import type { PreviewDist } from './preview-dist';
import { hostWsMatcher, startPreviewServer } from './preview-serve';
import type { RunReads } from './run-reads';
import { MESSAGE_ID, type RuntimeOptions } from './shared';
import { UploadError } from './uploads';
import type { VariantRuns } from './variants';

/** Familias de ruta cuyo segundo segmento es un id de chat, mensaje o grupo: `handle` resuelve su dueño antes del handler
 * (spec identidad §5). tests/session-owner.test.ts exige que cada familia que `handle` compara en parts[0] esté en una de las dos
 * listas: una ruta nueva con :id sin ownerOf no pasa la guarda. */
export const ID_FAMILIES = ['chats', 'runs', 'variants'] as const;
/** Sin id de chat: catálogos, marcas del proceso, callbacks con token de corrida, "siempre" (fase 3) y uploads sin chat. */
export const NO_ID_FAMILIES = ['models', 'image-models', 'brands', 'uploads', 'transcribe', 'prompt-enhancements', 'connectors', 'approval-requests', 'mcp', 'connector-mcp', 'approvals', 'preview'] as const;

/** El scope que pide una ruta (spec §3, §7), todos a la vez: leer es chat:read (también el latido, que solo consulta),
 * escribir chat:write, las marcas brand:write, y lo que gasta (enhancer, transcripción, sugerencias de sección) suma spend.
 * POST /runs con imágenes pide spend en RunCycle.start, donde está el cuerpo. Un solo punto, para que una ruta nueva no
 * quede sin scope. */
function scopeFor(method: string | undefined, parts: readonly string[]): readonly Scope[] {
  if (method === 'GET' || method === 'HEAD') return ['chat:read'];
  // Pedir URLs de imagen solo lee (spec orquestador-enrutamiento §4), aunque sea POST.
  if (parts[0] === 'chats' && parts[2] === 'media-urls') return ['chat:read'];
  if (parts[0] === 'preview' && parts[1] === 'heartbeat') return ['chat:read'];
  if (parts[0] === 'brands') return ['brand:write'];
  if (parts[0] === 'prompt-enhancements' || parts[0] === 'transcribe' || (parts[0] === 'runs' && parts[2] === 'sections' && parts[4] === 'suggestions')) return ['chat:write', 'spend'];
  return ['chat:write'];
}

/** Token de gasto de la corrida que el orquestador manda en el reenvío de POST /runs (deploy-sandbox.md §1). Solo caracteres de
 * header imprimibles y acotado: va al entorno del CLI; lo que no cumple se ignora y la corrida usa el token de la VM. */
function runTokenOf(req: IncomingMessage): string | undefined {
  const v = req.headers['x-wt-run-token'];
  return typeof v === 'string' && v.length <= 4096 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
}

/** Las rutas con sesión la reciben de `authenticate`; solo callbacks y catálogos van sin ella y no llegan a los handlers
 * que la piden. Si algún día llegaran, cierra en vez de actuar sin dueño. */
function requireSession(session: Session | undefined): Session {
  if (!session) throw new HttpError(401, 'inicia sesión', { code: 'no-session' });
  return session;
}

export interface ChatListItem { chatId: string; owner: string; title: string; updatedAt: number }

export interface HttpRouterDeps {
  opts: Pick<RuntimeOptions, 'trust' | 'session' | 'models' | 'transcribe' | 'imageModels' | 'previewPort' | 'previews' | 'builderOrigin'>;
  /** El puerto real de la API: lo fija listen() y lo lee el transport para armar la ruta de aprobación. */
  port: () => number | undefined;
  setPort: (port: number) => void;
  brands: BrandStore;
  api: ApiHandlers;
  variants: VariantRuns;
  agentMcp: AgentMcp;
  approvals: Approvals;
  reads: RunReads;
  previewDist: PreviewDist;
  handleBrandInstructions: (req: IncomingMessage, raw: string, owner: string) => Promise<{ instructions: string[] }>;
  handleBrandMemory: (req: IncomingMessage, raw: string, owner: string) => Promise<{ text: string }>;
  putPlan: (req: IncomingMessage, chat: string, id: string) => Promise<unknown>;
  start: (body: unknown, session: Session, runToken?: string) => Promise<unknown>;
  cancel: (id: string) => { messageId: string };
  sectionSuggestions: (id: string, slug: string) => Promise<Suggestion[]>;
  /** POST /chats local: ids apartados hasta la primera corrida (chat-reservations.ts). */
  reservations: ChatReservations;
  /** El chat (ws) de un mensaje, o undefined si no existe. */
  chatOf: (messageId: string) => string | undefined;
  /** ¿El mensaje es de ese chat? Una variante es un chat propio (ws = su id) y además del chat de su fuente (run-reads thread). */
  inChat: (messageId: string, chatId: string) => boolean;
  /** ¿El grupo de variantes salió de ese chat? */
  groupInChat: (groupId: string, chatId: string) => boolean;
  /** Chats con corridas de la sesión (raíces; las variantes cuelgan del chat de su fuente), con la forma de GET /chats. */
  ownChats: (session: Session) => ChatListItem[];
}

export class HttpRouter {
  /** El segundo http.Server de la url estable (R5.1), en previewPort; se cierra con el de la API. */
  // El listener del preview es de node:net (preview-serve hace su propio HTTP), no un http.Server.
  private previewServer?: import('node:net').Server;

  /** Sin verifier del perfil, el local (loopback). El del perfil nunca puede ser 'local' ni vacío (providerVerifier). */
  private readonly verifier: SessionVerifier;

  constructor(private deps: HttpRouterDeps) {
    this.verifier = deps.opts.session ? providerVerifier(deps.opts.session) : localVerifier;
    // El secreto de origen prueba que la request pasó por el rewrite del builder, no quién es la persona: sin verifier del
    // perfil un deploy quedaría con una sola credencial compartida, así que no arranca (spec identidad §3).
    if (deps.opts.trust && !deps.opts.session) throw new Error('trust (WT_ORIGIN_SECRET) exige un SessionVerifier en opts.session: sin identidad el deploy no arranca');
  }

  /** El latido pide el estado de varios ws a la vez: uno ajeno sale idéntico a uno inexistente (absent, sin versión, sin
   * token), así el latido no confirma que el ws de otra persona existe ni en qué estado está (spec §5). */
  private heartbeat(session: Session, body: unknown): ReturnType<PreviewDist['heartbeat']> {
    const asked = (body as { visible?: unknown } | null)?.visible;
    const visible = Array.isArray(asked) ? asked.filter((ws): ws is string => typeof ws === 'string') : [];
    const foreign = visible.filter((ws) => this.deps.reads.denies(session, ws));
    const out = this.deps.previewDist.heartbeat({ ...(body as object), visible: visible.filter((ws) => !foreign.includes(ws)) }, session.owner);
    for (const ws of foreign) out.states[ws] = { status: 'absent', version: null, url: this.deps.previewDist.stableUrl(ws) };
    return out;
  }

  /** Spec identidad §4: un solo punto. Los callbacks del CLI llevan el token de la corrida y los catálogos de modelos no
   * exponen datos de nadie: no pasan por el verifier. Lo demás, sin sesión válida, se rechaza antes de leer el body. */
  private async authenticate(req: IncomingMessage, res: ServerResponse, parts: string[], callback: boolean): Promise<Session | undefined> {
    const catalog = req.method === 'GET' && parts.length === 1 && (parts[0] === 'models' || parts[0] === 'image-models');
    if (callback || catalog) return undefined;
    let out: Awaited<ReturnType<SessionVerifier['verify']>>;
    try {
      out = await this.verifier.verify(req.headers);
    } catch (e) {
      // El adaptador del perfil (SDK del proveedor) puede lanzar: falla cerrado y su mensaje no sale al cliente.
      console.error(`[session] verify falló: ${e instanceof Error ? e.message : String(e)}`);
      out = { code: 'no-session' };
    }
    if (!isRejection(out)) return out;
    req.resume();
    if (out.code !== 'scope') res.setHeader('www-authenticate', WWW_AUTHENTICATE[out.code]);
    // Status y texto fijos por code (spec §7): el verifier solo dice el motivo.
    throw new HttpError(REJECTION_STATUS[out.code], REJECTION_TEXT[out.code], { code: out.code });
  }

  /** Una escritura que no es del CLI: content-type no simple (requireNonSimple) y, si el navegador manda Origin, el del
   * builder o el del propio transport. Con eso una página generada no escribe aunque su origen sea loopback (Arq; Lovable
   * fija allow-origin a su app y toda escritura de Lovable y v0 es JSON, zap-api-origen.md). El proxy de vite conserva el
   * Origin del navegador, así que el builder llega con el suyo. */
  private guardWrite(req: IncomingMessage, parts: string[]): void {
    if (!MUTATING.has(req.method ?? '')) return;
    const origin = req.headers.origin;
    const own = this.deps.port() === undefined ? [] : [`http://127.0.0.1:${this.deps.port()}`, `http://localhost:${this.deps.port()}`];
    // localhost y 127.0.0.1 del builder son el mismo host: se aceptan las dos formas del MISMO origen, no otros.
    const builder = this.deps.opts.builderOrigin ? loopbackTwins(this.deps.opts.builderOrigin) : [];
    if (origin !== undefined && !builder.includes(origin) && !own.includes(origin)) {
      req.resume();
      throw new HttpError(403, 'origen no permitido para escribir');
    }
    requireNonSimple(req, parts);
  }

  /** Base por chat: la raíz del chat es de la sesión y cada :m o :g de la ruta es de ESE chat. Si no, 404 como el orquestador,
   * donde otro chat del mismo dueño vive en otra VM. Un chat solo reservado pasa únicamente hacia POST /runs (startAliased). */
  private checkAlias(session: Session, alias: ChatAlias): void {
    const id = alias.chatId;
    const missing = new HttpError(404, `no hay chat ${id}`);
    const firstRun = alias.kind === 'route' && alias.parts.length === 1 && alias.parts[0] === 'runs';
    const ownerState = alias.kind === 'route' && RESERVED_CHAT_ROWS.has(alias.row);
    if (this.deps.chatOf(id) !== id || !this.deps.reads.visible(session, id)) {
      // Antes de leer el cuerpo: un id ajeno o desconocido es 404 aunque el cuerpo sea inválido (no confirma que existe).
      if ((firstRun || ownerState) && this.deps.chatOf(id) === undefined && this.deps.reservations.owns(session.owner, id)) return;
      throw missing;
    }
    const [family, sub] = alias.kind === 'route' ? alias.parts : [];
    if (family === 'runs' && sub !== undefined && !this.deps.inChat(sub, id)) throw missing;
    if (family === 'variants' && sub !== undefined && !this.deps.groupInChat(sub, id)) throw missing;
  }

  /** POST /chats/:id/runs: en un chat que existe, el padre es de ese chat; en uno reservado, solo la primera corrida
   * (messageId = chatId, sin padre) y solo de quien lo reservó. La reserva se consume en el mismo tick que se comprueba. */
  private async startAliased(req: IncomingMessage, session: Session, chatId: string): Promise<unknown> {
    const body = await readBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as { messageId?: unknown; parentId?: unknown; restoreFrom?: unknown; variants?: { sourceId?: unknown } };
    const missing = new HttpError(404, `no hay chat ${chatId}`);
    // Los mismos ids de los que cuelga cada rama de RunCycle.start (assertOwns): todos del chat, o en producción no existirían.
    const ids = [b.parentId, b.restoreFrom, b.variants?.sourceId].filter((v) => v !== undefined);
    if (this.deps.chatOf(chatId) === chatId) {
      if (!ids.length || !ids.every((v) => typeof v === 'string' && this.deps.inChat(v, chatId))) throw missing;
      return this.deps.start(body, session, runTokenOf(req));
    }
    if (b.messageId !== chatId || ids.length) throw missing;
    const reservation = this.deps.reservations.consume(session.owner, chatId);
    if (!reservation) throw missing;
    try {
      return await this.deps.start(body, session, runTokenOf(req));
    } catch (e) {
      this.deps.reservations.restore(reservation);
      throw e;
    }
  }

  /** POST y GET /chats en local: reservar un id y listar las reservas del dueño, con la forma del orquestador. */
  private async chats(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    if (req.method === 'GET') {
      // Como el orquestador (chat-index listChats): todos los chats del dueño, el más reciente primero; aquí además los reservados.
      const reserved = this.deps.reservations.list(session.owner).map((r) => ({ chatId: r.chatId, owner: r.owner, title: r.title, updatedAt: r.createdAt }));
      return json(res, 200, { chats: [...reserved, ...this.deps.ownChats(session)].sort((a, b) => b.updatedAt - a.updatedAt) });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'método no permitido');
    const body = await readBody(req);
    const title = (body as { title?: unknown } | null)?.title;
    const out = this.deps.reservations.reserve(session.owner, typeof title === 'string' ? title : '');
    if (!out.ok) return json(res, out.code === 'rate-limited' ? 429 : 409, { code: out.code });
    return json(res, 201, { chatId: out.chatId });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // La base por chat se traduce ANTES de autenticar: el scope y el dueño salen de la ruta VM, como en la VM real.
      const alias = chatAlias(req.method ?? 'GET', url.pathname.split('/').filter(Boolean));
      const parts = alias?.kind === 'route' ? alias.parts : url.pathname.split('/').filter(Boolean);
      // Un segmento con `%` malformado hace URIError en decodeURIComponent → 500; aquí sale como 400 (ruta inválida).
      const seg = (i: number): string => { try { return decodeURIComponent(parts[i] as string); } catch { throw new HttpError(400, 'ruta inválida'); } };
      // Las llamadas del CLI al propio transport no pasan por el rewrite ni llevan su secreto; las dos rutas exigen el
      // token de la corrida (approvalRequest, connectorForward, workspaceMcp).
      const callback = (req.method === 'POST' && (parts[0] === 'approval-requests' || parts[0] === 'connector-mcp')) || (parts[0] === 'mcp' && parts.length === 2);
      if (!(this.deps.opts.trust && callback) && !isTrustedRequest(req.headers, this.deps.opts.trust)) throw new HttpError(403, 'origen no permitido');
      // La sesión viaja a los handlers como argumento (spec §4.4). authenticate devuelve undefined solo en callbacks y
      // en el catálogo (/models); en el resto lanza el rechazo o devuelve una Session, así que aquí está definida.
      const session = await this.authenticate(req, res, parts, callback);
      if (!callback) this.guardWrite(req, parts);
      if (session) {
        // El dueño antes que el scope (spec §5): un chat ajeno o inexistente es 404 con el texto del handler, así un 403 no
        // confirma que el id existe.
        // Un id con forma de messageId que no es de la sesión o no existe es 404; uno que no puede existir (`..%2Fx`) lo valida el
        // handler con su 400, que no confirma nada.
        // Los handlers de /runs decodifican todos sus segmentos: un % malformado sigue siendo 400 aunque el id no exista.
        if (parts[0] === 'runs') for (let i = 1; i < parts.length; i++) seg(i);
        if (parts.length >= 2 && (parts[0] === 'chats' || parts[0] === 'runs') && MESSAGE_ID.test(seg(1)) && !this.deps.reads.visible(session, seg(1))) throw new HttpError(404, `no hay mensaje ${seg(1)}`);
        if (parts.length >= 2 && parts[0] === 'variants' && !this.deps.reads.visibleGroup(session, seg(1))) throw new HttpError(404, `no hay grupo de variantes ${seg(1)}`);
        if (alias) this.checkAlias(session, alias);
        if (!scopeFor(req.method, parts).every((scope) => session.scopes.has(scope))) throw scopeDenied();
      }
      if (parts.length === 1 && parts[0] === 'chats') return await this.chats(req, res, requireSession(session));
      if (alias?.kind === 'media-urls') {
        let paths: string[];
        try { paths = mediaPaths(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e instanceof Error ? e.message : String(e)); }
        // Sin firma: en local el <img> llega por loopback sin Bearer. Con un verifier jwt (QA) esas imágenes darían 401.
        return json(res, 200, { urls: Object.fromEntries(paths.map((p) => [p, p])), expiresAt: Date.now() + MEDIA_TTL_MS });
      }
      if (parts[0] === 'models' && parts.length === 1 && req.method === 'GET') return json(res, 200, { models: this.deps.opts.models ?? [], capabilities: { transcribe: !!this.deps.opts.transcribe } });
      if (parts[0] === 'image-models' && parts.length === 1 && req.method === 'GET') return json(res, 200, { models: this.deps.opts.imageModels ?? [] });
      if (parts[0] === 'brands' && parts.length === 3 && parts[2] === 'instructions') return json(res, 200, await this.deps.handleBrandInstructions(req, parts[1] as string, requireSession(session).owner));
      if (parts[0] === 'brands' && parts.length === 3 && parts[2] === 'memory') return json(res, 200, await this.deps.handleBrandMemory(req, parts[1] as string, requireSession(session).owner));
      if (parts[0] === 'brands' && parts.length === 1 && req.method === 'GET') return json(res, 200, await this.deps.brands.list());
      if (parts[0] === 'uploads') return await this.deps.api.uploads(req, res, parts);
      if (parts[0] === 'transcribe' && parts.length === 1 && req.method === 'POST') return await this.deps.api.transcribe(req, res);
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'prompt-enhancements') return await this.deps.api.enhancePrompt(req, res);
      if (req.method === 'POST' && parts.length === 3 && parts[0] === 'variants' && parts[2] === 'cancel') return json(res, 202, this.deps.variants.cancel(seg(1)));
      if (parts[0] === 'connectors') return await this.deps.api.connectors(req, res, parts, url);
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'approval-requests') return json(res, 200, await this.deps.agentMcp.approvalRequest(req));
      if (parts.length === 2 && parts[0] === 'mcp') {
        let id: string;
        try { id = decodeURIComponent(parts[1]); } catch { throw new HttpError(400, 'id inválido'); }
        const out = await this.deps.agentMcp.workspaceMcp(req, id);
        if (out === undefined) { res.writeHead(202).end(); return; }
        return json(res, 200, out);
      }
      if (req.method === 'POST' && parts.length === 2 && parts[0] === 'connector-mcp') {
        let slug: string;
        try { slug = decodeURIComponent(parts[1]); } catch { throw new HttpError(400, 'slug inválido'); }
        const out = await this.deps.agentMcp.connectorForward(req, slug);
        if (out === undefined) { res.writeHead(202).end(); return; }
        return json(res, 200, out);
      }
      // §8: el "siempre" es por (dueño, tool); cada quien ve y revoca solo el suyo. El dueño sale de la sesión, no de la
      // request. En loopback/core la sesión es 'local' y el comportamiento no cambia.
      if (parts[0] === 'approvals' && parts[1] === 'always') {
        // Estas rutas no son callback ni catálogo, así que authenticate ya devolvió una Session o lanzó. Guard duro en vez
        // de un fallback silencioso: si algún día se ampliara callback/catalog, falla cerrado en vez de servir a 'local'.
        if (!session) throw new HttpError(401, REJECTION_TEXT['no-session'], { code: 'no-session' });
        if (parts.length === 2 && req.method === 'GET') return json(res, 200, { tools: this.deps.approvals.alwaysTools(session.owner) });
        if (parts.length === 3 && req.method === 'DELETE') {
          if (!this.deps.approvals.revokeAlways(seg(2), session.owner)) throw new HttpError(400, 'solo se revoca el "siempre" de una tool de gasto');
          res.writeHead(204);
          return void res.end();
        }
      }
      if (req.method === 'POST' && parts.length === 4 && parts[0] === 'chats' && parts[2] === 'approvals') return json(res, 200, await this.deps.agentMcp.approvalDecision(req, seg(1), seg(3), requireSession(session).scopes));
      // GET de la tarjeta: una sola fuente para el builder (misma forma que el orquestador, routes.ts pendingView), también
      // en local. agentMcp ubica el callId entre los ws del chat; 404 si no está, es de otro chat o venció. No se cachea.
      if (req.method === 'GET' && parts.length === 4 && parts[0] === 'chats' && parts[2] === 'approvals' && parts[3] !== 'always') {
        requireSession(session);
        const card = this.deps.agentMcp.approvalCard(seg(1), seg(3));
        res.setHeader('cache-control', 'private, no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        return json(res, 200, card);
      }
      if (req.method === 'PUT' && parts.length === 4 && parts[0] === 'chats' && parts[2] === 'plans') return json(res, 200, await this.deps.putPlan(req, seg(1), seg(3)));
      if (req.method === 'GET' && parts.length === 4 && parts[0] === 'chats' && parts[2] === 'plans') return json(res, 200, this.deps.agentMcp.getPlan(seg(1), seg(3)));
      if (parts[0] === 'chats' && parts[2] === 'canvas') return await this.deps.api.canvas(req, res, parts, url);
      if (req.method === 'GET' && parts.length === 2 && parts[0] === 'chats') return json(res, 200, await this.deps.reads.thread(seg(1)));
      // Latido del builder (R5.2): los ws visibles. Vive en la API (lo llama el builder), no en el listener de previews.
      if (req.method === 'POST' && parts.length === 2 && parts[0] === 'preview' && parts[1] === 'heartbeat' && this.deps.opts.previewPort !== undefined) return json(res, 200, this.heartbeat(requireSession(session), await readBody(req)));
      if (parts[0] !== 'runs') throw new HttpError(404, 'ruta desconocida');
      if (req.method === 'POST' && parts.length === 1) return json(res, 202, alias ? await this.startAliased(req, requireSession(session), alias.chatId) : await this.deps.start(await readBody(req), requireSession(session), runTokenOf(req)));
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cancel') return json(res, 202, this.deps.cancel(seg(1)));
      if (req.method === 'POST' && parts.length === 3 && parts[2] === 'publish') return json(res, 200, await this.deps.reads.publishRun(seg(1)));
      if (req.method === 'POST' && parts.length === 5 && parts[2] === 'sections' && parts[4] === 'suggestions') return json(res, 200, { suggestions: await this.deps.sectionSuggestions(seg(1), seg(3)) });
      if (req.method !== 'GET' || parts.length < 2) throw new HttpError(405, 'método no permitido');
      const id = seg(1);
      if (parts.length === 2) return json(res, 200, this.deps.reads.snapshot(id));
      if (parts[2] === 'events' && parts.length === 3) {
        const raw = url.searchParams.get('cursor');
        const cursor = raw === null ? -1 : Number(raw);
        if (!Number.isInteger(cursor) || cursor < -1) throw new HttpError(400, 'cursor debe ser un entero >= -1');
        return await this.deps.reads.stream(id, cursor, req, res);
      }
      if (parts[2] === 'publishable' && parts.length === 3) return json(res, 200, await this.deps.reads.publishable(id));
      if (parts[2] === 'files' && parts.length === 3) return json(res, 200, this.deps.reads.files(id));
      if (parts[2] === 'tree' && parts.length === 3) return json(res, 200, this.deps.reads.tree(id));
      if (parts[2] === 'file' && parts.length === 3) return json(res, 200, this.deps.reads.readFile(id, url.searchParams.get('path') ?? ''));
      if (parts[2] === 'diff' && parts.length === 3) return json(res, 200, this.deps.reads.diff(id));
      if (parts[2] === 'versions' && parts.length === 3) return json(res, 200, this.deps.reads.versions(id));
      if (parts[2] === 'shots' && parts.length === 4) return this.deps.reads.shot(res, id, seg(3));
      if (parts[2] === 'export' && parts.length === 3) return await this.deps.reads.exportVersion(res, id, url.searchParams.get('format'));
      throw new HttpError(404, 'ruta desconocida');
    } catch (e) {
      if (res.headersSent) return void res.end();
      // Un fallo de Pipedream es del upstream, no nuestro: 502 con solo su status.
      const status = e instanceof HttpError || e instanceof UploadError || e instanceof CanvasError ? e.status : e instanceof UpstreamError ? 502 : 500;
      json(res, status, { error: e instanceof Error ? e.message : String(e), ...(e instanceof CanvasError && e.current ? { current: e.current } : {}), ...(e instanceof HttpError && e.details ? e.details : {}) });
    }
  }

  listen(port: number, host = '127.0.0.1'): Server {
    // Loopback por defecto: el transport escribe archivos y arranca procesos en la máquina. Otro host solo en un Sandbox,
    // donde lo que entra pasa por isTrustedRequest con el secreto del rewrite.
    const server = createServer((req, res) => void this.handle(req, res));
    // La permission-prompt-tool vuelve a este mismo proceso: con puerto 0 el real se sabe al escuchar.
    server.on('listening', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') this.deps.setPort(addr.port);
      // La cola que dejó el proceso anterior se reanuda recién aquí: sin puerto, openApprovals no arma la ruta de
      // aprobación y la variante correría sin las tools de imagen ni los conectores (Arq, verificación de R3).
      // Como en release(): un throw aquí sería un uncaughtException y el server de todos los chats haría stop(1).
      try {
        this.deps.variants.pumpVariants();
      } catch (e) {
        console.error(`[transport] cola de variantes al escuchar: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    // Listener de la url estable en su propio puerto, cross-origin a la API y al builder (R5.1). Sirve solo /preview/<ws>/;
    // nunca una ruta de la API, así la página generada no puede fetch /runs ni /approvals same-origin.
    if (this.deps.opts.previews && this.deps.opts.previewPort !== undefined) {
      // El matcher del listener se arma con el MISMO host:port que stableUrl (R5.5 opción b): `<ws>.<host de previewOrigin>`.
      // previewOriginBase valida al arrancar que el host no sea una IP (si lo fuera, stableUrl daría la misma url para todo
      // ws y el listener respondería 421 siempre).
      const base = this.deps.previewDist.originBase();
      this.previewServer = startPreviewServer(this.deps.opts.previews, this.deps.previewDist.resolve(), this.deps.opts.previewPort, host, hostWsMatcher(base.host), this.deps.opts.builderOrigin ? loopbackTwins(this.deps.opts.builderOrigin) : undefined, this.deps.previewDist.gate());
      server.on('close', () => this.previewServer?.close());
    }
    return server.listen(port, host);
  }
}
