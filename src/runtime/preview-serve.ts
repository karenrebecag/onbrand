// El listener de la url estable (R5.5): un net.createServer (TCP crudo) en su PROPIO puerto, aparte de la API del
// transport. Da a cada ws su propio ORIGEN — `http://<ws>.localhost:<previewPort>/` — ruteando por el `Host`, igual que
// los referentes (Lovable `id-preview--<uuid>.lovable.app`, v0 `vm-<slug>.vusercontent.net`;
// re-iteracion/re-transport-robustez/zap-api-origen.md). Con origen propio por ws, la página generada (no confiable: la
// escribe el agente) no comparte DOM, storage ni fetch same-origin con la API del transport, con el builder, ni con otro
// ws. El ruteo por Host con HMR por WebSocket está verificado end-to-end (vite sirve el Host, acepta el upgrade y entrega
// el hot update; re-iteracion/re-transport-robustez/host-por-ws-experimento.md).
//
// Por qué TCP crudo y no http.Server: bajo bun (medido en 1.3.14; re-medir cuando Karen haga bun upgrade) el socket del evento 'upgrade' de node:http no lee ni escribe
// (VERIFIED, scratchpad), así que un proxy WS con http.Server no relaya el HMR.
//
// Por qué por request y no pipe puro: el navegador reusa la conexión keep-alive del mismo origen; aunque cada ws tiene su
// host, un cliente podría encauzar varias peticiones por un socket. Cada petición HTTP se rutea por su propia línea al
// vite de SU Host; solo el upgrade, una conexión dedicada, va por pipe.

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { PreviewPool } from './preview';
import { verifyPreview, type PreviewKey } from './preview-token';

// Un ws es una etiqueta DNS: minúsculas, dígitos y guion, hasta 63 (RFC 1035 §2.3.4). El Host llega en minúsculas y los
// ids son hex de randomUUID. La validez contra el índice la aplica resolve.dirFor (patrón + índice) antes de tocar disco.
const WS_ID = /^[a-z0-9-]{1,63}$/;

/** Deriva el ws de un `Host` que sea exactamente `<ws>.<baseHost>` (R5.5 #1), donde baseHost es el host:port del
 *  previewOrigin (el mismo que arma stableUrl). Cualquier otro Host → undefined → 421. El transport lo construye con el
 *  host de su previewOrigin. */
