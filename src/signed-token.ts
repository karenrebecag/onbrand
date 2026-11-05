// Token firmado con Ed25519 (docs/spec/deploy-sandbox.md §4): el orquestador firma con la llave privada y la VM verifica con
// la pública, así que una VM comprometida no puede acuñar identidades ni previews (con HMAC compartido sí). Módulo puro: sin
// imports del runtime ni del orquestador. `typ` va dentro del payload firmado para que un token de preview no valga como
// identidad aunque compartan par de llaves.

import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

export type TokenType = 'identity' | 'preview' | 'run' | 'media' | 'grant';

export interface TokenClaims {
  readonly typ: TokenType;
  readonly owner: string;
  readonly scopes: readonly string[];
  /** Chat al que sirve la VM que verifica; un token de otro chat no vale aquí. */
  readonly chat: string;
  /** Epoch en ms. */
  readonly exp: number;
  /** Solo `run`: messageId de la corrida que gasta; '' = token por chat (hasta que agent-loop reciba uno por corrida). */
  readonly run?: string;
  /** Solo `media`: la ruta exacta (relativa al chat) que abre, p. ej. `runs/<m>/shots/<f>`. Un token media no abre otra. */
  readonly path?: string;
  /** Solo `run`: las apps (slugs de conectores) que la persona pidió para esta corrida. El orquestador no sirve otras aunque el agente tenga el token. */
  readonly apps?: readonly string[];
  /** Solo `grant` (spec orquestador-enrutamiento §8.1): la llamada aprobada (`callId` = jti), su tool y los patrones que la tarjeta mostró. */
  readonly call?: string;
  readonly tool?: string;
  readonly patterns?: readonly string[];
  /** Solo `grant`: sha256 de los argumentos registrados con la tarjeta; el orquestador lo recomputa sobre lo que reenvía. */
  readonly args?: string;
}

export type TokenVerdict = { readonly ok: true; readonly claims: TokenClaims } | { readonly ok: false; readonly code: 'invalid' | 'expired' };

export interface VerifyExpect {
  readonly typ: TokenType;
  /** Omitirlo solo vale para `run`: el proxy sirve a todos los chats y usa el dueño del token. En identity/preview, sin chat = invalid. */
  readonly chat?: string;
  /** Tope de vida (exp - now). `run` lo exige: es la duración máxima de una corrida y la decide el orquestador, no este módulo. */
  readonly maxTtlMs?: number;
  /** Solo `media`: la ruta que se pide; debe ser igual a la firmada. */
  readonly path?: string;
  readonly now: number;
}

// Separa el dominio de esta firma de cualquier otra que use el mismo par de llaves.
const DOMAIN = Buffer.from('wt-signed-token.v1\0');
// El header viaja en cada request; un token enorme es abuso, no identidad.
const MAX_TOKEN_CHARS = 4096;
// Buffer.from(x, 'base64url') ignora lo que sigue a un '=' y los espacios: solo el alfabeto base64url, sin relleno.
const B64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SIG_BYTES = 64;
// Defensa en profundidad: el orquestador ya emite con vida corta, pero un bug o una llave filtrada que firme exp lejano
// dejaría un token casi permanente. Preview dura 1-2 h por diseño (previewTokenExp); la identidad, minutos.
export const MAX_TTL_MS: Readonly<Record<'identity' | 'preview' | 'media' | 'grant', number>> = { identity: 15 * 60_000, preview: 2 * 3_600_000, media: 5 * 60_000, grant: 120_000 };

const HOUR_MS = 3_600_000;
// 2 h es el tope de un preview (MAX_TTL_MS.preview). Si previewTokenExp diera exactamente 2 h, el reloj de la VM unos
// segundos atrás del orquestador haría `exp - now > 2 h` y el token recién firmado saldría invalid. 5 min de holgura
// lo evitan sin tocar el tope; el token sigue siendo el mismo durante toda la hora (depende solo del límite de hora).
const PREVIEW_SKEW_MS = 5 * 60_000;

/** Vencimiento del token de preview: siguiente límite de hora + 1 h, menos la holgura (vida ~55 min a ~1 h 55 min). Vive
 *  en este módulo puro para que el orquestador lo use al firmar sin arrastrar el HMAC de runtime/preview-token (A4). */
export const previewTokenExp = (now: number): number => (Math.floor(now / HOUR_MS) + 2) * HOUR_MS - PREVIEW_SKEW_MS;

const message = (payload: string): Buffer => Buffer.concat([DOMAIN, Buffer.from(payload)]);

const invalid = { ok: false, code: 'invalid' } as const;

