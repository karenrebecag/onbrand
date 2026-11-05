// Snapshot del DOM por versión (H12; v0 guarda un `snapshot-form` del preview con su devtools). El serializer de v0 no se puede
// extraer (2026-11-04): este es propio y mínimo. Sale de la página que el preview-check ya tiene abierta a 1440, junto a las
// capturas de esa versión (<git-dir>/wt-visual/<sha>/), así que no abre navegador ni espera nada más.
//
// El archivo resultante se sirve SIEMPRE con CSP sandbox o como texto plano, nunca como HTML del mismo origen: el saneo de abajo
// (sin scripts, handlers, URLs javascript: ni vectores de carga) es defensa en profundidad, no la única barrera.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneVersions } from './shot-store';

/** Un DOM de página de marketing pesa decenas de KB; el tope solo corta un caso patológico (listas de miles de nodos). */
export const MAX_DOM_BYTES = 1_000_000;

/** Corre dentro de la página (`page.evaluate`): no puede cerrar sobre nada de este módulo. Sin scripts, handlers inline ni preloads: no son
 * el DOM que la persona ve, y el overlay de errores de vite es ruido de dev. */
export function serializeDom(): string {
  // cloneNode copia el markup que la persona ve, NO el estado en vivo: un input conserva su atributo value, no lo que el
  // usuario tecleó (.value), ni se arrastran checked/selected dinámicos. Para una captura visual del DOM alcanza.
  const root = document.documentElement.cloneNode(true) as HTMLElement;
  // Elementos que ejecutan o navegan al abrir el archivo: scripts, el overlay de vite, y vectores de carga/ejecución
  // (iframe con HTML embebido, refresh por meta, base que reescribe URLs relativas, plugins object/embed).
  root.querySelectorAll('script, noscript, link[rel="modulepreload"], vite-error-overlay, iframe[srcdoc], meta[http-equiv="refresh" i], base, object, embed').forEach((e) => e.remove());
  // Scheme javascript: tolera espacios/controles intercalados; el navegador los ignora al resolver, así que se quitan antes de comparar.
  const isJsUrl = (v: string): boolean => v.replace(/[\u0000- ]+/g, '').toLowerCase().startsWith('javascript:');
  // Atributos que llevan URL navegable/ejecutable: href/src/action, xlink:href (SVG <a>) y formaction (button/input).
  const urlAttrs = new Set(['href', 'src', 'action', 'xlink:href', 'formaction']);
  // Inline handlers (onclick=...) y URLs javascript: en esos atributos: el snapshot se abre como archivo y no debe ejecutar código del preview.
  root.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || (urlAttrs.has(name) && isJsUrl(a.value))) e.removeAttribute(a.name);
    }
  });
  return `<!doctype html>\n${root.outerHTML}`;
}

/** Escribe `dom@<ancho>.html` en el directorio de la versión. Devuelve la ruta. */
// HACK: el DOM se escribe pero nadie lo lee todavía. Consumidor previsto: el diff de versiones o el contexto del follow-up. Disparador: si para el 2026-12-02 (4 semanas) no hay lector, se quita saveDom, su llamada en preview-viewport.ts y este archivo.
export function saveDom(dir: string, viewport: number, html: string): string {
  mkdirSync(dir, { recursive: true });
  const body = Buffer.byteLength(html) > MAX_DOM_BYTES ? `${Buffer.from(html).subarray(0, MAX_DOM_BYTES).toString('utf8')}\n<!-- cortado: el DOM pasaba de ${MAX_DOM_BYTES} bytes -->\n` : html;
  const file = join(dir, `dom@${viewport}.html`);
  writeFileSync(file, body);
  // Una vez por versión: el store de artefactos (dom + texts) no tiene otro guardián desde que se revirtió preserve.visual.
  pruneVersions(dir);
  return file;
}
