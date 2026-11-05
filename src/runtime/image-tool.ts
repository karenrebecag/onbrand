// La imagen como tool del agente, como Lovable: `imagegen--generate_image` es una tool que el modelo llama cuando la
// página la necesita (transport/lovable/deob/registry-CmMIU-Jy/deobfuscated.js:4836-4866, webcrack), con `prompt`
// (MediaGenerationApprovalCard-HXgdcROo/deobfuscated.js:153). `target_path` lo lee el cliente en `edit_image`
// (lovable-details/deob/app-lazy-shared-CKknmzHJ.deob.js:21603); en `generate_image` solo está en tráfico, así que se
// toma el mismo contrato (hueco declarado). Adaptación: Lovable escribe en src/assets y lo importa; aquí va siempre a
// public/images y se usa como src string, porque un import a un archivo que todavía no existe rompe el render
// incremental (S1). Modelo y tamaño no tienen extract: van por el provider en uso (AI Gateway, `generateImage`, que
// devuelve `mediaType` png, jpeg o webp por imagen: https://vercel.com/docs/ai-gateway/modalities/image-generation/ai-sdk,
// "Save generated images from image-only models").

import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { generateImage, gateway } from 'ai';
import type { ImageModelV4 } from '@ai-sdk/provider';
import { dirname, join } from 'node:path';
import { bytesMatchType } from './image-replace';
import { DEFAULT_IMAGE_MODEL, imageSize, PRODUCT_IMAGE, type ImageGen } from './image-step';

/** Solo rutas que sirve public/ en su raíz: sin `..` ni subcarpetas. */
export const IMAGE_SRC_RE = /^\/images\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/i;

export const IMAGE_TOOL = 'generate_image';
export const EDIT_IMAGE_TOOL = 'edit_image';
const MAX_PROMPT = 1500;
/** Tope de lo que edit_image manda al modelo: una imagen de public/images, no un archivo cualquiera. */
const MAX_EDIT_INPUT = 10 * 1024 * 1024;

/** Ruta absoluta de /images/<nombre> dentro del workspace, o null si public/images o el archivo son un symlink. La
 * regex de IMAGE_SRC_RE ya descarta `..` y subcarpetas, pero readFileSync y writeFileSync siguen un symlink: uno en
 * public/images leería (y mandaría al proveedor) o pisaría un archivo de fuera del workspace (writeShots hace la
 * misma comprobación para .wt/shots). */
/** Escribe con un temporal y rename: rename reemplaza un symlink puesto entre imageFileIn y la escritura en vez de
 * seguirlo (security-reviewer 2026-11-02, M3: estas tools corren ahora en el proceso del transport). */
function writeImage(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  renameSync(tmp, file);
}

export function imageFileIn(dir: string, src: string): string | null {
  const imagesDir = join(dir, 'public', 'images');
  try {
    mkdirSync(imagesDir, { recursive: true });
    if (realpathSync(imagesDir) !== join(realpathSync(dir), 'public', 'images')) return null;
    const file = join(dir, 'public', src);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

export const IMAGE_TOOL_DEF = {
  name: IMAGE_TOOL,
  description: 'Genera una imagen (foto de producto, retrato, escena) y la guarda en public/images. Llámala ANTES de escribir la sección que la usa: devuelve la ruta y en la sección la pones como src string (`<Image src="/images/<nombre>.jpg" …/>`), nunca con import. Una imagen por llamada; cada llamada gasta créditos, así que genera solo las que la página muestra. Si devuelve otra extensión, usa la ruta que te devuelve.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: MAX_PROMPT, description: 'qué muestra la imagen: sujeto, contexto, encuadre y luz; sin texto ni logos dentro de la imagen' },
      target_path: { type: 'string', description: 'ruta pública donde va, /images/<nombre-en-kebab>.jpg (también se acepta public/images/…)' },
    },
    required: ['prompt', 'target_path'],
    additionalProperties: false,
  },
};

