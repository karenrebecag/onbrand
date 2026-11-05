// Adaptador de identidad por JWT (docs/spec/identidad-sesion.md §3, fase 5): un verifier del puerto SessionVerifier para
// cualquier IdP que firme sesiones RS256 y publique su JWKS (o su llave pública PEM). Verifica con node:crypto, sin
// dependencia (Karen, 2026-11-05). El core lo conoce solo por el seam de config (sessionProvider 'jwt', scripts/serve.ts) y
// siempre envuelto en providerVerifier: nunca devuelve 'local'. Bajo el orquestador la VM sigue en 'signed': el orquestador
// verifica con esto y firma x-wt-identity (issueIdentity).

// JsonWebKey es global (lib DOM / webcrypto): node:crypto ya no lo exporta con ese nombre.
import { createPublicKey, verify as rsaVerify, type KeyObject } from 'node:crypto';
import { ALL_SCOPES, providerVerifier, type Scope, type SessionVerifier } from '../../runtime/session';

/** Claim por defecto con los scopes del runtime; WT_JWT_SCOPES_CLAIM lo cambia. */
export const DEFAULT_SCOPES_CLAIM = 'wt_scopes';
// Margen de reloj entre el IdP y este proceso.
const CLOCK_SKEW_MS = 5_000;
// El header viaja en cada request; un JWT de sesión con claims propios cabe holgado, uno enorme es abuso.
const MAX_TOKEN_CHARS = 8_192;
const B64URL = /^[A-Za-z0-9_-]+$/;
// Un kid desconocido obliga a refrescar el JWKS (rotación); sin tope, tokens con kid al azar serían un fetch por request.
const JWKS_REFRESH_MIN_MS = 60_000;
// Una llave que el IdP retira deja de valer como mucho a esta edad aunque nadie mande un kid nuevo (security-reviewer M1).
export const JWKS_MAX_AGE_MS = 10 * 60_000;
// Tras un fallo (5xx, timeout, JWKS vacío) se reintenta antes que el tope normal: un blip no deja el login caído un minuto (M2).
export const JWKS_RETRY_AFTER_ERROR_MS = 5_000;
// Durante una caída del JWKS la caché sigue sirviendo, pero no para siempre: una llave retirada mientras el IdP no responde
// deja de valer a esta edad (security-reviewer, segunda pasada, LOW).
export const JWKS_HARD_MAX_AGE_MS = 24 * 3_600_000;
const JWKS_TIMEOUT_MS = 5_000;
// La URL la pone el operador, pero un endpoint que responde de más no debe llenar la memoria (L4).
const JWKS_MAX_BYTES = 256 * 1024;
const MIN_RSA_BITS = 2048;

export type KeySource =
  | { readonly kind: 'pem'; readonly key: KeyObject }
  | { readonly kind: 'jwks'; readonly url: string; readonly fetch?: typeof fetch };

export interface JwtOptions {
  readonly issuer: string;
  readonly keys: KeySource;
  /** Orígenes del frontend que pueden presentar el token (claim azp); vacío = no se comprueba. */
  readonly authorizedParties?: readonly string[];
  /** Audiencia esperada (claim aud, string o lista); vacío = no se comprueba. */
  readonly audience?: readonly string[];
  /** Claim con los scopes; tiene que ser uno que la persona no pueda escribir en el IdP, o se daría spend y brand:write. */
  readonly scopesClaim?: string;
  readonly now?: () => number;
  /** Fallos del JWKS (status o motivo): sin esto una URL mala parecía "todos los tokens inválidos". */
  readonly onError?: (message: string) => void;
}

/** `warm` carga el JWKS ya en el arranque y lanza si no trae ninguna llave válida (con PEM no hace nada). */
export interface JwtVerifier extends SessionVerifier {
  warm(): Promise<void>;
}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const canonical = (part: string): boolean => B64URL.test(part) && Buffer.from(part, 'base64url').toString('base64url') === part;

function rsaKey(key: KeyObject, label: string): KeyObject {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa') throw new Error(`${label} debe ser una llave pública RSA`);
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) throw new Error(`${label} debe tener al menos ${MIN_RSA_BITS} bits`);
  return key;
}

