// Conectores del builder sobre Pipedream Connect. Port de la implementación de referencia
// companion-apps/lib/pipedream.mjs (verificada en vivo 2026-09): token de proyecto por client
// credentials, catálogo, Connect Link, cuentas y baja. Las credenciales nunca salen de aquí: el
// navegador solo ve slugs, nombres y la URL de conexión.

import { listReadOnlyTools, mcpPost, pipedreamHeaders, type ConnectorMcp, type McpPostResult } from './connector-mcp';

const API = 'https://api.pipedream.com';
// El catálogo sirve los íconos desde assets.pipedream.net; otro origen no se reenvía al navegador.
const ICON_ORIGIN = 'https://assets.pipedream.net';
const TOKEN_MARGIN_MS = 60_000;
const MAX_PAGE = 50;
// Sin `_` al inicio, al final ni doble (la misma regla del orquestador): `mcp__<slug>__<tool>` se lee de una sola forma.
export const APP_SLUG = /^(?=.{1,100}$)[a-z0-9]+(?:_[a-z0-9]+)*$/;
// Nombres que ya usa el --mcp-config del agente: una app con ese slug reemplazaría al servidor del browser (cuyas tools no
// pasan por aprobación). `__` es el separador de mcp__<app>__<tool>: con él, una app podría hacerse pasar por otra.
const RESERVED_SERVERS = new Set(['wt', 'approval']);
export const isAgentAppSlug = (s: string): boolean => APP_SLUG.test(s) && !s.includes('__') && !RESERVED_SERVERS.has(s);
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface ConnectorsConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  /** Dueño de las cuentas en Pipedream. En local, uno fijo; en el deploy, el usuario logueado. */
  externalUserId: string;
}

export interface ConnectorApp {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
}

export interface ConnectorAccount {
  id: string;
  app: string;
  name: string | null;
  state: 'connected' | 'reconnect';
}

export class UpstreamError extends Error {
  constructor(readonly status: number) {
    // El cuerpo de Pipedream puede traer detalles de la petición: solo viaja el status.
    super(`pipedream respondió ${status}`);
  }
}

