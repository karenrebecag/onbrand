// Paso de imagen del motor (RE-imagen-producto §5): como v0, la imagen de producto se genera ANTES de
// componer, una por página, y las secciones la reciben como dato (un asset con id), no como una tool del
// infer de sección. Así corre igual con el provider cli y con el gateway, y el modelo no puede citar URLs.

import { generateImage } from 'ai';
import { claudeCodeInferFree } from './infer';
import { httpFetch, isAssetUrl, type Fetcher } from './assets';
import type { PageAsset } from './layout';
import type { EventLog } from './events';
import { brandFactsLines, type BrandFacts } from '../brand-facts';
import { config, type ImageProvider } from '../config';

/** Tamaño ~1,6:1, el de la captura de producto de v0 (1312x816), en múltiplos de 16 como pide flux. */
export const PRODUCT_IMAGE = { width: 1344, height: 832 } as const;
export const DEFAULT_IMAGE_MODEL = 'bfl/flux-3-image-klein';
export const PRODUCT_ASSET_ID = 'product';

/** `signal`: la corrida que la pidió; al detenerse corta la llamada al proveedor (auditoría #6). */
export type ImageGen = (prompt: string, size: { width: number; height: number }, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mediaType: string }>;
/** Proveedor del paso de imagen, de config(): `none` en el core (un clon no tiene cuenta de imágenes),
 * `profile` (el puerto `image` del perfil; el `cli` de abajo es su generador de ATOM por `claude -p`) o `gateway` (deploy). */
export const imageProvider = (): ImageProvider => config().imageProvider;

/** Si el arranque ofrece modelos de imagen. Con `none` no hay paso de imagen aunque llegue `--images`: sin
 * modelos el builder no manda imageGeneration y el composer no genera. */
/** El generador por defecto del proveedor; `none` no genera aunque un cliente mande un modelo. */
/** `profile` no tiene generador por defecto: sale del puerto `image` que serve.ts pasa al composer. Caer al CLI gastaría la cuenta de ATOM de la máquina. */
export const defaultImageGen = (model: string | undefined, provider: ImageProvider = imageProvider()): ImageGen | undefined =>
  provider === 'gateway' ? gatewayImageGen(model) : undefined;

export const imagesEnabled = (provider: ImageProvider, requested: boolean): boolean => provider !== 'none' && requested;
type Infer = (system: string, userJson: string, signal?: AbortSignal) => Promise<unknown>;

/** Generador real: AI Gateway con la key/OIDC del entorno, con el modelo que eligió el builder
 * (imageGeneration.modelId, validado por el transport contra /image-models). */
export const gatewayImageGen = (model: string = DEFAULT_IMAGE_MODEL): ImageGen => async (prompt, { width, height }, signal) => {
  // generateImage acepta abortSignal (ai dist/index.d.ts:7031): sin él un Stop no cortaba la imagen y se cobraba igual.
  const { image } = await generateImage({ model, prompt, size: `${width}x${height}`, maxRetries: 1, ...(signal ? { abortSignal: signal } : {}) });
  return { bytes: image.uint8Array, mediaType: image.mediaType };
};

const CLI_IMAGE_TOOL = 'mcp__atom-knowledge__atom_generate_image';
// Mismo nombre y URL que el servidor del usuario: el CLI reusa su login OAuth guardado (verificado con el CLI 2.1.316:
// init con status "connected" y la tool atom_generate_image a la vista, sin cabeceras ni token en la config).
export const CLI_IMAGE_MCP = { 'atom-knowledge': { type: 'http', url: 'https://knowledgemcp.atomchat.io/mcp' } } as const;
const CLI_IMAGE_SYSTEM = `Llama la tool atom_generate_image UNA vez con el prompt que te pasan tal cual y size "landscape_16_9". Devuelve SOLO JSON: {"imageUrl":"<la URL que devolvió la tool>"}. Si la tool falla o no devuelve URL, devuelve {"imageUrl":null,"error":"<el mensaje de la tool, literal>"}. No generes más de una imagen ni reintentes.`;

/** Generador local: `claude -p` con la tool MCP de atom-knowledge (cupo diario de 10 por persona). Solo
 * se baja una URL del CDN del proveedor (isAssetUrl), nunca una que el modelo invente. */
export const cliImageGen = (fetcher: Fetcher = httpFetch, infer: Infer = claudeCodeInferFree({ allowedTools: [CLI_IMAGE_TOOL], mcpServers: CLI_IMAGE_MCP })): ImageGen => async (prompt, _size, signal) => {
  const out = (await infer(CLI_IMAGE_SYSTEM, JSON.stringify({ prompt }), signal)) as { imageUrl?: unknown; error?: unknown } | null;
  const url = typeof out?.imageUrl === 'string' ? out.imageUrl : '';
  // El motivo de la tool (tope diario de 10, proveedor caído) viaja al paso en rojo: sin esto, QA final3/4
  // solo vio "URL vacía" en 9 peticiones y no pudo distinguir cuota de fallo del composer.
  const reason = typeof out?.error === 'string' && out.error.trim() ? `: ${out.error.trim().slice(0, 300)}` : '';
  if (!isAssetUrl(url)) throw new Error(`la tool de imagen no devolvió una URL del proveedor (${url || 'vacía'})${reason}`);
  const { contentType, body } = await fetcher(url);
  return { bytes: new Uint8Array(body), mediaType: contentType };
};

