// Fase 1 de identidad (docs/spec/identidad-sesion.md §7, runtime src/runtime/session.ts): el runtime rechaza con 401
// {code:'no-session'|'expired'} o 403 {code:'scope'}. Ninguno se arregla reintentando: quien llama corta y muestra el
// copy. Con el verifier local (loopback) no llegan nunca, así que en el core nada cambia. El login es del perfil.

// Mismos codes que Rejection de src/runtime/session.ts; no se importa de ahí porque arrastra node:http al build del builder.
export type SessionCode = 'no-session' | 'expired' | 'scope'
export interface SessionProblem { status: 401 | 403; code: SessionCode; message: string }

const COPY: Record<SessionCode, string> = {
  'no-session': 'Inicia sesión para seguir: este servidor pide una cuenta.',
  expired: 'Tu sesión venció. Vuelve a iniciar sesión para seguir.',
  scope: 'Tu cuenta no tiene permiso para hacer esto.',
}

const CODES_BY_STATUS: Record<401 | 403, readonly SessionCode[]> = { 401: ['no-session', 'expired'], 403: ['scope'] }

/** El rechazo de sesión de una respuesta, o null si es otro error (un 403 'origen no permitido' no trae code). */
export function sessionProblem(status: number, body: unknown): SessionProblem | null {
  if (status !== 401 && status !== 403) return null
  const b = typeof body === 'object' && body !== null ? (body as { code?: unknown; error?: unknown }) : {}
  const code = CODES_BY_STATUS[status].find((c) => c === b.code)
  if (!code) return null
  // El 403 de scope puede nombrar la acción ("tu cuenta no puede <acción>"); el genérico del runtime no aporta más que el nuestro.
  const named = code === 'scope' && typeof b.error === 'string' && b.error && b.error !== 'tu cuenta no puede hacer esto'
  return { status, code, message: named ? (b.error as string) : COPY[code] }
}

/** Status que ningún reintento arregla: un poller que lo recibe se detiene en vez de martillar cada pocos segundos. */
export const isAuthRejection = (status: number | undefined): boolean => status === 401 || status === 403
