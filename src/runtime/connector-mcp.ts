// Las apps conectadas (Pipedream Connect) llegan al agente como servidores MCP, uno por app y solo los slugs del
// request. El agente nunca ve el token de Pipedream: cada servidor es un proxy stdio local (scripts/connector-mcp-proxy.ts)
// que reenvía el JSON-RPC al transport, y es el transport quien pone las cabeceras y habla con Pipedream. El --mcp-config
// solo lleva la URL del transport y el token de la corrida. Solo lectura por defecto: las tools con `readOnlyHint` pasan
// sin tarjeta en auto y las demás piden aprobación. Contrato del MCP remoto: URL fija + cabeceras x-pd-* (RE de Orq).
import { join } from 'node:path';
import type { ApprovalEndpoint } from './approvals';
import type { ConnectorsConfig } from './connectors';

export const PIPEDREAM_MCP_URL = 'https://remote.mcp.pipedream.net';
export const CONNECTOR_PROXY_SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'connector-mcp-proxy.ts');
const PROTOCOL = '2025-06-18';
const MAX_TOOLS = 200;
// Un nombre con `__` arma el mismo mcp__<app>__<tool> que otra app: no se registra como lectura.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,100}$/;
// El upstream es externo: una respuesta colgada o enorme no puede frenar ni inflar la corrida.
const UPSTREAM_TIMEOUT_MS = 30_000;
export const UPSTREAM_MAX_BYTES = 1 << 20;
/** Tope en bytes de lo que el orquestador devuelve a la VM por `/gw/connectors/*` (el texto del proveedor ya escapado en JSON): los dos lados miden en bytes. */
export const CONNECTOR_REPLY_MAX_BYTES = 2 * UPSTREAM_MAX_BYTES;

export interface ConnectorMcp {
  /** Apps que respondieron a tools/list: cada una es un servidor `mcp__<slug>__*` del agente. */
  apps: string[];
  /** Tools con `readOnlyHint: true` en tools/list, ya con el prefijo del CLI. */
  readOnlyTools: string[];
}

export interface McpStdioServer { command: string; args: string[]; env: Record<string, string> }

/** Cabeceras de Pipedream para un slug. Solo las usa el transport: nunca salen al agente. */
export function pipedreamHeaders(slug: string, cfg: Pick<ConnectorsConfig, 'projectId' | 'environment' | 'externalUserId'>, token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'x-pd-project-id': cfg.projectId, 'x-pd-environment': cfg.environment, 'x-pd-external-user-id': cfg.externalUserId, 'x-pd-app-slug': slug };
}

/** Servidores del --mcp-config para las apps: proxies stdio que apuntan al transport con el token de la corrida. */
export function connectorProxyServers(apps: readonly string[], endpoint: ApprovalEndpoint, script = CONNECTOR_PROXY_SCRIPT): Record<string, McpStdioServer> {
  const origin = new URL(endpoint.url).origin;
  return Object.fromEntries(apps.map((slug) => [slug, { command: 'bun', args: [script], env: { WT_CONNECTOR_URL: `${origin}/connector-mcp/${slug}`, WT_APPROVAL_TOKEN: endpoint.token } }]));
}

/** Cuerpo JSON-RPC de una respuesta Streamable HTTP: JSON directo o el último `data:` de un event-stream. */
export function parseJsonRpc(text: string): { result?: unknown; error?: unknown } | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (t.startsWith('{')) { try { return JSON.parse(t) as { result?: unknown }; } catch { return undefined; } }
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  for (const d of data.reverse()) { try { return JSON.parse(d) as { result?: unknown }; } catch { /* siguiente */ } }
  return undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** El cuerpo como texto, cortando al pasar `max` bytes sin leer el resto. Lo usa también scripts/export-mcp.ts. */
export async function readCapped(r: Response, max: number, what = 'respuesta del conector'): Promise<string> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error(`${what} de más de ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface McpPostResult { status: number; text: string; session?: string }

/** Un POST JSON-RPC al MCP de Pipedream con tope de tiempo y de tamaño, sin seguir redirecciones (las cabeceras x-pd-*
 * no deben viajar a otro host). */
export async function mcpPost(headers: Record<string, string>, body: unknown, session: string | undefined, fetchImpl: typeof fetch = fetch): Promise<McpPostResult> {
  const r = await fetchImpl(PIPEDREAM_MCP_URL, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: r.status, text: await readCapped(r, UPSTREAM_MAX_BYTES), session: r.headers.get('mcp-session-id') ?? session };
}

/** `tools/list` de una app (initialize + list, con mcp-session-id si lo da) y sus tools de solo lectura, con prefijo. */
export async function listReadOnlyTools(name: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const call = async (body: unknown, session?: string) => {
    const r = await mcpPost(headers, body, session, fetchImpl);
    if (r.status < 200 || r.status >= 300) throw new Error(`conector ${name}: el MCP respondió ${r.status}`);
    return { json: parseJsonRpc(r.text), session: r.session };
  };
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'web-transformer', version: '0' } } });
  if (init.json?.error) throw new Error(`conector ${name}: initialize falló`);
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
  const result = isObj(list.json?.result) ? list.json.result : {};
  const tools = Array.isArray(result.tools) ? result.tools.slice(0, MAX_TOOLS) : [];
  return tools.flatMap((t) => (isObj(t) && typeof t.name === 'string' && TOOL_NAME.test(t.name) && !t.name.includes('__') && isObj(t.annotations) && t.annotations.readOnlyHint === true ? [`mcp__${name}__${t.name}`] : []));
}
