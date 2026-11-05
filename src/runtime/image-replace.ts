// Cambiar imagen de Stitch sobre el código de la página (re-iteracion/stitch-ui/dinamico-rail.md, Direct Edit: Cambiar
// imagen; static-editor.md §2.6): Stitch cambia el src en el iframe (`direct_edit_replace`) y guarda el HTML entero.
// Aquí la imagen se ubica en el TSX por su src, igual que en Eliminar, y solo se reescribe ese literal: un src que sale
// de un import o de datos no está escrito tal cual y va a Editar con IA.

import { sameSrc, stringValue } from './element-delete';

type Ts = typeof import('typescript');
type Node = import('typescript').Node;

export type ReplaceImageResult =
  | { ok: true; path: string; source: string }
  | { ok: false; reason: 'invalid' | 'unsafe' | 'not-found' | 'ambiguous'; message: string };

const MAX_SRC_CHARS = 2000;
// El src nuevo va dentro de un literal: comillas, \, ` y llaves lo cerrarían o abrirían una expresión, y un espacio no
// es parte de una URL.
const UNSAFE_SRC = /["'\\`{}<>\s]/;

/** Lo que se acepta como src nuevo: una URL https, como el Enter URL de Stitch, o un archivo subido a public/uploads. Sin
 * http: la página publicada va por https y el navegador bloquea la imagen sin avisar (mixed content). */
export function validImageSrc(src: string): boolean {
  if (!src || src.length > MAX_SRC_CHARS || UNSAFE_SRC.test(src)) return false;
  if (/^\/uploads\/[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(src)) return true;
  try {
    const url = new URL(src);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface Hit { path: string; source: string; literal: Node; hasSrcSet: boolean }

function hitsIn(ts: Ts, path: string, source: string, src: string): Hit[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Hit[] = [];
  const visit = (n: Node): void => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      const attrs = n.attributes.properties.filter(ts.isJsxAttribute);
      const attr = attrs.find((p) => p.name.getText(sf) === 'src');
      const value = attr ? stringValue(ts, attr.initializer) : null;
      if (attr?.initializer && value !== null && sameSrc(value, src)) {
        const literal = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression! : attr.initializer;
        out.push({ path, source, literal, hasSrcSet: attrs.some((p) => p.name.getText(sf) === 'srcSet') });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Cambia el src de la única imagen del código cuyo src es `src` (el del DOM, absoluto) por `newSrc`. */
export function replaceImage(ts: Ts, files: Readonly<Record<string, string>>, src: string, newSrc: string): ReplaceImageResult {
  if (!src.trim() || src.length > MAX_SRC_CHARS) return { ok: false, reason: 'invalid', message: `la imagen se identifica con 1 a ${MAX_SRC_CHARS} caracteres` };
  if (!validImageSrc(newSrc)) return { ok: false, reason: 'invalid', message: newSrc.startsWith('http:') ? 'usa una URL https: la página publicada va por https y una imagen http no se vería' : 'la imagen nueva tiene que ser una URL https o un archivo subido' };
  const hits = Object.entries(files).flatMap(([path, source]) => hitsIn(ts, path, source, src));
  if (hits.length === 0) return { ok: false, reason: 'not-found', message: 'la imagen no está escrita tal cual en el código (puede salir de un import o de datos): usa Editar con IA' };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', message: `la imagen aparece ${hits.length} veces en la página: usa Editar con IA para decir cuál` };
  const { path, source, literal, hasSrcSet } = hits[0]!;
  // Con srcSet el navegador elige de esa lista: cambiar solo el src no cambiaría lo que se ve.
  if (hasSrcSet) return { ok: false, reason: 'unsafe', message: 'la imagen tiene srcSet, que manda sobre el src: usa Editar con IA' };
  const start = literal.getStart();
  const quote = source[start]!;
  return { ok: true, path, source: source.slice(0, start) + quote + newSrc + quote + source.slice(literal.getEnd()) };
}

// Sin SVG: copiado a public/ sin los headers del store (nosniff, CSP sandbox), abrirlo directo ejecutaría su <script>
// en el origen de la página.
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** El tipo declarado tiene que coincidir con los primeros bytes, como placeImage con los adjuntos. */
export function bytesMatchType(contentType: string, body: Uint8Array): boolean {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => body[at + i] === b);
  if (contentType === 'image/png') return starts([0x89, 0x50, 0x4e, 0x47]);
  if (contentType === 'image/jpeg') return starts([0xff, 0xd8, 0xff]);
  if (contentType === 'image/gif') return starts([0x47, 0x49, 0x46, 0x38]);
  if (contentType === 'image/webp') return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  return false;
}

/** Dónde queda un archivo subido dentro del workspace, con el nombre que le da Stitch (`uploads/<slug>-<6hex><ext>`,
 * useImageUploadNotice): el hash corto hace que dos subidas iguales caigan en el mismo archivo y dos distintas no se
 * pisen. Null si no es una imagen. */
export function uploadedImagePath(name: string, contentType: string, sha256Hex: string): { file: string; src: string } | null {
  const ext = IMAGE_EXT[contentType];
  if (!ext) return null;
  const slug = name.replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  const src = `/uploads/${slug}-${sha256Hex.slice(0, 6)}.${ext}`;
  return { file: `public${src}`, src };
}
