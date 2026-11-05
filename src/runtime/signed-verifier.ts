// SessionVerifier de la VM bajo el orquestador (docs/spec/deploy-sandbox.md §4): el orquestador autentica a la persona y firma
// `x-wt-identity`; aquí solo se verifica con la llave pública y se acota al chat que sirve esta VM. Se cablea con `sessionProvider: 'signed'` (serve.ts).

import type { KeyObject } from 'node:crypto';
import { verify } from '../signed-token';
import { parsePublicKeyPem } from './public-key';
import { ALL_SCOPES, LOCAL_OWNER, STRONG_MESSAGE_ID, type Scope, type SessionVerifier } from './session';

export const IDENTITY_HEADER = 'x-wt-identity';

export function signedVerifier(publicKey: KeyObject, chat: string, now: () => number = Date.now): SessionVerifier {
  if (chat === '') throw new Error('signedVerifier necesita el chat que sirve esta VM');
  return {
    verify: async (headers) => {
      const raw = headers[IDENTITY_HEADER];
      if (typeof raw !== 'string') return { code: 'no-session' };
      const out = verify(publicKey, raw, { typ: 'identity', chat, now: now() });
      if (!out.ok) return { code: out.code === 'expired' ? 'expired' : 'no-session' };
      // Un scope desconocido es un token que este runtime no sabe interpretar: se rechaza entero, no se ignora el scope.
      const scopes = out.claims.scopes.filter((s): s is Scope => ALL_SCOPES.has(s as Scope));
      if (scopes.length !== out.claims.scopes.length) return { code: 'no-session' };
      // Bajo el orquestador la VM no atiende loopback: 'local' es el dueño implícito de entradas sin owner y de rutas legado.
      if (out.claims.owner === '' || out.claims.owner === LOCAL_OWNER) return { code: 'no-session' };
      return { owner: out.claims.owner, scopes: new Set(scopes), chats: new Set([chat]) };
    },
  };
}

/** Arranque con WT_SESSION_PROVIDER=signed: la VM sirve un solo chat (WT_CHAT_ID, el ws) y solo trae la llave pública. Lanza con un
 * mensaje accionable; serve.ts lo convierte en exit 2 para que el deploy no quede abierto ni sin chat. */
export function signedVerifierFromEnv(env: Readonly<Record<string, string | undefined>>): SessionVerifier {
  if (!env.WT_IDENTITY_PUBLIC_KEY?.trim()) throw new Error('WT_SESSION_PROVIDER=signed exige WT_IDENTITY_PUBLIC_KEY (PEM de la llave pública Ed25519 del orquestador)');
  const key = parsePublicKeyPem(env.WT_IDENTITY_PUBLIC_KEY, 'WT_IDENTITY_PUBLIC_KEY');
  const chat = env.WT_CHAT_ID?.trim();
  if (!chat) throw new Error('WT_SESSION_PROVIDER=signed exige WT_CHAT_ID (el chat que sirve esta VM)');
  // El chat es un messageId con identidad real (>= 128 bits): uno corto o adivinable haría de la VM un chat que otro puede abrir.
  if (!STRONG_MESSAGE_ID.test(chat)) throw new Error('WT_CHAT_ID debe ser un id de chat de 26+ caracteres [a-z0-9-]');
  return signedVerifier(key, chat);
}
