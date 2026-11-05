// Catálogo de modelos para los selectores del builder. En el deploy los ids y nombres salen del catálogo vivo de
// AI Gateway (GET /v1/models, público, sin key); la lista permitida (WT_MODELS, WT_IMAGE_MODELS) acota qué puede
// elegir un visitante, porque cada modelo gasta de la misma key con presupuesto fijo.

import type { ModelOption } from './server';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
const TIMEOUT_MS = 5_000;

export type GatewayModelType = 'language' | 'image';
type FetchJson = (url: string) => Promise<unknown>;

const fetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`catálogo de AI Gateway: HTTP ${res.status}`);
  return res.json();
};

/** Lista de ids separada por comas; vacía o sin definir, el default. */
export function allowList(raw: string | undefined, fallback: readonly string[]): string[] {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : [...fallback];
}

/** Los permitidos que el catálogo trae con ese tipo, en el orden de la lista permitida (el primero es el default del
 * builder). El catálogo es dato externo: solo se toman `id` y `name` string de entradas con forma de objeto. */
export function pickGatewayModels(catalog: unknown, allow: readonly string[], type: GatewayModelType): ModelOption[] {
  const data = catalog && typeof catalog === 'object' ? (catalog as { data?: unknown }).data : undefined;
  const byId = new Map<string, string>();
  for (const m of Array.isArray(data) ? data : []) {
    if (!m || typeof m !== 'object') continue;
    const { id, name, type: t } = m as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof id === 'string' && t === type) byId.set(id, typeof name === 'string' && name.trim() ? name.trim() : id);
  }
  return allow.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id) as string, provider: 'ai-gateway' }));
}

/** Sin catálogo (Gateway caído al arrancar) quedan los permitidos con su id como nombre: el selector sigue acotado y
 * el server no se cae por un catálogo que solo pone nombres. */
export async function gatewayModels(allow: readonly string[], type: GatewayModelType, get: FetchJson = fetchJson): Promise<ModelOption[]> {
  try {
    return pickGatewayModels(await get(GATEWAY_MODELS_URL), allow, type);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}; uso la lista permitida sin nombres`);
    return allow.map((id) => ({ id, name: id, provider: 'ai-gateway' }));
  }
}
