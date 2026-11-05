// Handlers HTTP del transport que no tocan el ciclo de una corrida: enhancer de prompt, conectores, uploads, dictado y
// lienzo. Son la capa `api.*` que los referentes separan del runtime (f3-audit TRANSVERSAL:mantenibilidad-transport);
// el router (Runtime.handle) solo despacha a ellos. Paso 2 de la modularización de transport.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { boundedSignal, OPTIONAL_TIMEOUT_MS } from './infer';
import { APP_SLUG, type Connectors } from './connectors';
import { readRaw, type UploadStore } from './uploads';
import { isCanvasImageType, MAX_CANVAS_BODY, MAX_CANVAS_IMAGE, readCanvas, readCanvasFile, saveCanvasFile, writeCanvas } from './canvas-store';
import { enhancerInput, enhancerStream, type TextStream } from './prompt-enhancer';
import { HttpError, json, readBody } from './http';

/** El enhancer recibe un brief corto (Stitch lo usa con el prompt del input); el tope evita mandar un documento entero. */
const MAX_ENHANCE_PROMPT = 4000;
/** Cada enhancer es una llamada de streaming que gasta la key del servidor; el cliente manda uno a la vez, pero el servidor no
 * puede fiarse de eso (seguridad-ronda H2). */
const MAX_ENHANCING = 2;

/** Tope del audio de dictado: Whisper y el endpoint de transcripción de AI Gateway cortan en 25 MB. */
const MAX_TRANSCRIBE_AUDIO = 25 * 1024 * 1024;
/** Transcripciones a la vez: cada una retiene ~100 MB de buffers y gasta la key del Gateway. Mismo límite que el
 * enhancer (MAX_ENHANCING); el cliente manda una a la vez, pero el servidor no se fía de eso (seguridad). */
const MAX_TRANSCRIBING = 2;
/** El multipart trae boundary y headers por parte además del audio. */
const TRANSCRIBE_OVERHEAD = 64 * 1024;
/** Lo que graba el MediaRecorder del builder (webm/mp4) más los contenedores que Whisper acepta; el tipo lo declara el
 * cliente, así que se valida contra esta lista antes de gastar la transcripción. */
const TRANSCRIBE_TYPES = new Set([
  'audio/webm', 'video/webm', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/m4a', 'audio/x-m4a',
]);

export type Transcriber = (audio: Uint8Array, type: string) => Promise<string>;

/** Lo que estos handlers necesitan del transport: las opciones inyectables y el store de uploads. Nada del índice ni de
 * las corridas; el lienzo recibe el directorio del chat ya resuelto. */
export interface ApiHandlerDeps {
  enhance?: TextStream;
  enhanceTimeoutMs?: number;
  connectors?: Connectors;
  transcribe?: Transcriber;
  uploads: UploadStore;
  /** El workspace del chat raíz, o lanza el HttpError que corresponda (404 si no es raíz). */
  canvasDir: (chatId: string) => string;
}

export class ApiHandlers {
  /** POST /prompt-enhancements {prompt}: el texto del enhancer en chunks de text/plain, como el stream que consume
   * usePromptPreview (:44-89, acumula cada chunk) y entrega PostMessageClient :919-928. Si el cliente corta, se aborta la
   * petición al modelo: el "cancel" de Stitch es el abort del mismo stream. Uno a la vez lo garantiza el cliente
   * (createEnhancer), como en Stitch. */
  private enhancing = 0;
  /** POST /transcribe: dictado del builder, multipart con el campo `file`. Sin proveedor inyectado (core) es un 501
   * explícito, no la ruta desconocida ni el 415 del guard: el builder no monta el micrófono (capabilities.transcribe),
   * así que esto solo lo alcanza una llamada directa. El audio es input externo: se valida tipo y tamaño antes de
   * procesarlo. */
  private transcribing = 0;

  constructor(private deps: ApiHandlerDeps) {}