export function sign(privateKey: KeyObject, claims: TokenClaims): string {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('sign necesita una llave privada Ed25519');
  // Falla en el orquestador, que puede corregirlo, y no como un 401 mudo en la VM.
  if (claims.typ === 'run' && claims.run === undefined) throw new Error("un token 'run' lleva el claim run ('' = por chat)");
  if (claims.typ === 'media' && !claims.path) throw new Error("un token 'media' lleva el claim path");
  if (claims.typ === 'grant' && (!claims.call || !claims.tool || !claims.patterns || !claims.args)) throw new Error("un token 'grant' lleva call, tool, patterns y args");
  if (claims.owner === '' || claims.chat === '' || !Number.isFinite(claims.exp)) throw new Error('claims inválidos: owner y chat no vacíos, exp finito');
  const payload = Buffer.from(JSON.stringify({ typ: claims.typ, owner: claims.owner, scopes: claims.scopes, chat: claims.chat, exp: claims.exp, ...(claims.run === undefined ? {} : { run: claims.run }), ...(claims.path === undefined ? {} : { path: claims.path }), ...(claims.apps === undefined ? {} : { apps: claims.apps }), ...(claims.call === undefined ? {} : { call: claims.call }), ...(claims.tool === undefined ? {} : { tool: claims.tool }), ...(claims.patterns === undefined ? {} : { patterns: claims.patterns }), ...(claims.args === undefined ? {} : { args: claims.args }) })).toString('base64url');
  return `${payload}.${edSign(null, message(payload), privateKey).toString('base64url')}`;
}

/** Falla cerrado: cualquier defecto (forma, llave, firma, typ, chat, claims) es `invalid`; solo un token auténtico y vencido es `expired`. */
export function verify(publicKey: KeyObject, token: string, expect: VerifyExpect): TokenVerdict {
  try {
    if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') return invalid;
    if (token.length > MAX_TOKEN_CHARS) return invalid;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return invalid;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!B64URL.test(payload) || !B64URL.test(sig)) return invalid;
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== ED25519_SIG_BYTES || given.toString('base64url') !== sig) return invalid;
    if (!edVerify(null, message(payload), publicKey, given)) return invalid;
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims> | null;
    if (!c || (c.typ !== 'identity' && c.typ !== 'preview' && c.typ !== 'run' && c.typ !== 'media' && c.typ !== 'grant') || typeof c.owner !== 'string' || typeof c.chat !== 'string') return invalid;
    if (!Array.isArray(c.scopes) || !c.scopes.every((s) => typeof s === 'string')) return invalid;
    if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return invalid;
    if (c.typ !== expect.typ) return invalid;
    if (expect.chat === undefined ? c.typ !== 'run' : c.chat !== expect.chat) return invalid;
    if (c.typ === 'run' && typeof c.run !== 'string') return invalid;
    if (c.apps !== undefined && (c.typ !== 'run' || !Array.isArray(c.apps) || c.apps.length > 20 || !c.apps.every((a) => typeof a === 'string'))) return invalid;
    const isGrant = c.typ === 'grant';
    if (isGrant ? typeof c.call !== 'string' || typeof c.tool !== 'string' || !c.call || !c.tool || !Array.isArray(c.patterns) || c.patterns.length > 8 || !c.patterns.every((x) => typeof x === 'string') || typeof c.args !== 'string' || !c.args : c.call !== undefined || c.tool !== undefined || c.patterns !== undefined || c.args !== undefined) return invalid;
    if (c.typ === 'media' && (typeof c.path !== 'string' || c.path === '' || c.path !== expect.path)) return invalid;
    // identity/preview: expect.maxTtlMs solo endurece el tope fijo; run no tiene tope propio y lo recibe de config.
    const maxTtl = c.typ === 'run' ? expect.maxTtlMs : Math.min(expect.maxTtlMs ?? Infinity, MAX_TTL_MS[c.typ]);
    if (maxTtl === undefined || !Number.isFinite(maxTtl) || !(maxTtl > 0)) return invalid;
    if (c.exp <= expect.now) return { ok: false, code: 'expired' };
    if (c.exp - expect.now > maxTtl) return invalid;
    return { ok: true, claims: { typ: c.typ, owner: c.owner, scopes: c.scopes, chat: c.chat, exp: c.exp, ...(c.typ === 'run' ? { run: c.run, ...(c.apps ? { apps: c.apps } : {}) } : {}), ...(c.typ === 'media' ? { path: c.path } : {}), ...(isGrant ? { call: c.call, tool: c.tool, patterns: c.patterns, args: c.args } : {}) } };
  } catch {
    return invalid;
  }
}
