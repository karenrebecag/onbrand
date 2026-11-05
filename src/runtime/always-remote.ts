// "Siempre" bajo el orquestador (docs/spec/orquestador-enrutamiento.md §8): la fuente es el índice global, no el disco de esta VM. La VM lo
// pregunta al orquestador con el token de la corrida (el mismo del proxy de Gateway) y de él sale el dueño. Si la consulta falla, no hay "siempre":
// se pregunta a la persona, nunca se autoapprueba por un fallo.

import { orchestratorFetch } from './orchestrator-link';

const ALWAYS_TIMEOUT_MS = 3_000;
type Env = Readonly<Record<string, string | undefined>>;

/** `GET <orquestador>/gw/always` con el token de la corrida. undefined cuando no hay orquestador (core local: manda el AlwaysStore de la VM). */
export function alwaysRemote(env: Env, runToken: string | undefined, fetcher: typeof fetch = fetch): (() => Promise<ReadonlySet<string> | undefined>) | undefined {
  if (!env.WT_GATEWAY_BASE_URL) return undefined;
  // Con orquestador la autoridad es el índice global: sin token de corrida o con una base rara la consulta falla cerrado (siempre se pregunta).
  return async () => {
    try {
      const res = await orchestratorFetch(env, runToken, '/always', { timeoutMs: ALWAYS_TIMEOUT_MS }, fetcher);
      if (!res.ok) return undefined;
      const body = (await res.json()) as { tools?: unknown };
      return Array.isArray(body.tools) ? new Set(body.tools.filter((t): t is string => typeof t === 'string')) : undefined;
    } catch {
      return undefined;
    }
  };
}