export function hostWsMatcher(baseHost: string): (hostHeader: string) => string | undefined {
  const esc = baseHost.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^([a-z0-9-]{1,63})\\.${esc}$`);
  return (hostHeader) => re.exec(hostHeader.toLowerCase())?.[1];
}

// Default del listener (uso directo / tests, donde el puerto es efímero y no se sabe de antemano): acepta `<ws>.localhost`
// con cualquier puerto. El transport NUNCA usa este default: pasa hostWsMatcher(host de previewOrigin), que exige el host exacto.
const anyPortWs = (hostHeader: string): string | undefined => /^([a-z0-9-]{1,63})\.localhost(?::\d{1,5})?$/.exec(hostHeader.toLowerCase())?.[1];

/** La parte servible de la ruta: `/assets/x.js?v=1` → `assets/x.js`, y la raíz `/` → `''` (vite/dist sirven en la raíz). */
function relOf(pathname: string): string {
  const noLead = pathname.replace(/^\//, '');
  const q = noLead.indexOf('?');
  return q < 0 ? noLead : noLead.slice(0, q);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};
const STATUS: Record<number, string> = { 200: 'OK', 307: 'Temporary Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

// Se reintenta solo cada 1 s (meta refresh, sin JS) hasta que vite responde con la página real: "Play" abre la url directa
// sin pasar por el latido, así que la primera carga arranca vite (pump) y el placeholder recarga hasta tener contenido
// (R5.4 / ADR §3.4). Es same-origin del ws, no accede a nada más. Cuando vite sirve la página real, ya no hay refresh.
const LOADING_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>Preparando preview</title></head><body style="margin:0"></body></html>';
// Topes contra DoS (security-reviewer M3): cabeceras y cuerpo de la petición, inactividad del socket y conexiones a la vez.
const MAX_HEAD = 64 * 1024;
const MAX_BODY = 10 * 1024 * 1024;
const IDLE_MS = 30_000;
const MAX_CONNS = 64;

interface Req { raw: Buffer; path: string; host: string; upgrade: boolean; cookie?: string }

/** Query de la primera carga con el token (§9) y cookie por la que se canjea. */
export const PREVIEW_TOKEN_PARAM = 'wt_preview';
export const PREVIEW_COOKIE = 'wt_preview';

/** Con `gate`, cada request del preview (y el upgrade de HMR) necesita el token de su ws (identidad-sesion.md §9). La
 *  llave es HMAC (`secret`, local) XOR Ed25519 pública (`publicKey`, bajo el orquestador; deploy-sandbox.md §4). */
export interface PreviewGate {
  readonly secret?: Buffer;
  readonly publicKey?: KeyObject;
  /** ¿Es `owner` el dueño del ws? Obligatoria en modo asimétrico: el orquestador pudo firmar un preview para cualquier
   *  owner, así que la VM reautoriza. En HMAC la autorización ocurre al acuñar (preview-dist.tokenFor tras ownsWs). */
  readonly ownsWs?: (ws: string, owner: string) => boolean;
  /** Inyectable para los tests; por defecto Date.now. */
  readonly now?: () => number;
}

/** La llave de verificación del gate: HMAC si hay secreto, si no la pública. El emisor garantiza que no haya ambas. */
function gateKey(gate: PreviewGate): PreviewKey | undefined {
  if (gate.secret) return { mode: 'hmac', secret: gate.secret };
  if (gate.publicKey) return { mode: 'ed25519', publicKey: gate.publicKey };
  return undefined;
}

/** Todas las cookies con ese nombre: la página de otro ws puede plantar una con Domain del padre que el navegador manda
 *  antes que la buena (security-reviewer M3); con quedarse con la primera, un ws le tumbaba el preview a otro. */
function cookieValues(header: string | undefined, name: string): string[] {
  return (header ?? '').split(';').flatMap((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && part.slice(0, eq).trim() === name ? [part.slice(eq + 1).trim()] : [];
  });
}

/** La cabecera Cookie sin el token del preview: vite corre el config que escribió el agente y no tiene por qué verlo. */
function withoutPreviewCookie(raw: Buffer, cookie: string | undefined): Buffer {
  if (cookie === undefined) return raw;
  const rest = cookie.split(';').filter((part) => part.slice(0, Math.max(0, part.indexOf('='))).trim() !== PREVIEW_COOKIE).map((p) => p.trim()).filter(Boolean);
  return rest.length ? setHeader(raw, 'Cookie', rest.join('; ')) : removeHeader(raw, 'Cookie');
}

type GateResult = { kind: 'pass' } | { kind: 'deny' } | { kind: 'exchange'; location: string; cookie: string };

/** El token de la query se canjea por la cookie con un 307 a la misma ruta sin el token: así no queda en la barra, en el
 *  historial ni en el Referer de lo que cargue la página (§11.6). Sin token válido en query ni en cookie → deny. */
function checkGate(gate: PreviewGate, req: Req, ws: string): GateResult {
  const now = (gate.now ?? Date.now)();
  const key = gateKey(gate);
  if (!key) return { kind: 'deny' };
  // Asimétrico: el orquestador pudo firmar un preview para un owner que no es el dueño del ws, así que la VM reautoriza
  // contra ownsWs (fail-closed si falta). HMAC: ya se autorizó al acuñar (preview-dist.tokenFor tras ownsWs).
  const authorized = (owner: string): boolean => key.mode !== 'ed25519' || (gate.ownsWs?.(ws, owner) ?? false);
  const url = new URL(req.path || '/', 'http://preview.invalid');
  const fromQuery = req.upgrade ? null : url.searchParams.get(PREVIEW_TOKEN_PARAM);
  if (fromQuery !== null) {
    const v = verifyPreview(fromQuery, key, ws, now);
    if (!v.ok || !authorized(v.owner)) return { kind: 'deny' };
    url.searchParams.delete(PREVIEW_TOKEN_PARAM);
    // Host-only (sin Domain): la cookie es del origen de este ws y el navegador no la manda a otro. Partitioned +
    // SameSite=None: el preview vive en el iframe del builder, otro sitio; sin partición Chrome la bloquea como de terceros.
    const cookie = `${PREVIEW_COOKIE}=${fromQuery}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.max(0, Math.floor((v.exp - now) / 1000))}`;
    // Una sola barra al frente: `/.//evil.com` normaliza a `//evil.com`, que el navegador lee como otro host (M2).
    return { kind: 'exchange', location: `/${url.pathname.replace(/^\/+/, '')}${url.search}`, cookie };
  }
  return cookieValues(req.cookie, PREVIEW_COOKIE).some((t) => { const v = verifyPreview(t, key, ws, now); return v.ok && authorized(v.owner); }) ? { kind: 'pass' } : { kind: 'deny' };
}

