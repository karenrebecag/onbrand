// Puerto de identidad (docs/spec/identidad-sesion.md §3, ADR 0016). El core solo trae el adaptador local; el proveedor
// real (Clerk u otro) es del perfil y entra por `RuntimeOptions.session` sin tocar el runtime.

import type { IncomingMessage } from 'node:http';
import { HttpError, isTrustedRequest } from './http';

/** Dueño de todo en el core: con un solo usuario implícito no hay a quién separar (spec §5, opción c de §6). */
export const LOCAL_OWNER = 'local';

export type Scope = 'chat:read' | 'chat:write' | 'spend' | 'brand:write';
export const ALL_SCOPES: ReadonlySet<Scope> = new Set<Scope>(['chat:read', 'chat:write', 'spend', 'brand:write']);

export interface Session {
  /** Id estable del proveedor; 'local' en el core. */
  readonly owner: string;
  readonly scopes: ReadonlySet<Scope>;
  /** Alcance opcional a chats concretos (token de preview, enlaces). */
  readonly chats?: ReadonlySet<string>;
}

/** Un verifier solo dice el motivo; el status y el texto salen de las tablas de abajo, así no puede mandar un par sin sentido
 * ni un mensaje propio al cliente. */
export interface Rejection {
  readonly code: 'no-session' | 'expired' | 'scope';
}

/** Contrato para un verifier externo (un IdP en una distro, o src/adapters/jwt en el core):
 * - Entra: los headers de la request. La sesión viaja como `Authorization: Bearer <token>`; el verifier no lee el body ni
 *   la URL, ni consulta el índice.
 * - Sale: `{ owner, scopes, chats? }` o un `Rejection`. `owner` es el id estable del IdP (p. ej. el `sub`), nunca '' ni
 *   'local': providerVerifier lo convierte en `no-session`, y el runtime envuelve así todo verifier que recibe.
 * - `scopes` solo los de ALL_SCOPES, sacados de algo que la persona no pueda escribir en el IdP; sin ellos, conjunto vacío
 *   (403 por acción), nunca todos. `chats` acota la sesión a esos ws (preview, VM de un chat); ausente = todos los suyos.
 * - `expired` solo para un token que verificó y venció (401 con `invalid_token`); cualquier otra falla es `no-session`.
 * Clerk, Firebase y otros IdP con JWKS entran por src/adapters/jwt sin código propio. */
export interface SessionVerifier {
  /** Puro respecto del runtime: recibe headers y no toca el índice. */
  verify(headers: Readonly<IncomingMessage['headers']>): Promise<Session | Rejection>;
}

/** Lo único que el cliente lee de un rechazo (spec §7). `scope` lo completa la acción en la fase 2. */
export const REJECTION_TEXT: Readonly<Record<Rejection['code'], string>> = { 'no-session': 'inicia sesión', expired: 'la sesión venció', scope: 'tu cuenta no puede hacer esto' };

/** ¿Esta sesión puede ver el chat de la entrada? Dueño igual (ausente = 'local') y, si la sesión trae `chats`, el ws incluido. */
export const owns = (session: Session, entry: { readonly ws: string; readonly owner?: string }): boolean =>
  (entry.owner ?? LOCAL_OWNER) === session.owner && (!session.chats || session.chats.has(entry.ws));

export const REJECTION_STATUS: Readonly<Record<Rejection['code'], 401 | 403>> = { 'no-session': 401, expired: 401, scope: 403 };

/** Challenge de todo 401 (RFC 9110 §15.5.2); un token vencido o inválido lleva el error de RFC 6750 §3. */
export const WWW_AUTHENTICATE: Readonly<Record<'no-session' | 'expired', string>> = { 'no-session': 'Bearer', expired: 'Bearer error="invalid_token"' };

/** El messageId que elige el cliente con identidad real: uuid (32 hex o con guiones) o 26+ caracteres base36 (>= 128 bits si
 * son aleatorios); compatible con MESSAGE_ID. La longitud no prueba la entropía, pero descarta los ids cortos adivinables. */
export const STRONG_MESSAGE_ID = /^[a-z0-9-]{26,63}$/;

/** El 403 de scope: texto genérico, sin decir qué scope falta (spec §7). */
export const scopeDenied = (): HttpError => new HttpError(REJECTION_STATUS.scope, REJECTION_TEXT.scope, { code: 'scope' });

/** Un verifier del perfil no puede devolver el dueño implícito ni uno vacío: compartiría las marcas, el "siempre" y los chats
 * con la sesión de loopback del core. Se rechaza como falta de sesión antes de que lo haga un adaptador real. */
export function providerVerifier(inner: SessionVerifier): SessionVerifier {
  return {
    verify: async (headers) => {
      const out = await inner.verify(headers);
      return !isRejection(out) && (out.owner === '' || out.owner === LOCAL_OWNER) ? { code: 'no-session' } : out;
    },
  };
}

export const isRejection = (r: Session | Rejection): r is Rejection => 'code' in r;

/** Sesión 'local' solo por loopback. Se evalúa SIN el secreto de origen: el secreto prueba que la request pasó por el
 * rewrite del builder, no quién es la persona, así que un deploy con secreto y sin verifier del perfil no entra por aquí
 * (HttpRouter no arranca en ese caso). */
export const localVerifier: SessionVerifier = {
  verify: async (headers) =>
    isTrustedRequest(headers) ? { owner: LOCAL_OWNER, scopes: ALL_SCOPES } : { code: 'no-session' },
};
