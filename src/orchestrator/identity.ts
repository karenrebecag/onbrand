// Lado orquestador de x-wt-identity (docs/spec/deploy-sandbox.md §4): la única parte que tiene la llave privada.

import type { KeyObject } from 'node:crypto';
import type { Session } from '../runtime/session';
import { LOCAL_OWNER } from '../runtime/session';
import { MAX_TTL_MS, previewTokenExp, sign } from '../signed-token';

/** `ttlMs` corto (minutos): un header robado deja de valer solo, y solo vale para el `chat` de la VM. */
export function issueIdentity(privateKey: KeyObject, session: Session, chat: string, ttlMs: number, now: () => number = Date.now): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS.identity) throw new Error(`ttlMs debe estar entre 1 y ${MAX_TTL_MS.identity}`);
  // Mismo criterio que providerVerifier: 'local' firmado compartiría rutas legado con la sesión de loopback del core.
  if (session.owner === '' || session.owner === LOCAL_OWNER) throw new Error('no se firma identidad para el dueño vacío ni local');
  return sign(privateKey, { typ: 'identity', owner: session.owner, scopes: [...session.scopes].sort(), chat, exp: now() + ttlMs });
}

/** Token que el CLI de la VM presenta al proxy de Gateway (ANTHROPIC_AUTH_TOKEN). `maxTtlMs` es el tope de duración de una
 * corrida y lo decide el orquestador; `run` = messageId de la corrida, '' = token por chat (tope solo por dueño). */
export function issueRunToken(privateKey: KeyObject, owner: string, chat: string, run: string, ttlMs: number, maxTtlMs: number, now: () => number = Date.now, apps: readonly string[] = []): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > maxTtlMs) throw new Error(`ttlMs debe estar entre 1 y ${maxTtlMs}`);
  if (owner === '' || owner === LOCAL_OWNER) throw new Error('no se firma un token de gasto para el dueño vacío ni local');
  return sign(privateKey, { typ: 'run', owner, scopes: [], chat, run, exp: now() + ttlMs, ...(apps.length ? { apps: [...apps] } : {}) });
}

/** Token de un solo recurso para un `<img src>` (spec orquestador-enrutamiento §4): abre `path` (relativa al chat) 5 minutos y nada más.
 * Sin scopes: quien lo presenta recibe una identidad `chat:read` y ningún otro, aunque la persona que lo pidió tuviera más. */
export function issueMediaToken(privateKey: KeyObject, owner: string, chat: string, path: string, now: () => number = Date.now): string {
  if (owner === '' || owner === LOCAL_OWNER) throw new Error('no se firma un token media para el dueño vacío ni local');
  return sign(privateKey, { typ: 'media', owner, scopes: [], chat, path, exp: now() + MAX_TTL_MS.media });
}

/** Token de preview firmado (deploy-sandbox.md §4): lo acuña el orquestador y la VM lo verifica con la pública (nunca
 *  firma). `chat = ws`; `exp` sigue la regla de §9 (siguiente límite de hora + 1 h, vida 1-2 h) y signed-token lo acota a
 *  2 h. `typ: 'preview'` impide que valga como identidad aunque compartan par de llaves. */
export function issuePreviewToken(privateKey: KeyObject, ws: string, owner: string, scopes: readonly string[] = [], now: () => number = Date.now): string {
  if (owner === '' || owner === LOCAL_OWNER) throw new Error('no se firma un preview para el dueño vacío ni local');
  return sign(privateKey, { typ: 'preview', owner, scopes: [...scopes].sort(), chat: ws, exp: previewTokenExp(now()) });
}

/** Permiso de UNA llamada aprobada por la persona (spec §8.1): vale lo que la tarjeta mostró (tool, patrones y hash de los argumentos), 120 s (`APPROVAL_TIMEOUT_MS`) y un solo uso, que cuenta el índice. */
export function issueGrant(privateKey: KeyObject, owner: string, chat: string, call: string, tool: string, patterns: readonly string[], args: string, now: () => number = Date.now): string {
  if (owner === '' || owner === LOCAL_OWNER) throw new Error('no se firma un grant para el dueño vacío ni local');
  return sign(privateKey, { typ: 'grant', owner, scopes: [], chat, exp: now() + MAX_TTL_MS.grant, call, tool, patterns: [...patterns], args });
}
