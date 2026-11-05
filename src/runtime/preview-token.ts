// Token de preview con alcance de ws (docs/spec/identidad-sesion.md §9, fase 4). El listener de previews no tiene sesión:
// sin esto, quien conoce el ws ve la página. El runtime firma `{ ws, owner, exp }` con un secreto del proceso; el listener
// lo canjea por una cookie del origen del ws, como el `vm/open` 307 de v0 con su `__v0_s` (re-sistema/v0/INDICE-EXTRACTS.md:101).
// HMAC y no JWE: el payload no es secreto (ws y dueño), solo tiene que ser infalsificable.

import { createHmac, timingSafeEqual, type KeyObject } from 'node:crypto';
import { verify as verifySigned } from '../signed-token';
import { LOCAL_OWNER } from './session';

export interface PreviewClaims {
  readonly ws: string;
  readonly owner: string;
  /** Epoch en ms. */
  readonly exp: number;
}

export type PreviewVerdict = { readonly ok: true; readonly owner: string; readonly exp: number } | { readonly ok: false; readonly code: 'invalid' | 'expired' };

// HACK: el token no se revoca salvo rotando WT_PREVIEW_SECRET (invalida todos): el tope de exposición es su vida (1-2 h,
// previewTokenExp). Lista de revocación o vida corta con renovación cuando haya créditos o chats compartidos.

// previewTokenExp vive en el módulo puro signed-token (lo comparte el orquestador al firmar); se reexporta para los
// consumidores de siempre (preview-dist, tests).
export { previewTokenExp } from '../signed-token';

/** Por debajo de 32 bytes el HMAC-SHA256 pierde margen frente a fuerza bruta del secreto. */
export const MIN_SECRET_BYTES = 32;

const b64 = (b: Buffer): string => b.toString('base64url');
// Buffer.from(x, 'base64url') ignora lo que sigue a un '=' y los espacios: sin forma canónica, `<token>=\r\nX: y` verificaba
// y la cola llegaba a Set-Cookie (security-reviewer H1). Solo el alfabeto base64url, sin relleno.
const B64URL = /^[A-Za-z0-9_-]+$/;
const mac = (payload: string, secret: Buffer): Buffer => createHmac('sha256', secret).update(payload).digest();

function assertSecret(secret: Buffer): void {
  if (secret.length < MIN_SECRET_BYTES) throw new Error(`el secreto del token de preview necesita al menos ${MIN_SECRET_BYTES} bytes`);
}

export function signPreviewToken(claims: PreviewClaims, secret: Buffer): string {
  assertSecret(secret);
  const payload = b64(Buffer.from(JSON.stringify({ ws: claims.ws, owner: claims.owner, exp: claims.exp })));
  return `${payload}.${b64(mac(payload, secret))}`;
}

/** Vale solo para `ws`: el token de otro ws es `invalid`, igual que uno alterado (el cliente no distingue cuál falló). */
export function verifyPreviewToken(token: string, secret: Buffer, ws: string, now: number): PreviewVerdict {
  assertSecret(secret);
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, code: 'invalid' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!B64URL.test(payload) || !B64URL.test(sig)) return { ok: false, code: 'invalid' };
  const given = Buffer.from(sig, 'base64url');
  if (b64(given) !== sig) return { ok: false, code: 'invalid' };
  const expected = mac(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, code: 'invalid' };
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return { ok: false, code: 'invalid' }; }
  const c = claims as Partial<PreviewClaims> | null;
  if (!c || typeof c.ws !== 'string' || typeof c.owner !== 'string' || typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return { ok: false, code: 'invalid' };
  if (c.ws !== ws) return { ok: false, code: 'invalid' };
  if (now >= c.exp) return { ok: false, code: 'expired' };
  return { ok: true, owner: c.owner, exp: c.exp };
}

// Modo asimétrico (docs/spec/deploy-sandbox.md §4): bajo el orquestador el secreto HMAC no puede entrar en la VM, así que
// el orquestador firma el token con una llave privada Ed25519 y la VM lo verifica con la pública. Una VM comprometida ya
// no puede acuñar previews. El modo se elige por presencia de la llave (serve.ts): pública XOR secreto, nunca ambas.
export type PreviewKey =
  | { readonly mode: 'hmac'; readonly secret: Buffer }
  | { readonly mode: 'ed25519'; readonly publicKey: KeyObject };

// La firma Ed25519 la acuña el orquestador (src/orchestrator/identity.ts `issuePreviewToken`), nunca la VM: este módulo
// del runtime solo verifica con la pública, por eso aquí no hay ninguna llave privada (ver el estándar en signed-boot.test).

/** Verifica con la llave que tenga el gate: HMAC en local, Ed25519 (pública) bajo el orquestador. Un token del otro modo
 *  no valida (el HMAC no es una firma Ed25519 y viceversa), y un `typ: 'identity'` se rechaza como `invalid`. */
export function verifyPreview(token: string, key: PreviewKey, ws: string, now: number): PreviewVerdict {
  if (key.mode === 'hmac') return verifyPreviewToken(token, key.secret, ws, now);
  const out = verifySigned(key.publicKey, token, { typ: 'preview', chat: ws, now });
  if (!out.ok) return { ok: false, code: out.code === 'expired' ? 'expired' : 'invalid' };
  // Como signedVerifier: bajo el orquestador no hay dueño vacío ni 'local' (las entradas sin dueño caen en local); un
  // preview firmado para ellos es bogus aunque la firma valide.
  if (out.claims.owner === '' || out.claims.owner === LOCAL_OWNER) return { ok: false, code: 'invalid' };
  return { ok: true, owner: out.claims.owner, exp: out.claims.exp };
}