function headerOf(lines: string[], name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'i');
  for (const l of lines) { const m = re.exec(l); if (m) return m[1]!.trim(); }
  return undefined;
}

/** Saca UNA petición del buffer: `undefined` si aún no llegó entera, `'bad'` si es inválida (→ 400), o la petición y lo
 *  que sigue. El upgrade no tiene cuerpo: toma lo que haya y lo que siga es del WebSocket. Rechaza (security-reviewer L1)
 *  Transfer-Encoding (no parseamos chunked de request), Content-Length duplicado o no numérico, y cuerpos enormes. */
export function takeRequest(buf: Buffer): { req: Req; rest: Buffer } | undefined | 'bad' | 'too-large' {
  const s = buf.toString('latin1');
  const end = s.indexOf('\r\n\r\n');
  // Solo las CABECERAS tienen tope: runaway (sin fin) y pasado MAX_HEAD → 431. Un cuerpo grande ya está acotado por
  // MAX_BODY al parsear el Content-Length, así que esperar a que llegue entero no desborda (bug del banco: un POST grande
  // en el mismo chunk se mataba con 431).
  if (end < 0) return buf.length > MAX_HEAD ? 'too-large' : undefined;
  if (end > MAX_HEAD) return 'too-large'; // cabeceras completas pero enormes (el fin cayó en el mismo chunk)
  const lines = s.slice(0, end).split('\r\n');
  const headers = lines.slice(1);
  const path = (lines[0] ?? '').split(' ')[1] ?? '';
  const host = headerOf(headers, 'host') ?? '';
  const cookie = headerOf(headers, 'cookie');
  const extra = cookie === undefined ? {} : { cookie };
  if (headers.some((l) => /^upgrade:\s*websocket/i.test(l))) return { req: { raw: buf, path, host, upgrade: true, ...extra }, rest: buf.subarray(buf.length) };
  if (headers.some((l) => /^transfer-encoding:/i.test(l))) return 'bad';
  const cls = headers.filter((l) => /^content-length:/i.test(l));
  if (cls.length > 1) return 'bad';
  let clen = 0;
  if (cls.length === 1) {
    const v = cls[0]!.slice(cls[0]!.indexOf(':') + 1).trim();
    if (!/^\d+$/.test(v)) return 'bad';
    clen = Number(v);
    if (clen > MAX_BODY) return 'bad';
  }
  const total = end + 4 + clen;
  if (buf.length < total) return undefined;
  return { req: { raw: buf.subarray(0, total), path, host, upgrade: false, ...extra }, rest: buf.subarray(total) };
}

/** Reescribe (o agrega) una cabecera en el bloque de cabeceras de una petición/respuesta cruda. */
function setHeader(raw: Buffer, name: string, value: string): Buffer {
  const s = raw.toString('latin1');
  const end = s.indexOf('\r\n\r\n');
  if (end < 0) return raw;
  const lines = s.slice(0, end).split('\r\n');
  const kept = lines.filter((l, i) => i === 0 || !new RegExp(`^${name}:`, 'i').test(l));
  kept.push(`${name}: ${value}`);
  return Buffer.concat([Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'latin1'), raw.subarray(end + 4)]);
}

function removeHeader(raw: Buffer, name: string): Buffer {
  const s = raw.toString('latin1');
  const end = s.indexOf('\r\n\r\n');
  if (end < 0) return raw;
  const kept = s.slice(0, end).split('\r\n').filter((l, i) => i === 0 || !new RegExp(`^${name}:`, 'i').test(l));
  return Buffer.concat([Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'latin1'), raw.subarray(end + 4)]);
}

