// Conectores desde la VM (spec §8): la credencial de Pipedream vive en el orquestador. La VM le pide, con el token de la corrida, la lista de
// tools de las apps y el reenvío de cada mensaje JSON-RPC; el dueño sale del token. Cualquier fallo es una app sin respuesta, nunca una credencial local.

import { CONNECTOR_REPLY_MAX_BYTES, readCapped, UPSTREAM_MAX_BYTES, type ConnectorMcp, type McpPostResult } from './connector-mcp';
import type { ConnectorsRun } from './connectors';
import { orchestratorBase, orchestratorFetch } from './orchestrator-link';

type Env = Readonly<Record<string, string | undefined>>;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** undefined cuando no hay orquestador (core local: manda `connectors` con la credencial local, o nada). */
export function connectorsRemote(env: Env, fetcher: typeof fetch = fetch): ConnectorsRun | undefined {
  if (!orchestratorBase(env)) return undefined;
  return {
    async mcp(slugs: readonly string[], runToken?: string): Promise<ConnectorMcp & { failed: string[] }> {
      try {
        const res = await orchestratorFetch(env, runToken, '/connectors/mcp', { method: 'POST', body: { slugs } }, fetcher);
        if (!res.ok) throw new Error(String(res.status));
        const body = JSON.parse(await readCapped(res, UPSTREAM_MAX_BYTES)) as { apps?: unknown; readOnlyTools?: unknown };
        const apps = strings(body.apps).filter((s) => slugs.includes(s));
        return { apps, readOnlyTools: strings(body.readOnlyTools), failed: slugs.filter((s) => !apps.includes(s)) };
      } catch {
        return { apps: [], readOnlyTools: [], failed: [...slugs] };
      }
    },
    async forward(slug: string, body: unknown, session?: string, runToken?: string, proof?: { callId: string; grant: string }): Promise<McpPostResult> {
      const res = await orchestratorFetch(env, runToken, `/connectors/forward/${encodeURIComponent(slug)}`, { method: 'POST', body: { message: body, ...(session ? { session } : {}), ...(proof ? { callId: proof.callId, grant: proof.grant } : {}) } }, fetcher);
      if (!res.ok) throw new Error(`el orquestador respondió ${res.status}`);
      const out = JSON.parse(await readCapped(res, CONNECTOR_REPLY_MAX_BYTES)) as { status?: unknown; text?: unknown; session?: unknown };
      if (typeof out.status !== 'number' || typeof out.text !== 'string') throw new Error('respuesta del orquestador inválida');
      return { status: out.status, text: out.text, ...(typeof out.session === 'string' ? { session: out.session } : {}) };
    },
  };
}