// edit_image: tres modos por label en el cliente de Lovable (registry-CmMIU-Jy/deobfuscated.js:4867-4902: inpaint o
// mask_path, transparent_background, edición simple) y target_path del tool call (app-lazy-shared :21563-21603).
// Adaptación declarada: el schema de args vive en el servidor de Lovable, así que `image_path` (la imagen de origen) es
// nuestro nombre. transparent_background queda fuera: no hay extract ni doc estándar del provider. La llamada al modelo
// es la de AI SDK 7: generateImage con prompt {images, text, mask} (ai/docs/07-reference/01-ai-sdk-core/10-generate-image.mdx);
// antes se comprueba model.supportsFileInputs y, con máscara, supportsMaskInputs. Solo `false` rechaza: el doc pide tratar
// como confirmado únicamente `true` y dice que `undefined` es "unknown" (03-ai-sdk-core/35-image-generation.mdx:121-123),
// pero GatewayImageModel no declara ninguno de los dos (@ai-sdk/gateway 4.0.107, dist/index.js:1361), así que con el
// gateway, el único editor que tenemos, `!== true` dejaba edit_image siempre en error. QA en vivo de orq (2026-11-02):
// bfl/flux-3-image-klein y bfl/flux-kontext-pro responden undefined y editan bien. Si un modelo desconocido no edita, el
// catch del tool devuelve su error como texto. Hueco declarado: con máscara (inpaint) no hay prueba en vivo.
export const EDIT_IMAGE_DEF = {
  name: EDIT_IMAGE_TOOL,
  description: 'Edita una imagen que ya está en public/images (cambia un detalle, el fondo, el encuadre) en lugar de generar otra desde cero, y guarda el resultado en target_path. Úsala cuando la imagen es buena y solo falta un cambio; si hay que rehacerla, usa generate_image. Con mode "inpaint" y mask_path solo se cambia la zona de la máscara. Cada llamada gasta créditos. Devuelve la ruta; úsala como src string, sin import.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: MAX_PROMPT, description: 'qué cambiar, en inglés; sin texto ni logos dentro de la imagen' },
      image_path: { type: 'string', description: 'imagen de origen, /images/<nombre>.(jpg|png|webp)' },
      target_path: { type: 'string', description: 'dónde queda el resultado, /images/<nombre>.jpg; si es igual a image_path la reemplaza' },
      mode: { type: 'string', enum: ['inpaint'], description: 'inpaint: editar solo la zona de mask_path' },
      mask_path: { type: 'string', description: 'máscara en /images/…; con ella el modo es inpaint' },
    },
    required: ['prompt', 'image_path', 'target_path'],
    additionalProperties: false,
  },
};

export type EditImageRequest = { prompt: string; image: Uint8Array; mask?: Uint8Array; signal?: AbortSignal };
/** Edita una imagen. Lanza con el motivo si el modelo no declara soporte (ver gatewayImageEdit). */
export type ImageEdit = (req: EditImageRequest) => Promise<{ bytes: Uint8Array; mediaType: string }>;

/** Editor real: AI Gateway. Un modelo que declara `supportsFileInputs === false` (o `supportsMaskInputs === false` con
 * máscara) no se llama; `undefined` (desconocido) se intenta. Se pregunta en cada llamada: el modelo lo elige la persona. */
export const gatewayImageEdit = (modelId: string = DEFAULT_IMAGE_MODEL, model: Pick<ImageModelV4, 'supportsFileInputs' | 'supportsMaskInputs'> & ImageModelV4 = gateway.imageModel(modelId)): ImageEdit => async ({ prompt, image, mask, signal }) => {
  if ((await model.supportsFileInputs) === false) throw new Error(`${modelId} no soporta editar imágenes`);
  if (mask && (await model.supportsMaskInputs) === false) throw new Error(`${modelId} no soporta máscaras`);
  const { image: out } = await generateImage({ model, prompt: { images: [image], text: prompt, ...(mask ? { mask } : {}) }, maxRetries: 1, ...(signal ? { abortSignal: signal } : {}) });
  return { bytes: out.uint8Array, mediaType: out.mediaType };
};

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type ImageToolInput = { prompt: string; src: string };

