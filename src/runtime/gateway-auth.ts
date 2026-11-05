// De dónde saca un cliente del Gateway su base URL y su credencial (docs/spec/deploy-sandbox.md §1). Con proxy, el Runtime y el
// CLI no tienen la llave: hablan con el proxy del orquestador con el token de la corrida. Sin proxy, todo como siempre.

export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh';

type Env = Readonly<Record<string, string | undefined>>;

export interface GatewayConnection { baseURL: string; token: string }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** El token de la corrida viaja en cada request: en claro solo por loopback (pruebas locales del proxy). */
function assertSecureBase(baseURL: string): void {
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error(`gateway: la base del proxy no es una URL válida: ${baseURL}`); }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return;
  throw new Error('gateway: la base del proxy debe ser https (http solo en 127.0.0.1 o localhost): el token de la corrida viajaría en claro');
}

/** El proxy del orquestador, o undefined sin él. Se enciende con la base (`WT_GATEWAY_BASE_URL`, o `ANTHROPIC_BASE_URL` que
 * ya usa el CLI) más `ANTHROPIC_AUTH_TOKEN`: la forma documentada de pasar Claude Code por Gateway. Solo la base de
 * `ANTHROPIC_BASE_URL` no basta: un dev con su propio proxy y su ANTHROPIC_API_KEY no cambia de comportamiento. */
export function gatewayProxy(env: Env): GatewayConnection | undefined {
  const explicit = env.WT_GATEWAY_BASE_URL || undefined;
  const token = env.ANTHROPIC_AUTH_TOKEN || undefined;
  // Pedir el proxy sin token es un error de despliegue: caer a la llave dejaría la llave en la VM justo donde no debe estar.
  if (explicit && !token) throw new Error('gateway: WT_GATEWAY_BASE_URL exige ANTHROPIC_AUTH_TOKEN (el token de la corrida); no se usa la llave del Gateway con proxy');
  const baseURL = explicit ?? (env.ANTHROPIC_BASE_URL || undefined);
  if (!baseURL || !token) return undefined;
  assertSecureBase(baseURL);
  return { baseURL, token };
}

/** Base y credencial de un cliente del Gateway: el proxy si está, y si no la llave (local/CI) o el OIDC (deploy en Vercel). */
export function gatewayConnection(env: Env = process.env): GatewayConnection {
  const proxy = gatewayProxy(env);
  if (proxy) return proxy;
  const token = env.AI_GATEWAY_API_KEY ?? env.VERCEL_OIDC_TOKEN;
  if (!token) throw new Error('gateway: falta AI_GATEWAY_API_KEY o VERCEL_OIDC_TOKEN');
  return { baseURL: GATEWAY_BASE_URL, token };
}

/** Guard de arranque (deploy-sandbox §1): con proxy, una llave del Gateway en el entorno es un error, no un respaldo. Los clientes
 * que aún leen la llave directo (imágenes: image-step, image-tool; transcribe) la usarían sin avisar con proxy y el agente, mismo
 * uid, podría leerla. Con este guard fallan sin llave en vez de filtrarla: "la llave no entra en la VM" queda garantizado aquí. */
export function assertNoKeyWithProxy(env: Env = process.env): void {
  if (!gatewayProxy(env)) return;
  const found = (['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'] as const).filter((k) => env[k]);
  if (found.length) throw new Error(`gateway: con proxy (WT_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN) el entorno no puede llevar ${found.join(' ni ')}: la llave no entra en la VM`);
}