  async enhancePrompt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { prompt } = ((await readBody(req)) ?? {}) as { prompt?: unknown };
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'prompt debe ser un texto no vacío');
    if (prompt.length > MAX_ENHANCE_PROMPT) throw new HttpError(400, `prompt de más de ${MAX_ENHANCE_PROMPT} caracteres`);
    if (this.enhancing >= MAX_ENHANCING) throw new HttpError(429, 'ya hay un enhancer en curso');
    let stream: TextStream;
    try {
      stream = this.deps.enhance ?? enhancerStream();
    } catch (e) {
      throw new HttpError(503, e instanceof Error ? e.message : String(e));
    }
    const ctrl = new AbortController();
    // HACK: en Bun 1.3.14 (CI ya corre 1.4.4, sin re-medir aquí), con el body ya leído, el corte del cliente no emite nada en req, res ni socket (medido en
    // local); el stream sigue hasta MAX_ENHANCED_TOKENS (1024) y se descarta. En Node, res 'close' lo aborta. Cuando el
    // gasto del enhancer cuente, o al próximo bun upgrade que Karen haga (re-medir ahí), cortar por un evento de Bun en vez de terminar el stream.
    req.on('aborted', () => ctrl.abort());
    res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
    this.enhancing++;
    try {
      const chunks = stream(enhancerInput(prompt), boundedSignal(this.deps.enhanceTimeoutMs ?? OPTIONAL_TIMEOUT_MS, ctrl.signal))[Symbol.asyncIterator]();
      // Mejorar el prompt es opcional: si el modelo falla o no llega a tiempo antes del primer chunk, vuelve el prompt tal
      // cual (marcado en x-enhancer) en vez de un 500 que el builder mostraría como error del producto.
      let first: IteratorResult<string>;
      try {
        first = await chunks.next();
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        console.warn(`[enhancer] sin mejora, vuelve el prompt original: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-enhancer': 'fallback' });
        return void res.end(prompt);
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      if (!first.done) res.write(first.value);
      for (let c = await chunks.next(); !c.done && !ctrl.signal.aborted; c = await chunks.next()) res.write(c.value);
      res.end();
    } finally {
      this.enhancing--;
    }
  }

  async connectors(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<void> {
    const c = this.deps.connectors;
    // Mismo contrato que el orquestador sin proveedor (orchestrator/routes.ts): 501 con code connectors-unavailable, para que
    // el cliente lea un solo caso (run-client.ts) y no distinga "no hay reenvío" (404) de "no hay proveedor".
    if (!c) throw new HttpError(501, 'conectores no configurados', { code: 'connectors-unavailable' });
    const route = `${req.method} ${parts.slice(1).join('/')}`;
    if (route === 'GET apps') {
      const q = (url.searchParams.get('q') ?? '').slice(0, 100);
      const after = (url.searchParams.get('after') ?? '').slice(0, 200);
      const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
      return json(res, 200, await c.apps(q, after, limit));
    }
    if (route === 'GET accounts') return json(res, 200, { accounts: await c.accounts() });
    if (route === 'POST connect') {
      const { app } = ((await readBody(req)) ?? {}) as { app?: unknown };
      if (typeof app !== 'string' || !APP_SLUG.test(app)) throw new HttpError(400, 'app debe ser un slug');
      return json(res, 200, await c.connect(app));
    }
    if (route === 'DELETE accounts') {
      const id = url.searchParams.get('id') ?? '';
      if (!(await c.disconnect(id))) throw new HttpError(404, 'no hay esa cuenta');
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'ruta desconocida');
  }

  /** Lienzo del chat (nodos libres del rail, canvas-store.ts): `:chatId` es el mensaje raíz, que nombra el workspace. */
  async canvas(req: IncomingMessage, res: ServerResponse, parts: string[], url: URL): Promise<void> {
    let chatId: string;
    try { chatId = decodeURIComponent(parts[1] ?? ''); } catch { throw new HttpError(400, 'chatId inválido'); }
    const dir = this.deps.canvasDir(chatId);
    const route = `${req.method} ${parts.slice(3).join('/')}`;
    if (route === 'GET ') return json(res, 200, readCanvas(dir, chatId));
    if (route === 'PUT ') return json(res, 200, writeCanvas(dir, chatId, await readBody(req, MAX_CANVAS_BODY)));
    if (route === 'POST files') {
      const name = (url.searchParams.get('name') ?? '').slice(0, 200);
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      // Tipo y tamaño declarados se rechazan sin leer el cuerpo; connection: close corta el resto de la subida.
      if (!isCanvasImageType(type)) { res.setHeader('connection', 'close'); throw new HttpError(415, 'solo PNG, JPEG, WebP o GIF'); }
      if (Number(req.headers['content-length'] ?? 0) > MAX_CANVAS_IMAGE) { res.setHeader('connection', 'close'); throw new HttpError(413, 'la imagen pasa de 20 MB'); }
      return json(res, 201, saveCanvasFile(dir, chatId, name, type, await readRaw(req, MAX_CANVAS_IMAGE)));
    }
    if (req.method === 'GET' && parts.length === 5 && parts[3] === 'files') {
      let file: string;
      try { file = decodeURIComponent(parts[4]!); } catch { throw new HttpError(404, 'no hay ese archivo'); }
      const hit = readCanvasFile(dir, file);
      if (!hit) throw new HttpError(404, 'no hay ese archivo');
      // El nombre lleva el hash del contenido: un archivo no cambia nunca. nosniff y sandbox: nunca se ejecuta.
      res.writeHead(200, { 'content-type': hit.contentType, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-site' });
      return void res.end(hit.body);
    }
    throw new HttpError(405, 'método no permitido');
  }

  async uploads(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    if (req.method === 'POST' && parts.length === 1) return json(res, 201, await this.deps.uploads.accept(req));
    if (req.method === 'GET' && parts.length === 2) {
      // HACK: un upload no tiene dueño; su id aleatorio es la capability. Atarlo al chat cuando haya créditos o chats compartidos.
      const hit = this.deps.uploads.read(parts[1]);
      if (!hit) throw new HttpError(404, 'no hay ese upload');
      // nosniff: un upload se sirve con el tipo declarado, nunca como HTML que el navegador ejecute.
      res.writeHead(200, { 'content-type': hit.contentType, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
      return void res.end(hit.body);
    }
    throw new HttpError(405, 'método no permitido');
  }

  async transcribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transcribe = this.deps.transcribe;
    if (!transcribe) throw new HttpError(501, 'este transport no transcribe audio');
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('multipart/form-data')) throw new HttpError(415, 'se espera multipart/form-data');
    // Antes de retener el buffer: N clips de 25 MB en paralelo son memoria y gasto del Gateway sin tope.
    if (this.transcribing >= MAX_TRANSCRIBING) throw new HttpError(429, 'ya hay una transcripción en curso');
    this.transcribing++;
    try {
      const raw = await readRaw(req, MAX_TRANSCRIBE_AUDIO + TRANSCRIBE_OVERHEAD);
      const form = await new Request('http://127.0.0.1/transcribe', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData()
        .catch(() => { throw new HttpError(400, 'multipart inválido'); });
      const file = form.get('file');
      if (!(file instanceof Blob)) throw new HttpError(400, 'falta el campo file');
      const audioType = file.type.split(';')[0]!.trim().toLowerCase();
      if (!TRANSCRIBE_TYPES.has(audioType)) throw new HttpError(415, `tipo de audio no aceptado "${audioType}"`);
      if (file.size === 0) throw new HttpError(400, 'audio vacío');
      if (file.size > MAX_TRANSCRIBE_AUDIO) throw new HttpError(413, 'audio demasiado grande');
      const text = await transcribe(new Uint8Array(await file.arrayBuffer()), audioType);
      return json(res, 200, { text });
    } finally {
      this.transcribing--;
    }
  }
}
