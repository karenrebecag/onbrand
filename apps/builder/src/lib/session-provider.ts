import { sessionProblem, type SessionProblem } from './session'

// run-client entra por aquí: una sola línea de import para fetch con sesión y la lectura del rechazo.
export { isAuthRejection, sessionProblem } from './session'

// Seam de sesión del builder (ADR 0017, docs/profile-module.md §Builder). El core no trae login: su provider por defecto
// no tiene token y el builder habla con el runtime local como siempre. Una distro registra el suyo desde
// su propio main.tsx con setSessionProvider antes de montar el builder; el SDK vive en la distro, nunca aquí
// (tests/core-sin-terceros.test.ts). Dueño y scopes los resuelve el servidor desde el token: el builder no lo decodifica.

export interface SessionUser { id: string; label?: string }

export interface SessionProvider {
  /** Token de sesión vigente, o null sin sesión. Se pide en cada request: el provider renueva el suyo. */
  getToken(): Promise<string | null>
  /** El servidor rechazó la sesión (401 no-session/expired, 403 scope): la distro abre su sign-in si quiere. */
  onRejected(problem: SessionProblem): void
  /** Opcional: con él, el builder ofrece "Cerrar sesión". */
  signOut?(): Promise<void>
  /** Opcional: con él, el builder muestra quién está conectado. */
  user?(): SessionUser | null
}

export const localSessionProvider: SessionProvider = {
  getToken: async () => null,
  onRejected: () => {},
}

// Un registro por build, como WT_PROFILE_MODULE en el server (src/profile.ts): se fija una vez al arrancar. Un segundo
// registro cambiaría el dueño de las requests a mitad de sesión (Arq, #787): lanza en vez de pisar.
let current: SessionProvider = localSessionProvider
let registered = false

export function setSessionProvider(provider: SessionProvider): void {
  if (registered) throw new Error('setSessionProvider: el provider de sesión ya está registrado; se fija una vez, en el entry de la distro')
  registered = true
  current = provider
}

export const sessionProvider = (): SessionProvider => current

function withBearer(headers: HeadersInit | undefined, token: string): Headers {
  const out = new Headers(headers)
  out.set('authorization', `Bearer ${token}`)
  return out
}

async function bodyOf(res: Response): Promise<unknown> {
  try { return await res.clone().json() } catch { return null }
}

// Solo la firma de llamada: `typeof fetch` con los tipos de bun exige también fetch.preconnect.
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/** fetch con la sesión del provider: Bearer si hay token, y un 401/403 con code de sesión se le avisa al provider. Quien
 * llama sigue leyendo el status como siempre (run-client lo traduce con sessionProblem). */
export function createApiFetch(deps: Readonly<{ fetch: FetchFn; provider: () => SessionProvider }>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const provider = deps.provider()
    const token = await provider.getToken()
    const res = await deps.fetch(input, token ? { ...init, headers: withBearer(init?.headers, token) } : init)
    if (res.status === 401 || res.status === 403) {
      const problem = sessionProblem(res.status, await bodyOf(res))
      if (problem) provider.onRejected(problem)
    }
    return res
  }
}

export const apiFetch = createApiFetch({ fetch: (input, init) => fetch(input, init), provider: sessionProvider })

export interface SessionMenu { user: SessionUser | null; signOut: (() => Promise<void>) | null }

/** Lo que el menú de sesión muestra: solo lo que el provider implementa. null = nada que mostrar (el provider local). */
export function sessionMenuOf(provider: SessionProvider): SessionMenu | null {
  const user = provider.user?.() ?? null
  const signOut = provider.signOut ? () => provider.signOut!() : null
  return user || signOut ? { user, signOut } : null
}
