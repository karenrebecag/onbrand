// Tokens de prueba para QA de identidad (fase 5), sin red ni IdP real: un par RSA efímero firma los JWT de sesión y el
// runtime los acepta con WT_SESSION_PROVIDER=jwt y las WT_JWT_* que imprime este script. La llave privada nunca sale del
// proceso; los tokens solo valen contra el runtime arrancado con esa pública.
//   bun scripts/qa-tokens.ts --ws <chatId> [--out <archivo>] [--ttl-hours 8]
// Las cookies de preview se firman con un WT_PREVIEW_SECRET efímero que se imprime: nunca el del entorno, que podría ser el
// de un deploy real (imprimirlo lo filtraría y sus cookies valdrían allí; security-reviewer M1).

import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ALL_SCOPES } from '../src/runtime/session';
import { MIN_SECRET_BYTES, signPreviewToken } from '../src/runtime/preview-token';
import { PREVIEW_COOKIE } from '../src/runtime/preview-serve';
import { DEFAULT_SCOPES_CLAIM } from '../src/adapters/jwt/verifier';

export const QA_ISSUER = 'https://qa.onbrand.test';
export const QA_OWNER_A = 'qa_user_a';
export const QA_OWNER_B = 'qa_user_b';

export interface QaTokenOptions {
  /** Chat (ws) al que valen las cookies de preview. */
  readonly ws: string;
  /** Origen del builder que presenta los tokens (azp). */
  readonly builderOrigin: string;
  readonly ttlMs: number;
  /** Secreto HMAC del gate de preview (WT_PREVIEW_SECRET); >= 32 bytes. */
  readonly previewSecret: Buffer;
  readonly now: number;
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(key: KeyObject, claims: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

/** Las variables del runtime (WT_*) y las de QA (QA_*), en orden estable. */
export function qaTokens(o: QaTokenOptions): Record<string, string> {
  if (o.previewSecret.length < MIN_SECRET_BYTES) throw new Error(`WT_PREVIEW_SECRET necesita al menos ${MIN_SECRET_BYTES} bytes`);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sec = Math.floor(o.now / 1000);
  const session = (sub: string, exp: number) => jwt(privateKey, { iss: QA_ISSUER, sub, azp: o.builderOrigin, iat: sec, nbf: sec, exp, [DEFAULT_SCOPES_CLAIM]: [...ALL_SCOPES].sort() });
  const cookie = (owner: string, exp: number) => `${PREVIEW_COOKIE}=${signPreviewToken({ ws: o.ws, owner, exp }, o.previewSecret)}`;
  return {
    WT_SESSION_PROVIDER: 'jwt',
    WT_JWT_ISSUER: QA_ISSUER,
    WT_JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim().replace(/\n/g, '\\n'),
    WT_JWT_AUTHORIZED_PARTIES: o.builderOrigin,
    WT_PREVIEW_SECRET: o.previewSecret.toString('utf8'),
    QA_TOKEN_A: session(QA_OWNER_A, sec + Math.floor(o.ttlMs / 1000)),
    QA_TOKEN_B: session(QA_OWNER_B, sec + Math.floor(o.ttlMs / 1000)),
    // Venció hace una hora: fuera del margen de reloj del verifier.
    QA_TOKEN_EXPIRED: session(QA_OWNER_A, sec - 3600),
    // Sin cookie de B para el ws de A: con HMAC el gate autoriza al acuñar (preview-serve.ts checkGate), así que una cookie
    // firmada aquí con el secreto siempre pasa y no prueba nada. Lo de B se prueba por el latido (spec §11.4).
    QA_PREVIEW_COOKIE_EXPIRED: cookie(QA_OWNER_B, o.now - 3_600_000),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const ws = arg('--ws');
  if (!ws) { console.error('uso: bun scripts/qa-tokens.ts --ws <chatId> [--out <archivo>] [--ttl-hours 8]'); process.exit(2); }
  const hours = Number(arg('--ttl-hours') ?? 8);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) { console.error('--ttl-hours entre 0 y 24'); process.exit(2); }
  // Un secreto aleatorio en base64url: utf8 de vuelta da los mismos bytes y cabe en un .env sin comillas.
  const secret = Buffer.from(randomBytes(32).toString('base64url'), 'utf8');
  const env = qaTokens({ ws, builderOrigin: process.env.WT_BUILDER_ORIGIN ?? 'http://localhost:5173', ttlMs: hours * 3_600_000, previewSecret: secret, now: Date.now() });
  const text = `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  const out = arg('--out');
  // Son credenciales de prueba con vida de horas: solo para la persona que corre QA. 'wx': sobre un archivo existente el
  // mode no se aplicaría y quedaría con sus permisos de antes (security-reviewer M2); mejor fallar.
  if (out) {
    try { writeFileSync(out, text, { mode: 0o600, flag: 'wx' }); } catch (e) { console.error(`--out ${out}: ${(e as NodeJS.ErrnoException).code === 'EEXIST' ? 'ya existe; bórralo o elige otro' : String(e)}`); process.exit(2); }
  }
  else process.stdout.write(text);
}
