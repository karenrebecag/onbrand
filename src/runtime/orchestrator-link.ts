// Salida de la VM hacia el orquestador con el token de la corrida (el mismo del proxy de Gateway). La base sale de WT_GATEWAY_BASE_URL
// (`<orquestador>/gw/claude-code`); las rutas se piden relativas a `<orquestador>/gw`, que gatewayProxy ya exige https o loopback; sin token o con otra forma la ruta no existe.

import { gatewayProxy } from './gateway-auth';

type Env = Readonly<Record<string, string | undefined>>;
const TIMEOUT_MS = 30_000;

/** undefined = no hay orquestador (core local). Lanza solo si el despliegue está mal (gatewayProxy). */
export function orchestratorBase(env: Env): string | undefined {
  if (!env.WT_GATEWAY_BASE_URL) return undefined;
  const proxy = gatewayProxy(env);
  return proxy && /\/claude-code\/?$/.test(proxy.baseURL) ? proxy.baseURL.replace(/\/claude-code\/?$/, '') : undefined;
}

/** `path` empieza con `/`. redirect manual: un 3xx no manda el token de la corrida a otro host. */
export function orchestratorFetch(env: Env, runToken: string | undefined, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const base = orchestratorBase(env);
  if (!base || !runToken) return Promise.reject(new Error('orquestador no disponible'));
  return fetcher(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${runToken}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
  });
}