function safeIcon(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  try {
    const url = new URL(src);
    return url.origin === ICON_ORIGIN ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Lo que una corrida usa de los conectores: las tools de las apps pedidas y el reenvío de un mensaje JSON-RPC. `runToken` solo lo usa la versión remota. */
export interface ConnectorsRun {
  mcp(slugs: readonly string[], runToken?: string): Promise<ConnectorMcp & { failed: string[] }>;
  forward(slug: string, body: unknown, session?: string, runToken?: string, proof?: { callId: string; grant: string }): Promise<McpPostResult>;
}

export class Connectors implements ConnectorsRun {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private config: ConnectorsConfig, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    const r = await this.fetchImpl(`${API}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    });
    if (!r.ok) throw new UpstreamError(r.status);
    const body = (await r.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new UpstreamError(502);
    const lifetime = Math.max(Number(body.expires_in ?? 0) * 1000 - TOKEN_MARGIN_MS, 0);
    this.token = { value: body.access_token, expiresAt: this.now() + lifetime };
    return this.token.value;
  }

  private async request(path: string, opts: { method?: string; query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== '') url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, 'x-pd-environment': this.config.environment };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const r = await this.fetchImpl(url.toString(), { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    if (!r.ok) throw new UpstreamError(r.status);
    return r.status === 204 ? null : r.json();
  }

  /** Las apps pedidas que responden a tools/list y sus tools de solo lectura. Una app cuyo MCP no responde no tumba la
   * corrida: queda fuera y el paso lo dice. El token no sale de aquí: lo usa `forward`. */
  async mcp(slugs: readonly string[]): Promise<ConnectorMcp & { failed: string[] }> {
    const token = await this.accessToken();
    const readOnlyTools: string[] = [];
    const failed: string[] = [];
    const listed = await Promise.all(slugs.map(async (slug) => {
      try { return { slug, tools: await listReadOnlyTools(slug, pipedreamHeaders(slug, this.config, token), this.fetchImpl) }; } catch { return { slug, tools: null }; }
    }));
    for (const { slug, tools } of listed) {
      if (tools) readOnlyTools.push(...tools);
      else failed.push(slug);
    }
    return { apps: slugs.filter((s) => !failed.includes(s)), readOnlyTools, failed };
  }

  /** Reenvía un mensaje JSON-RPC del proxy del agente al MCP de Pipedream de esa app, con las cabeceras del proyecto. */
  async forward(slug: string, body: unknown, session?: string): Promise<McpPostResult> {
    return mcpPost(pipedreamHeaders(slug, this.config, await this.accessToken()), body, session, this.fetchImpl);
  }

  /** Catálogo con lo destacado primero y solo apps con acciones: una app que no hace nada no vale conectarla. */
  async apps(q = '', after = '', limit = 20): Promise<{ apps: ConnectorApp[]; total: number; next: string | null }> {
    const body = (await this.request('/v1/connect/apps', {
      query: { q, after, limit: String(Math.min(Math.max(limit, 1), MAX_PAGE)), sort_key: 'featured_weight', sort_direction: 'desc', has_actions: 'true' },
    })) as { data?: Record<string, unknown>[]; page_info?: { total_count?: unknown; end_cursor?: unknown } } | null;
    const data = Array.isArray(body?.data) ? body.data : [];
    return {
      apps: data.map((a) => ({ slug: String(a.name_slug ?? ''), name: String(a.name ?? ''), description: typeof a.description === 'string' ? a.description : null, icon: safeIcon(a.img_src) })),
      total: Number(body?.page_info?.total_count ?? data.length),
      next: typeof body?.page_info?.end_cursor === 'string' ? body.page_info.end_cursor : null,
    };
  }

  async connect(app: string): Promise<{ url: string; expiresAt: string | null }> {
    const body = (await this.request(`/v1/connect/${this.config.projectId}/tokens`, { method: 'POST', body: { external_user_id: this.config.externalUserId } })) as { connect_link_url?: unknown; expires_at?: unknown };
    // Sin URL la respuesta de Pipedream no sirve: es un fallo del upstream, no un 500 nuestro.
    if (typeof body?.connect_link_url !== 'string') throw new UpstreamError(502);
    const url = new URL(body.connect_link_url);
    url.searchParams.set('app', app);
    return { url: url.toString(), expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null };
  }

  async accounts(): Promise<ConnectorAccount[]> {
    const user = encodeURIComponent(this.config.externalUserId);
    let body: unknown;
    try {
      body = await this.request(`/v1/connect/${this.config.projectId}/users/${user}/accounts`);
    } catch (e) {
      // Pipedream no conoce al usuario hasta su primera cuenta: 404 = ninguna todavía.
      if (e instanceof UpstreamError && e.status === 404) return [];
      throw e;
    }
    const data = (Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : []) as Record<string, unknown>[];
    return data.map((a) => {
      const ok = Boolean(a.healthy) && !a.dead;
      return { id: String(a.id), app: String((a.app as { name_slug?: unknown })?.name_slug ?? ''), name: ok && typeof a.name === 'string' ? a.name : null, state: ok ? 'connected' : 'reconnect' };
    });
  }

  /** Solo borra una cuenta de este usuario: el id solo no prueba que sea suya. */
  async disconnect(id: string): Promise<boolean> {
    if (!ACCOUNT_ID.test(id)) return false;
    if (!(await this.accounts()).some((a) => a.id === id)) return false;
    await this.request(`/v1/connect/${this.config.projectId}/accounts/${id}`, { method: 'DELETE' });
    return true;
  }
}

/** Config desde el entorno, o undefined si falta algo: sin credenciales los endpoints dan 404 y el
 * builder muestra "no conectado". */
export function connectorsFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectorsConfig | undefined {
  const { PIPEDREAM_CLIENT_ID: clientId, PIPEDREAM_CLIENT_SECRET: clientSecret, PIPEDREAM_PROJECT_ID: projectId, PIPEDREAM_ENVIRONMENT: environment } = env;
  if (!clientId || !clientSecret || !projectId || !environment) return undefined;
  return { clientId, clientSecret, projectId, environment, externalUserId: env.WT_CONNECT_USER || 'local' };
}