/** Llaves por kid desde un JWKS; ignora lo que no es RSA de firma. */
function parseJwks(body: unknown): Map<string, KeyObject> {
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) throw new Error('JWKS sin keys');
  const out = new Map<string, KeyObject>();
  for (const k of keys as Record<string, unknown>[]) {
    if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use !== undefined && k.use !== 'sig') || (k.alg !== undefined && k.alg !== 'RS256')) continue;
    try { out.set(k.kid, rsaKey(createPublicKey({ key: k as JsonWebKey, format: 'jwk' }), `JWKS kid ${k.kid}`)); } catch { /* llave inválida: no entra */ }
  }
  return out;
}

interface Resolver {
  key(kid: string | undefined): Promise<KeyObject | undefined>;
  warm(): Promise<void>;
}

/** El cuerpo como texto, cortando al pasar `max` bytes sin leer el resto: res.text() lo cargaría entero antes de medirlo. */
async function boundedText(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('JWKS demasiado grande');
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new Error('JWKS demasiado grande'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function keyResolver(src: KeySource, now: () => number, onError: (m: string) => void): Resolver {
  if (src.kind === 'pem') return { key: async () => src.key, warm: async () => {} };
  let cache = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;
  let nextAllowed = -Infinity;
  let inflight: Promise<void> | undefined;
  const load = async (): Promise<void> => {
    // redirect 'error': la URL la fija el operador; seguir un 30x llevaría la confianza a otro origen.
    const res = await (src.fetch ?? fetch)(src.url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    const keys = parseJwks(JSON.parse(await boundedText(res, JWKS_MAX_BYTES)));
    // Un JWKS sin ninguna llave válida no reemplaza al bueno: borraría todas las sesiones por un proxy que responde {keys: []}.
    if (!keys.size) throw new Error('JWKS sin llaves RSA de firma válidas');
    cache = keys;
    fetchedAt = now();
  };
  const refresh = (): Promise<void> => {
    inflight ??= load()
      .then(() => { nextAllowed = now() + JWKS_REFRESH_MIN_MS; })
      .catch((e: unknown) => { nextAllowed = now() + JWKS_RETRY_AFTER_ERROR_MS; onError(`jwt: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { inflight = undefined; });
    return inflight;
  };
  return {
    key: async (kid) => {
      if (!kid) return undefined;
      const stale = now() - fetchedAt >= JWKS_MAX_AGE_MS;
      if ((stale || !cache.has(kid)) && now() >= nextAllowed) await refresh();
      if (now() - fetchedAt >= JWKS_HARD_MAX_AGE_MS) cache = new Map();
      return cache.get(kid);
    },
    warm: async () => {
      await refresh();
      if (!cache.size) throw new Error('el JWKS no trajo llaves válidas al arrancar (revisa WT_JWT_JWKS_URL)');
    },
  };
}

type Claims = Record<string, unknown>;

export function jwtVerifier(o: JwtOptions): JwtVerifier {
  const scopesClaim = o.scopesClaim ?? DEFAULT_SCOPES_CLAIM;
  const now = o.now ?? Date.now;
  const keys = keyResolver(o.keys, now, o.onError ?? (() => {}));
  const parties = new Set(o.authorizedParties ?? []);
  const audience = new Set(o.audience ?? []);
  const inner: SessionVerifier = {
    verify: async (headers) => {
      const auth = headers.authorization;
      const m = typeof auth === 'string' ? /^Bearer ([^\s]+)$/.exec(auth) : null;
      if (!m || m[1]!.length > MAX_TOKEN_CHARS) return { code: 'no-session' };
      const parts = m[1]!.split('.');
      if (parts.length !== 3 || !parts.every(canonical)) return { code: 'no-session' };
      const [h, p, s] = parts as [string, string, string];
      let header: { alg?: unknown; kid?: unknown; typ?: unknown; crit?: unknown };
      let claims: Claims;
      try { header = decode(h) as typeof header; claims = decode(p) as Claims; } catch { return { code: 'no-session' }; }
      if (!header || !claims || typeof claims !== 'object') return { code: 'no-session' };
      // Solo RS256: ni `none` ni HS256 con la pública como secreto (confusión de algoritmo).
      if (header.alg !== 'RS256') return { code: 'no-session' };
      // Ninguna extensión crítica es conocida aquí, y RFC 7515 §4.1.11 obliga a rechazar el token que declara alguna.
      if (header.crit !== undefined) return { code: 'no-session' };
      const key = await keys.key(typeof header.kid === 'string' ? header.kid : undefined);
      if (!key || !rsaVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) return { code: 'no-session' };
      if (claims.iss !== o.issuer) return { code: 'no-session' };
      if (typeof claims.sub !== 'string' || claims.sub === '') return { code: 'no-session' };
      if (parties.size && (typeof claims.azp !== 'string' || !parties.has(claims.azp))) return { code: 'no-session' };
      if (audience.size && !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).some((a) => typeof a === 'string' && audience.has(a))) return { code: 'no-session' };
      const t = now();
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return { code: 'no-session' };
      if (claims.exp * 1000 + CLOCK_SKEW_MS <= t) return { code: 'expired' };
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf * 1000 - CLOCK_SKEW_MS > t)) return { code: 'no-session' };
      // Sin el claim no hay scopes (403 en cada acción), no todos. Uno desconocido invalida el token entero, como signedVerifier.
      const raw = claims[scopesClaim] ?? [];
      if (!Array.isArray(raw) || !raw.every((x): x is Scope => typeof x === 'string' && ALL_SCOPES.has(x as Scope))) return { code: 'no-session' };
      return { owner: claims.sub, scopes: new Set(raw) };
    },
  };
  // 'local' o vacío como sub nunca llega al core (spec §5): providerVerifier lo rechaza como falta de sesión.
  return { ...providerVerifier(inner), warm: () => keys.warm() };
}

function httpsUrl(raw: string, label: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${label} no es una URL`); }
  if (u.protocol !== 'https:') throw new Error(`${label} debe ser https`);
  return u.href.replace(/\/$/, u.pathname === '/' ? '' : '/');
}

/** Arranque con WT_SESSION_PROVIDER=jwt. WT_JWT_ISSUER siempre (https); la llave por WT_JWT_PUBLIC_KEY (PEM, sin red) o
 *  WT_JWT_JWKS_URL (https). Lanza con mensaje accionable; serve.ts lo convierte en exit 2. */
export function jwtVerifierFromEnv(env: Readonly<Record<string, string | undefined>>, log: (message: string) => void = (m) => console.error(m)): JwtVerifier {
  const issuerRaw = env.WT_JWT_ISSUER?.trim();
  if (!issuerRaw) throw new Error('WT_SESSION_PROVIDER=jwt exige WT_JWT_ISSUER (el iss de los tokens de sesión, https)');
  // El iss se compara exacto y los IdP lo firman sin barra final.
  const issuer = httpsUrl(issuerRaw, 'WT_JWT_ISSUER').replace(/\/$/, '');
  const authorizedParties = (env.WT_JWT_AUTHORIZED_PARTIES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const audience = (env.WT_JWT_AUDIENCE ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  // Sin azp ni aud, un token válido de otra app del mismo issuer entra aquí: se avisa en el arranque.
  if (!authorizedParties.length && !audience.length) log('jwt: WT_JWT_AUTHORIZED_PARTIES y WT_JWT_AUDIENCE vacíos; no se comprueba para qué app se emitió el token (otra app del mismo issuer podría entrar)');
  const scopesClaim = env.WT_JWT_SCOPES_CLAIM?.trim() || DEFAULT_SCOPES_CLAIM;
  const base = { issuer, authorizedParties, audience, scopesClaim, onError: log };
  const pem = env.WT_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n').trim();
  if (pem) {
    if (/-----BEGIN [A-Z ]*PRIVATE/.test(pem)) throw new Error('WT_JWT_PUBLIC_KEY trae una llave privada; solo va la pública');
    let key: KeyObject;
    try { key = createPublicKey(pem); } catch { throw new Error('WT_JWT_PUBLIC_KEY no es un PEM público válido'); }
    return jwtVerifier({ ...base, keys: { kind: 'pem', key: rsaKey(key, 'WT_JWT_PUBLIC_KEY') } });
  }
  const jwks = env.WT_JWT_JWKS_URL?.trim();
  if (jwks) return jwtVerifier({ ...base, keys: { kind: 'jwks', url: httpsUrl(jwks, 'WT_JWT_JWKS_URL') } });
  throw new Error('WT_SESSION_PROVIDER=jwt exige WT_JWT_PUBLIC_KEY (PEM) o WT_JWT_JWKS_URL');
}