/** `/images/x.jpg` o `public/images/x.jpg`, solo lo que sirve public/ (las mismas rutas que los slots). */
export function parseImageToolInput(input: unknown): { ok: true; value: ImageToolInput } | { ok: false; error: string } {
  const o = (input ?? {}) as { prompt?: unknown; target_path?: unknown };
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'generate_image: falta prompt' };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `generate_image: prompt de más de ${MAX_PROMPT} caracteres` };
  const raw = typeof o.target_path === 'string' ? o.target_path.trim() : '';
  const src = raw.startsWith('public/') ? raw.slice('public'.length) : raw;
  if (!IMAGE_SRC_RE.test(src)) return { ok: false, error: `generate_image: target_path tiene que ser /images/<nombre>.(jpg|png|webp), no "${raw}"` };
  return { ok: true, value: { prompt, src } };
}

/** Genera y escribe la imagen; el resultado es solo texto con la ruta, la imagen no vuelve al contexto (vision.ts). */
export async function runImageTool(dir: string, input: unknown, gen: ImageGen, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parsed = parseImageToolInput(input);
  if (!parsed.ok) return parsed;
  const { prompt, src } = parsed.value;
  let out: Awaited<ReturnType<ImageGen>>;
  try {
    out = await gen(prompt, PRODUCT_IMAGE, signal);
  } catch (e) {
    return { ok: false, error: `generate_image: el generador falló (${e instanceof Error ? e.message : String(e)}). Sigue sin imagen: esa sección muestra el producto en código y no escribas src="${src}", que no existe.` };
  }
  const { bytes, mediaType } = out;
  const ext = EXT[mediaType];
  if (!ext || !bytesMatchType(mediaType, bytes)) return { ok: false, error: `generate_image: el generador devolvió ${mediaType || 'un tipo vacío'} que no es una imagen válida` };
  // El provider decide el formato: la ruta cambia de extensión en vez de servir un PNG con nombre .jpg.
  const finalSrc = src.replace(/\.(png|jpe?g|webp)$/i, `.${ext}`);
  const file = imageFileIn(dir, finalSrc);
  if (!file) return { ok: false, error: `generate_image: ${finalSrc} no es un archivo regular dentro de public/images` };
  mkdirSync(dirname(file), { recursive: true });
  const replaced = existsSync(file);
  writeImage(file, bytes);
  const size = imageSize(bytes);
  const dims = size ? ` (${size.width}×${size.height})` : '';
  const moved = finalSrc !== src ? ` El generador devolvió ${ext}, así que la ruta es ${finalSrc} y no ${src}.` : '';
  return { ok: true, text: `Imagen ${replaced ? 'reemplazada' : 'guardada'} en ${finalSrc}${dims}.${moved} Úsala como src="${finalSrc}", sin import.` };
}

export type EditImageToolInput = { prompt: string; image: string; src: string; mask?: string };

function publicSrc(v: unknown): string {
  const raw = typeof v === 'string' ? v.trim() : '';
  return raw.startsWith('public/') ? raw.slice('public'.length) : raw;
}

