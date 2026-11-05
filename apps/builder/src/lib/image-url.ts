// Enter URL de Stitch (static-editor.md §2.6: sanitizer `Vn` + carga en un Image con 5 s de tope `Hn`): una URL que no
// es https o que no carga como imagen no se acepta, y el popover queda abierto con "Please enter a valid image URL".
// Solo https: la página publicada va por https y una imagen http se bloquea sin aviso.

export const IMAGE_LOAD_MS = 5000
// Lo mismo que el transport y el puente aceptan como src: lo que lo cerraría o no es parte de una URL no pasa.
const UNSAFE = /["'\\`{}<>\s]/

export function isImageUrl(value: string): boolean {
  const v = value.trim()
  if (!v || v.length > 2000 || UNSAFE.test(v)) return false
  try {
    const url = new URL(v)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Resuelve true si el navegador la puede pintar como imagen antes del tope. */
export function loadsAsImage(url: string, timeoutMs = IMAGE_LOAD_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    const timer = window.setTimeout(() => { img.src = ''; resolve(false) }, timeoutMs)
    img.onload = () => { window.clearTimeout(timer); resolve(img.naturalWidth > 0) }
    img.onerror = () => { window.clearTimeout(timer); resolve(false) }
    img.src = url
  })
}