/** Agrega una cabecera sin quitar las que ya trae: si la página generada declara su propia CSP, las dos se aplican. */
function addHeader(raw: Buffer, line: string): Buffer {
  const end = raw.toString('latin1').indexOf('\r\n\r\n');
  if (end < 0) return raw;
  return Buffer.concat([raw.subarray(0, end), Buffer.from(`\r\n${line}`, 'latin1'), raw.subarray(end)]);
}

/** Solo el builder (y el propio preview) puede enmarcar la página generada: otro sitio no la mete en un iframe para
 *  clickjacking. Como Stitch en su iframe de preview (`frame-ancestors 'self' https://stitch...`, infra/vivo/
 *  stitch-2026-11-04/cabeceras.md ZAP 43822). Sin más directivas: la página la escribe el agente y carga fuentes,
 *  imágenes y scripts de donde quiera; restringirlos rompe páginas válidas y el HMR de vite. */
export function previewCsp(builderOrigins: readonly string[]): string {
  return `frame-ancestors 'self'${builderOrigins.map((o) => ` ${o}`).join('')}`;
}

/** Una respuesta propia (sin vite): Content-Length y la conexión sigue viva salvo que `close`. */
function respond(sock: Socket, status: number, headers: Record<string, string>, body: Buffer | undefined, close: boolean): void {
  const h: Record<string, string> = { connection: close ? 'close' : 'keep-alive', 'content-length': String(body?.length ?? 0), ...headers };
  // Ningún valor con CR/LF parte la respuesta (H1): lanza y el catch de pump cierra solo esta conexión.
  if (Object.values(h).some((v) => /[\r\n]/.test(v))) throw new Error('cabecera con CR/LF');
  sock.write(`HTTP/1.1 ${status} ${STATUS[status] ?? 'OK'}\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  if (body) sock.write(body);
  if (close) sock.end();
}

/** Lo que el listener necesita del transport para cada ws, sin acoplarse a él: dónde está el workspace y su dist servible. */
export interface PreviewResolve {
  /** El workspace del ws (validado: patrón + índice), o undefined si no existe (→ 404). */
  dirFor(ws: string): string | undefined;
  /** El `dist/<commit>` servible del ws (HEAD), o undefined si no hay dist servible para esa versión. */
  distFor(ws: string): string | undefined;
  /** ¿El ws ya instaló y se le puede arrancar vite bajo demanda? (R1.3: no `bunx vite` a medio install; security M1.) */
  ready(ws: string): boolean;
}

/** Resuelve el archivo de dist para una ruta, o undefined si no hay dist. 'forbidden' si la ruta se sale de distDir, por
 *  `..` o por un symlink que apunta afuera (security-reviewer M1: se compara el realpath, no solo el string). */
export function distFile(distDir: string, pathname: string): string | undefined | 'forbidden' {
  if (!existsSync(distDir)) return undefined;
  let rootReal: string;
  try { rootReal = realpathSync(distDir); } catch { return undefined; }
  const rel = relOf(pathname);
  const target = rel ? normalize(join(distDir, rel)) : join(distDir, 'index.html');
  if (target !== distDir && !target.startsWith(distDir + sep)) return 'forbidden';
  const chosen = existsSync(target) && statSync(target).isFile() ? target : join(distDir, 'index.html');
  if (!existsSync(chosen)) return undefined;
  let real: string;
  try { real = realpathSync(chosen); } catch { return 'forbidden'; }
  // El archivo real (resuelto el symlink) tiene que seguir dentro de dist: un dist/k -> ~/.ssh no se sirve.
  return real === rootReal || real.startsWith(rootReal + sep) ? chosen : 'forbidden';
}

/** Arranca el listener de previews en su propio puerto. El ws sale del `Host` (`wsOfHost`): sin ws → 421 (Host ajeno, corta
 *  el DNS rebinding); con ws pero sin workspace en el índice → 404. Vite vivo → por request a su vite (y el upgrade por
 *  pipe); sin vite pero con dist → estático en la raíz; sin nada → carga. El arranque de vite lo dispara el latido (ADR §3.2).
 *  NOTA: un cuerpo de request chunked se rechaza con 400 (los GET de assets no lo usan). */
export function startPreviewServer(pool: PreviewPool, resolve: PreviewResolve, port: number, host = '127.0.0.1', wsOfHost: (hostHeader: string) => string | undefined = anyPortWs, builderOrigins?: readonly string[], gate?: PreviewGate): Server {
  // Sin origen del builder no se manda: frame-ancestors 'self' a secas dejaría al builder sin poder mostrar el preview.
  const csp = builderOrigins?.length ? previewCsp(builderOrigins) : undefined;
  const cspHeaders: Record<string, string> = csp ? { 'content-security-policy': csp } : {};
  const server = createServer((client: Socket) => {
    client.on('error', () => client.destroy());
    client.setTimeout(IDLE_MS, () => client.destroy());
    let buf: Buffer = Buffer.alloc(0);
    let busy = false; // una respuesta en curso: no se saca la siguiente petición hasta terminarla
    let piped = false; // la conexión pasó a ser un WebSocket: ya no se parsea

    const serveFile = (ws: string, pathname: string): void => {
      const file = distFile(resolve.distFor(ws) ?? '', pathname);
      if (file === 'forbidden') { respond(client, 403, {}, undefined, false); busy = false; pump(); return; }
      if (!file) { respond(client, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...cspHeaders }, Buffer.from(LOADING_HTML), false); busy = false; pump(); return; }
      busy = true;
      client.write(`HTTP/1.1 200 OK\r\ncontent-type: ${MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'}\r\ncontent-length: ${statSync(file).size}\r\ncache-control: no-store\r\n${csp ? `content-security-policy: ${csp}\r\n` : ''}connection: keep-alive\r\n\r\n`);
      const rs = createReadStream(file);
      rs.on('error', () => client.destroy());
      rs.on('end', () => { busy = false; pump(); });
      rs.pipe(client, { end: false });
    };

    const proxyHttp = (vitePort: number, req: Req): void => {
      busy = true;
      let settled = false;
      let headersDone = false;
      let headBuf = Buffer.alloc(0);
      let bodyRemaining = -1; // ≥0 = quedan N bytes de cuerpo por Content-Length; -1 = delimitado por cierre o chunked
      let keepClient = true;
      const done = (): void => { if (settled) return; settled = true; if (keepClient) { busy = false; pump(); } else client.end(); };
      const upstream = connect(vitePort, '127.0.0.1', () => upstream.write(setHeader(withoutPreviewCookie(req.raw, req.cookie), 'Connection', 'close')));
      upstream.setTimeout(IDLE_MS, () => { if (!headersDone && !settled) { respond(client, 504, {}, undefined, true); settled = true; } else keepClient = false; upstream.destroy(); done(); });
      upstream.on('data', (c: Buffer) => {
        if (!headersDone) {
          headBuf = Buffer.concat([headBuf, c]);
          const idx = headBuf.toString('latin1').indexOf('\r\n\r\n');
          // Solo las CABECERAS tienen tope: el primer chunk de vite trae las cabeceras junto con >64 KB de cuerpo (p. ej.
          // @vite/client, 223 KB). Cortar por tamaño antes de hallar el fin de cabeceras tumbaba esa respuesta entera.
          if (idx < 0) { if (headBuf.length > MAX_HEAD) { keepClient = false; upstream.destroy(); client.destroy(); } return; }
          if (idx > MAX_HEAD) { keepClient = false; upstream.destroy(); client.destroy(); return; } // cabeceras enormes en el mismo chunk
          headersDone = true;
          const headStr = '\r\n' + headBuf.toString('latin1').slice(0, idx);
          const cl = /\r\ncontent-length:\s*(\d+)/i.exec(headStr);
          const chunked = /\r\ntransfer-encoding:\s*chunked/i.test(headStr);
          // Sin Content-Length ni chunked la respuesta se delimita cerrando: no se puede mantener viva al cliente
          // (quedaría colgado esperando el cuerpo), así que se cierra (security-reviewer #4).
          keepClient = Boolean(cl || chunked);
          const head = setHeader(headBuf.subarray(0, idx + 4), 'Connection', keepClient ? 'keep-alive' : 'close');
          client.write(csp ? addHeader(head, `content-security-policy: ${csp}`) : head);
          const body = headBuf.subarray(idx + 4);
          if (cl) {
            // Solo los bytes del cuerpo declarado: nada de más se cuela a la siguiente petición keep-alive (L2).
            bodyRemaining = Number(cl[1]);
            const take = body.subarray(0, bodyRemaining);
            client.write(take); bodyRemaining -= take.length;
            if (bodyRemaining <= 0) done();
          } else client.write(body);
          return;
        }
        if (bodyRemaining >= 0) {
          const take = c.subarray(0, bodyRemaining);
          client.write(take); bodyRemaining -= take.length;
          if (bodyRemaining <= 0) done();
        } else client.write(c);
      });
      upstream.on('end', done);
      upstream.on('close', done);
      upstream.on('error', () => { if (!headersDone && !settled) { respond(client, 502, {}, undefined, true); settled = true; } else keepClient = false; done(); });
    };

    const proxyUpgrade = (vitePort: number, req: Req): void => {
      piped = true;
      client.off('data', onData);
      client.setTimeout(0); // el WebSocket de HMR es de larga vida: sin timeout de inactividad
      const upstream = connect(vitePort, '127.0.0.1', () => { upstream.write(withoutPreviewCookie(req.raw, req.cookie)); if (buf.length) upstream.write(buf); client.pipe(upstream); upstream.pipe(client); });
      const kill = (): void => { upstream.destroy(); client.destroy(); };
      upstream.on('error', kill);
      client.on('error', kill);
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };

    const pump = (): void => {
      if (busy || piped) return;
      try {
        const taken = takeRequest(buf);
        if (taken === undefined) return; // cabeceras o cuerpo incompletos (el cuerpo ya está acotado por MAX_BODY): esperar
        if (taken === 'too-large') { respond(client, 431, {}, undefined, true); client.destroy(); return; }
        if (taken === 'bad') { respond(client, 400, {}, undefined, true); client.destroy(); return; }
        buf = taken.rest;
        const { req } = taken;
        // El ws sale del Host. Host ajeno (no `<ws>.localhost:<previewPort>`) → 421: corta el DNS rebinding y aísla el
        // origen de cada ws (R5.5). La validez contra el índice la aplica dirFor antes de tocar disco.
        // L1: un Host ajeno (421) o un ws fuera del índice (404) cierran la conexión — si no, MAX_CONNS se agota con Hosts
        // distintos en keep-alive.
        const ws = wsOfHost(req.host);
        if (!ws || !WS_ID.test(ws)) { respond(client, 421, {}, undefined, true); return; }
        // Antes del índice: sin token, un ws inexistente y uno ajeno responden igual (401), no se sondea cuáles existen.
        if (gate) {
          const g = checkGate(gate, req, ws);
          // El mismo challenge que el 401 de sesión del router (http-router.ts:68; RFC 9110 §15.5.2 lo exige en todo 401).
          if (g.kind === 'deny') { respond(client, 401, { 'www-authenticate': 'Bearer', 'cache-control': 'no-store', ...cspHeaders }, undefined, true); return; }
          if (g.kind === 'exchange') { respond(client, 307, { location: g.location, 'set-cookie': g.cookie, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }, undefined, false); pump(); return; }
        }
        const dir = resolve.dirFor(ws);
        if (!dir) { respond(client, 404, {}, undefined, true); return; } // ws fuera del índice
        const live = pool.live(dir);
        if (req.upgrade) { if (live) proxyUpgrade(live.port, req); else client.destroy(); return; }
        if (live) { proxyHttp(live.port, req); return; }
        // Sin vite vivo: recrea el dev server desde el commit (R5.4 / ADR §3.4). "Play" abre la url directa sin pasar por el
        // latido, así que el propio acceso lo dispara. Solo si el ws ya instaló (M1: R1.3 prohíbe `bunx vite` a medio
        // install) y hay cupo (ensure rechaza por MAX_LIVE o por backoff de un arranque fallido, M1/M2). Si no, placeholder
        // sin arrancar nada. Mientras arranca, el placeholder se reintenta solo.
        if (resolve.ready(ws)) { pool.see(dir); void pool.ensure(dir, { onDemand: true }).catch(() => {}); }
        serveFile(ws, req.path);
      } catch {
        // Cualquier error de parseo cierra ESTA conexión, nunca el proceso (security-reviewer H1).
        client.destroy();
      }
    };

    const onData = (c: Buffer): void => { buf = Buffer.concat([buf, c]); pump(); };
    client.on('data', onData);
  });
  server.maxConnections = MAX_CONNS;
  return server.listen(port, host);
}
