// Preview con alcance (docs/spec/identidad-sesion.md §9): el latido (POST /preview/heartbeat) trae, para los ws del
// dueño, la url estable y un `previewToken`. Cada montaje del iframe va con ?wt_preview=<token vigente> y el 307 del
// preview lo canjea por la cookie y limpia la url. En cada montaje y no solo en el primero: la cookie vence (1-2 h)
// aunque la url no cambie, y una recarga dentro del iframe (vite full-reload, wt-hmr-recover) daría 401 sin que el
// builder lo vea; el marco mudo se remonta y ese remonte lleva el token vigente (ec). Sin previewToken, la url tal cual.
//
// El src de un iframe montado no se toca: cambiarlo navega el iframe, y un token renovado no debe recargar la página.
// Por eso se fija por montaje (marco + key del iframe) y el token nuevo entra en el próximo remonte. El token es del ws;
// escritorio y móvil son dos marcos del mismo ws, cada uno con su montaje.

export const PREVIEW_TOKEN_PARAM = 'wt_preview'

/** La url estable con el token en la query, sin pisar lo que ya traía; sin token, la url tal cual. */
export function urlFor(url: string, token: string | undefined): string {
  if (!token) return url
  const u = new URL(url)
  u.searchParams.set(PREVIEW_TOKEN_PARAM, token)
  return u.toString()
}

export interface PreviewAccess {
  /** El token del último latido para ese ws (undefined: no trajo). No cambia ningún iframe montado. */
  offer(id: string, token: string | undefined): void
  /** El src del iframe `slot` (marco) del ws en ese montaje, con el token vigente al montar; fijo mientras dure. */
  srcFor(ws: string, slot: string, mountKey: string, url: string): string
  /** El token vigente del ws, para lo que abre el preview fuera de un iframe (una pestaña nueva no tiene la cookie). */
  tokenFor(ws: string): string | undefined
}

export function createPreviewAccess(): PreviewAccess {
  const tokens = new Map<string, string>()
  // Un montaje vivo por marco: el anterior ya no existe cuando React monta el siguiente.
  const mounts = new Map<string, { key: string; url: string; src: string }>()
  return {
    offer(id, token) {
      if (token) tokens.set(id, token)
      else tokens.delete(id)
    },
    srcFor(ws, slot, mountKey, url) {
      const m = mounts.get(slot)
      if (m && m.key === mountKey && m.url === url) return m.src
      const src = urlFor(url, tokens.get(ws))
      mounts.set(slot, { key: mountKey, url, src })
      return src
    },
    tokenFor(ws) {
      return tokens.get(ws)
    },
  }
}
