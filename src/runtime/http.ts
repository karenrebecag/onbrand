import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY = 1 << 20;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface OriginTrust { secret: string; origin?: string }

// La doc de Vercel pide comparar el secreto con una función timing-safe (https://vercel.com/docs/rewrites §Restricting
// your origin to Vercel traffic); timingSafeEqual exige el mismo largo, y el largo no es el secreto.
function sameSecret(given: string, secret: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** El transport no tiene auth: cualquier web abierta en el navegador podría pegarle a 127.0.0.1. Un
 * Host ajeno es DNS rebinding y un Origin ajeno es CSRF (el navegador siempre manda Origin en un POST
 * cross-origin, también en no-cors). Solo pasa lo que viene de loopback, que es el proxy del builder. */
export function isTrustedRequest(headers: IncomingMessage['headers'], trust?: OriginTrust): boolean {
  // El rewrite de Vercel hace `set` del header, así que un visitante no puede traer el suyo. Pero el rewrite se lo pone
  // también a un POST de otra web contra el builder: el Origin, si viene, tiene que ser el del builder (CSRF).
  // Con secreto no hay camino por loopback: no sabemos qué Host le pone a lo que reenvía el proxy del Sandbox.
  if (trust?.secret) {
    const given = headers['x-origin-secret'];
    if (typeof given !== 'string' || !sameSecret(given, trust.secret)) return false;
    const origin = headers.origin;
    return origin === undefined || (trust.origin !== undefined && origin === trust.origin);
  }
  const hostname = (h: string): string | null => {
    try {
      return new URL(`http://${h}`).hostname;
    } catch {
      return null;
    }
  };
  const host = hostname(headers.host ?? '');
  if (!host || !LOOPBACK.has(host)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Header que la subida multipart debe traer: multipart es un tipo de request simple y no fuerza preflight. */
export const UPLOAD_HEADER = 'x-wt-request';

/** CSRF desde una página generada (Arq): isTrustedRequest acepta todo origen loopback, y el preview se sirve en un puerto
 * loopback. Un POST text/plain o sin cuerpo es una request simple, sin preflight, así que esa página podía lanzar POST
 * /runs (gasta) o aprobar "siempre". Exigir JSON (o el header de la subida) fuerza el preflight, y la API no responde
 * CORS: el navegador no manda la request. Las rutas de callback del CLI quedan fuera: las cuida el token de la corrida y el
 * cliente MCP manda DELETE sin cuerpo. La subida al lienzo ya exige un tipo de imagen, que tampoco es simple. */
export function requireNonSimple(req: IncomingMessage, parts: string[]): void {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'application/json') return;
  if (parts[0] === 'uploads' && req.headers[UPLOAD_HEADER] === '1') return;
  // El dictado sube el audio en multipart igual que una imagen: mismo marcador no-simple para forzar preflight.
  if (parts[0] === 'transcribe' && req.headers[UPLOAD_HEADER] === '1') return;
  if (parts[0] === 'chats' && parts[2] === 'canvas' && parts[3] === 'files') return;
  req.resume();
  const multipart = parts[0] === 'uploads' || parts[0] === 'transcribe';
  throw new HttpError(415, multipart ? `${parts[0]} necesita el header ${UPLOAD_HEADER}: 1` : 'se espera content-type: application/json');
}

export function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) return reject(new HttpError(413, 'body demasiado grande'));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'body no es JSON'));
      }
    });
    req.on('error', reject);
  });
}

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

