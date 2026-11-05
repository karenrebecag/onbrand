// Nombre de la pantalla encima del marco (docs/spec/nombre-pantalla.md, opción a). Stitch pinta encima de cada nodo
// `i?.label || o.title || 'Screen'` (DP l.10017, l.32512): el título de la pantalla, no el dispositivo. El dispositivo
// se lee en el ancho del marco y en el badge de tamaño; para un lector de pantalla va en el title del iframe.

export const GENERATING_LABEL = 'Generando pantalla'
export const UNTITLED = 'Nueva página'

/** El título de la pantalla: el de page.json, si no la primera línea del primer prompt, si no `Nueva página`. Es la
 * misma cadena de la barra superior, así el lienzo y el top bar no dicen dos nombres distintos. */
export function screenTitle(pageTitle: string | undefined, firstPrompt: string | undefined): string {
  const line = firstPrompt?.split('\n').find((l) => l.trim())?.trim()
  return pageTitle?.trim() || line || UNTITLED
}

/** La etiqueta visible de un marco: una variante dice su título; la página, `Generando pantalla` hasta su primera
 * sección y después el título de la pantalla. */
export function frameLabel(o: { title: string; generating: boolean; variantTitle?: string }): string {
  if (o.variantTitle !== undefined) return o.variantTitle
  return o.generating ? GENERATING_LABEL : o.title
}

/** title del iframe: los dos marcos de la página dicen lo mismo encima, así que el dispositivo va aquí. */
export const frameA11yTitle = (title: string, device: string): string => `${title}, ${device.toLowerCase()}`