/** Ancho y alto reales de un PNG o JPEG; el proveedor cli no deja elegir el tamaño exacto. */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b.length >= 24) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      // SOF0..SOF15 salvo DHT (c4), JPG (c8) y DAC (cc): ahí van alto y ancho.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
  }
  return undefined;
}

// gen Karen 999ea0e0 y fac2bce5: flux desenfoca siempre una interfaz densa (con barras "soft" y con "sharp focus, flat
// bars" por igual). La imagen es una foto del producto en uso, donde la pantalla ocupa poco del encuadre; el mockup de
// interfaz lo arma el agente con componentes del DS.
const IMAGE_PLAN_SYSTEM = `Decides la imagen de producto de una landing, como un director de arte. Devuelve SOLO JSON:
{"prompt":"<en inglés: una fotografía editorial de una persona del público del negocio usando el producto en su contexto de trabajo; el teléfono o la pantalla se ve pero ocupa menos de un cuarto del encuadre y no muestra texto legible; termina SIEMPRE con: editorial photograph, natural light, sharp focus on the person and the device, no readable text, no logo, no UI close-up, restrained palette>","alt":"<en el idioma indicado: qué muestra la imagen, en una frase, sin 'imagen de'>","file":"<kebab-case, 2-4 palabras: marca-y-qué-muestra>"}
La imagen es la pieza visual del hero: el producto en uso por su público, no una foto de banco genérica ni una captura de interfaz.
No inventes un negocio concreto: ni nombre, ni rubro (una tienda de pinturas, una clínica), ni ciudad o país. El alt llega al agente
que escribe la página y lo que dice termina en el copy como si fuera un cliente real. Si "hechos" trae clientes o canales, el
contexto sale de ahí; si no, la escena es el puesto de trabajo del público, sin más detalle del que da el brief.`;

const FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;

export interface ImagePlan {
  prompt: string;
  alt: string;
  file: string;
}

/** Valida la salida del modelo. Un nombre que no es kebab-case cae a `product`, nunca a una ruta. */
export function parseImagePlan(raw: unknown): ImagePlan | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
  const alt = typeof o.alt === 'string' ? o.alt.trim() : '';
  if (!prompt || !alt) return undefined;
  const file = typeof o.file === 'string' && FILE_RE.test(o.file.trim()) ? o.file.trim() : 'product';
  return { prompt, alt, file };
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Corre el paso: plan de la imagen (1 infer) + generación (1 imagen). Si algo falla, el paso termina en
 * error visible y la página se compone sin imagen; nunca tumba la corrida. */
export async function productImageStep(
  infer: Infer,
  // `id` distinto de 'product' para una imagen pedida en un follow-up (una por sección); el archivo lleva el id de prefijo.
  input: { brief: string; lang: string; heroObjective?: string; id?: string; facts?: BrandFacts },
  log: EventLog,
  stepId: string,
  gen: ImageGen | undefined = imageProvider() === 'gateway' ? gatewayImageGen() : undefined,
): Promise<PageAsset | undefined> {
  log.emit({ type: 'step.start', stepId, kind: 'action', label: 'Generando imagen de producto' });
  try {
    if (!gen) throw new Error('no hay generador de imágenes: WT_IMAGE_PROVIDER es none o profile sin servicio');
    const plan = parseImagePlan(await infer(IMAGE_PLAN_SYSTEM, JSON.stringify({ brief: input.brief, idioma: input.lang, ...(input.heroObjective ? { hero: input.heroObjective } : {}), ...(input.facts ? { hechos: brandFactsLines(input.facts) } : {}) })));
    if (!plan) throw new Error('el plan de la imagen volvió sin prompt o sin alt');
    const { bytes, mediaType } = await gen(plan.prompt, PRODUCT_IMAGE);
    const ext = EXT[mediaType];
    if (!ext) throw new Error(`el generador devolvió ${mediaType || 'sin tipo'}, no una imagen aceptada`);
    const asset: PageAsset = {
      id: input.id ?? PRODUCT_ASSET_ID, file: `${input.id ? `${input.id}-` : ''}${plan.file}.${ext}`, alt: plan.alt, ...(imageSize(bytes) ?? PRODUCT_IMAGE), mediaType,
      base64: Buffer.from(bytes).toString('base64'), prompt: plan.prompt,
    };
    log.emit({ type: 'step.end', stepId, label: 'Generó imagen de producto', status: 'ok', detail: { kind: 'action', name: 'image', summary: `public/images/${asset.file}` } });
    return asset;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.emit({ type: 'step.end', stepId, label: 'Sin imagen de producto', status: 'error', error: { type: 'image', message } });
    return undefined;
  }
}