export function parseEditImageInput(input: unknown): { ok: true; value: EditImageToolInput } | { ok: false; error: string } {
  const o = (input ?? {}) as { prompt?: unknown; image_path?: unknown; target_path?: unknown; mode?: unknown; mask_path?: unknown };
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  if (!prompt) return { ok: false, error: 'edit_image: falta prompt' };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `edit_image: prompt de más de ${MAX_PROMPT} caracteres` };
  const image = publicSrc(o.image_path), src = publicSrc(o.target_path);
  if (!IMAGE_SRC_RE.test(image)) return { ok: false, error: `edit_image: image_path tiene que ser /images/<nombre>.(jpg|png|webp), no "${String(o.image_path ?? '')}"` };
  if (!IMAGE_SRC_RE.test(src)) return { ok: false, error: `edit_image: target_path tiene que ser /images/<nombre>.(jpg|png|webp), no "${String(o.target_path ?? '')}"` };
  if (o.mode !== undefined && o.mode !== 'inpaint') return { ok: false, error: 'edit_image: mode solo admite "inpaint"' };
  const mask = o.mask_path === undefined ? undefined : publicSrc(o.mask_path);
  if (mask !== undefined && !IMAGE_SRC_RE.test(mask)) return { ok: false, error: `edit_image: mask_path tiene que ser /images/<nombre>.(jpg|png|webp), no "${String(o.mask_path)}"` };
  if (o.mode === 'inpaint' && !mask) return { ok: false, error: 'edit_image: mode inpaint pide mask_path' };
  return { ok: true, value: { prompt, image, src, ...(mask ? { mask } : {}) } };
}

/** Edita y escribe la imagen; solo texto con la ruta, nunca un bloque image (vision.ts). Un fallo del editor deja la
 * misma marca que generate_image: el composer no corre los slots contra el mismo fallo. */
export async function runEditImageTool(dir: string, input: unknown, edit: ImageEdit, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parsed = parseEditImageInput(input);
  if (!parsed.ok) return parsed;
  const { prompt, image, src, mask } = parsed.value;
  // Solo bytes que sean una imagen del tamaño de una imagen: lo que se lee sale hacia el proveedor del modelo.
  const read = (rel: string): Uint8Array | undefined => {
    const file = imageFileIn(dir, rel);
    if (!file || !existsSync(file)) return undefined;
    let bytes: Uint8Array;
    // O_NOFOLLOW: un symlink puesto entre imageFileIn y la lectura falla en vez de mandar otro archivo al proveedor.
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { bytes = new Uint8Array(readFileSync(fd)); } finally { closeSync(fd); }
    } catch {
      return undefined;
    }
    const type = rel.toLowerCase().endsWith('.png') ? 'image/png' : rel.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return bytes.length <= MAX_EDIT_INPUT && bytesMatchType(type, bytes) ? bytes : undefined;
  };
  const bytesIn = read(image);
  if (!bytesIn) return { ok: false, error: `edit_image: ${image} no existe en public/images o no es una imagen válida` };
  const maskIn = mask ? read(mask) : undefined;
  if (mask && !maskIn) return { ok: false, error: `edit_image: ${mask} no existe en public/images o no es una imagen válida` };
  let out: Awaited<ReturnType<ImageEdit>>;
  try {
    out = await edit({ prompt, image: bytesIn, ...(maskIn ? { mask: maskIn } : {}), ...(signal ? { signal } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `edit_image: no se pudo editar (${msg}). Deja la imagen como está o usa generate_image.` };
  }
  const { bytes, mediaType } = out;
  const ext = EXT[mediaType];
  if (!ext || !bytesMatchType(mediaType, bytes)) return { ok: false, error: `edit_image: el editor devolvió ${mediaType || 'un tipo vacío'} que no es una imagen válida` };
  const finalSrc = src.replace(/\.(png|jpe?g|webp)$/i, `.${ext}`);
  const file = imageFileIn(dir, finalSrc);
  if (!file) return { ok: false, error: `edit_image: ${finalSrc} no es un archivo regular dentro de public/images` };
  mkdirSync(dirname(file), { recursive: true });
  const replaced = existsSync(file);
  writeImage(file, bytes);
  const size = imageSize(bytes);
  const dims = size ? ` (${size.width}×${size.height})` : '';
  const moved = finalSrc !== src ? ` El editor devolvió ${ext}, así que la ruta es ${finalSrc} y no ${src}.` : '';
  return { ok: true, text: `Imagen ${replaced ? 'reemplazada' : 'guardada'} en ${finalSrc}${dims}.${moved} Úsala como src="${finalSrc}", sin import.` };
}
