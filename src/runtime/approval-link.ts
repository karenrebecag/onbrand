// Registro de aprobaciones en el orquestador (docs/spec/orquestador-enrutamiento.md §8.1). La VM registra la tarjeta que va a mostrar (callId, tool y los argumentos: los patrones
// los calcula el orquestador y los argumentos quedan en su registro, de donde sale lo que ve la persona y lo que el permiso cubre) y, decidida por la persona, recoge el permiso de esa llamada. Sin orquestador (core local) no hay enlace y nada de esto aplica.

import { orchestratorBase, orchestratorFetch } from './orchestrator-link';

type Env = Readonly<Record<string, string | undefined>>;
const TIMEOUT_MS = 5_000;

export interface ApprovalLink {
  /** false = el orquestador no la aceptó: la tarjeta no se muestra (falla cerrado). */
  register(callId: string, tool: string, input: unknown): Promise<boolean>;
  /** El permiso de la llamada ya aprobada, una sola vez; undefined si no hay. */
  grant(callId: string): Promise<string | undefined>;
}

export function approvalLink(env: Env, runToken: string | undefined, fetcher: typeof fetch = fetch): ApprovalLink | undefined {
  if (!orchestratorBase(env)) return undefined;
  return {
    async register(callId, tool, input) {
      try {
        const res = await orchestratorFetch(env, runToken, '/approvals/pending', { method: 'POST', body: { callId, tool, input }, timeoutMs: TIMEOUT_MS }, fetcher);
        await res.body?.cancel().catch(() => undefined);
        return res.ok;
      } catch {
        return false;
      }
    },
    async grant(callId) {
      try {
        const res = await orchestratorFetch(env, runToken, '/approvals/grant', { method: 'POST', body: { callId }, timeoutMs: TIMEOUT_MS }, fetcher);
        if (!res.ok) return undefined;
        const body = (await res.json()) as { grant?: unknown };
        return typeof body.grant === 'string' && body.grant.length < 4096 ? body.grant : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
