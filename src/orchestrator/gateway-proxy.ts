// Proxy de Gateway del orquestador (docs/spec/deploy-sandbox.md §1, condición 2): la VM no tiene llave; el CLI llega aquí con un
// token firmado, el proxy comprueba el tope del dueño, reenvía con la credencial del orquestador y suma el gasto real. Módulo
// puro: token, índice, precios y upstream entran por deps; no sabe de Vercel Functions ni del Gateway concreto.
//
// Quien tiene el token (el agente lo lee del entorno de la VM) controla cuándo corta la conexión, así que el gasto no puede
// depender de que el cliente se quede: el abort del cliente NO llega al upstream, la respuesta se drena hasta el usage real
// (en waitUntil) y, si el upstream nunca lo entrega, se cobra una estimación conservadora.

import type { KeyObject } from 'node:crypto';
import { verify } from '../signed-token';
import { ZERO_USAGE, type ChatIndex, type TokenUsage } from './chat-index';
import { readJsonUsage, readSseEvent, requestInfo, type RequestInfo, type Seen } from './gateway-usage';
import { createSpendQueue } from './spend-queue';

export interface RunClaims {
  readonly owner: string;
  // HACK: `run` se verifica y no se usa: routes.ts emite el token por chat (run '') y el tope es diario por dueño. Tope por
  // corrida cuando agent-loop reciba el token por corrida y Karen fije la cifra.
  /** messageId de la corrida; '' = token por chat. */
  readonly run: string;
}

/** Lo que cobra el Gateway además de tokens: `server_tool_use` (web_search, etc.) viene acumulado en message_delta. */
export type PricedUsage = TokenUsage & { readonly server_tool_use: Readonly<Record<string, number>> };

export interface GatewayProxyDeps {
  /** undefined = inválido, vencido o de otro tipo: el proxy no distingue ante el cliente. */
  readonly verify: (token: string) => RunClaims | undefined;
  readonly index: Pick<ChatIndex, 'readSpend' | 'reserveSpend' | 'adjustSpend'>;
  /** USD por dueño, finito y >= 0 (si no, el constructor lanza: un NaN dejaría el tope abierto). Sin default: son cifras de Karen. */
  readonly caps: { readonly owner: number };
  /** Tope de `max_tokens` por llamada (default 16 000, decisión de Karen): una llamada con más no cabe en ninguna reserva sensata. */
  readonly maxTokensPerCall?: number;
  /** USD de un uso. Contrato (checkPriceOfContract): finito, >= 0 y un modelo desconocido cuesta al menos lo que el más caro. */
  readonly priceOf: (model: string, usage: PricedUsage) => number;
  /** Valor completo del header Authorization hacia el Gateway (OIDC del orquestador). La credencial del cliente nunca sube. */
  readonly credential: () => Promise<string>;
  readonly upstream: (url: string, init: RequestInit) => Promise<Response>;
  readonly upstreamUrl?: string;
  /** `waitUntil` de la Function. Obligatorio: la instancia puede congelarse al cerrar el stream y, sin él, el addSpend a Blob
   * (~100 ms) se pierde en silencio. */
  readonly waitUntil: (p: Promise<unknown>) => void;
  /** Un fallo al contar el gasto no puede romper la respuesta ya entregada, pero tampoco callarse. */
  readonly onError?: (e: unknown) => void;
  /** Tope del body en bytes; default el límite real del request en Functions (4.5 MB). */
  readonly maxBodyBytes?: number;
  /** Presupuesto de tiempo de la Function (maxDuration menos margen): al cumplirse se cierra la cuenta con lo visto y se corta el drenado. */
  readonly deadlineMs?: number;
  /** Reloj y temporizador inyectables (tests); defaults Date.now y setTimeout. */
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /** Intentos de adjustSpend por gasto antes de bloquear al dueño (default 3). */
  readonly spendAttempts?: number;
  /** Espera antes del reintento número `attempt` (default backoff corto). */
  readonly sleep?: (attempt: number) => Promise<void>;
}

const BASE = '/gw/claude-code';
const UPSTREAM = 'https://ai-gateway.vercel.sh/v1/messages';
// Lo único del cliente que sube; x-api-key, Authorization y cookies no.
const FORWARD = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'x-session-id'] as const;
const BACK = ['content-type', 'retry-after', 'request-id', 'anthropic-ratelimit-requests-remaining'] as const;
// Límite del request en Vercel Functions; el body se lee entero para estimar el costo, así que no se acepta más de lo que la plataforma deja pasar.
const DEFAULT_MAX_BODY_BYTES = 4.5 * 1024 * 1024;
// Estimación conservadora de tokens de entrada: menos de ~3 bytes por token solo pasa con texto muy denso.
const BYTES_PER_TOKEN = 3;
const DEFAULT_MAX_TOKENS = 16_000;

// x-should-retry: false: sin él el SDK del CLI reintenta el 429 y el 401 como si fueran transitorios.
const errorResponse = (status: number, type: string, message: string): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } });

const backoff = (attempt: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));

/** Lee el cuerpo contando bytes: corta en cuanto pasa `max`, sin esperar a tenerlo entero en memoria. */
async function readBounded(body: ReadableStream<Uint8Array> | null, max: number): Promise<ArrayBuffer | undefined> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

export function createGatewayProxy(deps: GatewayProxyDeps): (req: Request) => Promise<Response> {
  if (!Number.isFinite(deps.caps.owner) || deps.caps.owner < 0) throw new Error('gateway-proxy: caps.owner debe ser un número finito >= 0');
  if (typeof deps.waitUntil !== 'function') throw new Error('gateway-proxy: falta deps.waitUntil; sin él el gasto se pierde al congelarse la Function');
  const base = deps.upstreamUrl ?? UPSTREAM;
  const attempts = deps.spendAttempts ?? 3;
  const sleep = deps.sleep ?? backoff;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // onError y sleep son de quien integra: que fallen no puede dejar rechazada la cadena de un dueño.
  const fail = (what: string, e: unknown): void => {
    try { (deps.onError ?? ((err) => console.error(`[gateway-proxy] ${what}`, err)))(e); } catch { /* sin más dónde avisar */ }
  };

  // La cola de ajustes de gasto por dueño (falla cerrado: mientras un dueño tenga un ajuste sin registrar no se le atiende)
  // vive en spend-queue.ts. `pending.has(owner)` dice si hay que reintentar antes de atender una request.
  const { pending, enqueue, flush } = createSpendQueue({ index: deps.index, attempts, sleep, fail });

  /** Cierra la cuenta una sola vez (cierre normal, error, abort del cliente o deadline). `reserved` ya está en el contador. */
  function settler(owner: string, info: RequestInfo, reserved: number, started: number, day?: string): { seen: Seen; settle: () => Promise<void>; armDeadline: (onExpire: () => void) => void } {
    const seen: Seen = { model: undefined, input: 0, output: 0, cache_creation_input: 0, cache_read_input: 0, server_tool_use: Object.create(null), any: false, complete: false };
    let settled: Promise<void> | undefined;
    let cancelTimer: (() => void) | undefined;
    // Siempre la misma promesa: cierre, error, abort y deadline la piden y el ajuste se suma una sola vez.
    const settle = (): Promise<void> => (settled ??= run());
    const run = async (): Promise<void> => {
      cancelTimer?.();
      try {
        const model = seen.model ?? info.model ?? 'unknown';
        // Sin usage final (corte de red, error del stream, deadline) no se cobra cero: entrada por bytes y salida hasta max_tokens.
        const usage: TokenUsage = seen.complete
          ? { ...ZERO_USAGE, input: seen.input, output: seen.output, cache_creation_input: seen.cache_creation_input, cache_read_input: seen.cache_read_input }
          : { ...ZERO_USAGE, input: seen.any ? seen.input : Math.ceil(info.bytes / BYTES_PER_TOKEN), output: Math.max(seen.output, info.maxTokens), cache_creation_input: seen.cache_creation_input, cache_read_input: seen.cache_read_input };
        const usd = deps.priceOf(model, { ...usage, server_tool_use: seen.server_tool_use });
        if (!Number.isFinite(usd) || usd < 0) throw new Error(`priceOf devolvió ${usd} para ${model}`);
        enqueue(owner, { id: crypto.randomUUID(), delta: usd - reserved, tokens: { model, usage }, ...(day === undefined ? {} : { day }) });
      } catch (e) {
        // Sin precio la reserva se queda como cobro: es la estimación conservadora.
        fail('no se pudo calcular el gasto', e);
        return;
      }
      await flush(owner);
    };
    // Si la Function muere antes de cerrar la cuenta (maxDuration), la reserva ya cobró la estimación; el deadline propio
    // cierra la cuenta con lo visto antes de que eso pase.
    const armDeadline = (onExpire: () => void): void => {
      if (deps.deadlineMs === undefined) return;
      cancelTimer = schedule(() => { deps.waitUntil(settle()); void settle(); onExpire(); }, Math.max(0, deps.deadlineMs - (now() - started)));
    };
    return { seen, settle, armDeadline };
  }

  return async (req) => {
    // El deadline cuenta desde que la Function recibió la request, no desde que se armó el settler.
    const started = now();
    const url = new URL(req.url);
    const path = url.pathname;
    // El CLI sondea con HEAD antes de usar la base; un 404 vale (§1) y no necesita token.
    if (req.method === 'HEAD' && path === `${BASE}/api/hello`) return new Response(null, { status: 404 });
    // count_tokens lo manda el CLI con /context (verificado con claude 2.1.318 y servidor falso): pasa con el mismo token, sin gasto.
    const counting = path === `${BASE}/v1/messages/count_tokens`;
    if (req.method !== 'POST' || (path !== `${BASE}/v1/messages` && !counting)) return errorResponse(404, 'not_found_error', 'ruta no soportada');

    const auth = req.headers.get('authorization') ?? '';
    const token = /^Bearer (\S+)$/.exec(auth)?.[1];
    const claims = token ? deps.verify(token) : undefined;
    if (!claims) return errorResponse(401, 'authentication_error', 'sesión inválida o vencida');

    if (!counting) {
      if (pending.has(claims.owner) && !(await flush(claims.owner))) return errorResponse(429, 'rate_limit_error', 'no se pudo registrar el gasto anterior; reintenta en un momento');
      if ((await deps.index.readSpend(claims.owner)).spent >= deps.caps.owner) return errorResponse(429, 'rate_limit_error', 'se alcanzó el tope de gasto');
    }

    if (Number(req.headers.get('content-length') ?? 0) > maxBody) return errorResponse(413, 'request_too_large', 'el cuerpo es demasiado grande');
    let buf: ArrayBuffer | undefined;
    try { buf = await readBounded(req.body, maxBody); } catch { return errorResponse(400, 'invalid_request_error', 'cuerpo incompleto'); }
    if (!buf) return errorResponse(413, 'request_too_large', 'el cuerpo es demasiado grande');
    const info = requestInfo(buf);
    // La reserva cobra max_tokens a precio de salida: sin tope una llamada con max_tokens enorme consumiría el día de un dueño con un
    // solo request. 16 000 es el peor caso de una request, separado del tope diario por dueño [KAREN:chat 2026-11-05].
    if (info.maxTokens > (deps.maxTokensPerCall ?? DEFAULT_MAX_TOKENS)) return errorResponse(400, 'invalid_request_error', 'max_tokens supera el tope por llamada');

    // Reserva: la estimación se cobra ANTES de reenviar y se ajusta al usage real al cerrar. Así el gasto no depende de que esta
    // instancia viva hasta el final (maxDuration, upstream colgado) y las requests paralelas del dueño se ven entre sí.
    // HACK: la reserva cubre tokens de entrada y salida a un solo precio; no cubre server tools (web_search), cache_creation a
    // 1.25x/2x ni contexto de 1M. El ajuste final lo corrige, pero una Function muerta antes del ajuste deja el cobro corto.
    // Subir la estimación cuando el ajuste medido supere la reserva más de un 10 % de las veces.
    let reserved = 0;
    // El día UTC de la reserva: liquidar o liberar en el mismo contador aunque la corrida cruce la medianoche.
    let reservedDay: string | undefined;
    if (!counting) {
      try {
        reserved = deps.priceOf(info.model ?? 'unknown', { ...ZERO_USAGE, input: Math.ceil(info.bytes / BYTES_PER_TOKEN), output: info.maxTokens, server_tool_use: {} });
        if (!Number.isFinite(reserved) || reserved < 0) throw new Error(`priceOf devolvió ${reserved}`);
        const r = await deps.index.reserveSpend(claims.owner, reserved, deps.caps.owner, crypto.randomUUID());
        if (!r.ok) { reserved = 0; return errorResponse(429, 'rate_limit_error', 'esta llamada no cabe en el tope de gasto restante'); }
        reservedDay = r.day;
      } catch (e) {
        fail('no se pudo reservar el gasto', e);
        return errorResponse(503, 'api_error', 'no se pudo registrar el gasto; reintenta en un momento');
      }
    }
    const release = async (): Promise<void> => { if (reserved > 0) { enqueue(claims.owner, { id: crypto.randomUUID(), delta: -reserved, ...(reservedDay === undefined ? {} : { day: reservedDay }) }); const p = flush(claims.owner); deps.waitUntil(p); await p; } };

    const headers = new Headers();
    for (const h of FORWARD) { const v = req.headers.get(h); if (v !== null) headers.set(h, v); }
    try { headers.set('authorization', await deps.credential()); } catch (e) {
      // La reserva ya está cobrada y no se sabe si algo llegó a salir: se queda (cobro conservador), igual que un 502.
      fail('credential falló', e);
      return errorResponse(502, 'api_error', 'el gateway no respondió');
    }
    // Solo el flag beta del SDK; cualquier otro parámetro del cliente no sube.
    const search = url.searchParams.get('beta') === 'true' ? '?beta=true' : '';
    let up: Response;
    try {
      // Sin `signal`: abortar aquí cortaría el upstream antes del usage y el gasto saldría cero.
      up = await deps.upstream(counting ? `${base}/count_tokens${search}` : base + search, { method: 'POST', headers, body: buf });
    } catch (e) {
      // No se sabe si el upstream llegó a procesarlo: la reserva se queda (cobro conservador).
      fail('upstream falló', e);
      return errorResponse(502, 'api_error', 'el gateway no respondió');
    }

    const back = new Headers();
    for (const h of BACK) { const v = up.headers.get(h); if (v !== null) back.set(h, v); }
    if (counting || !up.ok || !up.body) {
      // El upstream rechazó la petición sin generar: se devuelve la reserva.
      if (!counting) await release();
      return new Response(up.body, { status: up.status, headers: back });
    }

    const { seen, settle, armDeadline } = settler(claims.owner, info, reserved, started, reservedDay);
    if (!(up.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Corre aunque el cliente ya se haya ido: el gasto no depende de que alguien lea la respuesta.
      let expire: () => void = () => undefined;
      const expired = new Promise<'expired'>((res) => { expire = () => res('expired'); });
      armDeadline(expire);
      const work = (async (): Promise<string | undefined> => {
        let text: string | undefined;
        try {
          const got = await Promise.race([up.text(), expired]);
          if (got === 'expired') throw new Error('deadline');
          text = got;
          readJsonUsage(seen, JSON.parse(text));
        } catch (e) { fail('respuesta ilegible', e); }
        await settle();
        return text;
      })();
      deps.waitUntil(work);
      const text = await work;
      return text === undefined ? errorResponse(502, 'api_error', 'el gateway cortó la respuesta') : new Response(text, { status: up.status, headers: back });
    }

    const reader = up.body.getReader();
    const decoder = new TextDecoder();
    let pendingText = '';
    const line = (l: string): void => { if (l.startsWith('data:')) readSseEvent(seen, l.slice(5).trim()); };
    const scan = (chunk: Uint8Array): void => {
      pendingText += decoder.decode(chunk, { stream: true });
      const lines = pendingText.split('\n');
      pendingText = lines.pop() ?? '';
      for (const l of lines) line(l);
    };
    const finish = (): void => { line(pendingText); pendingText = ''; };
    let cancelled = false;
    armDeadline(() => { void reader.cancel().catch(() => undefined); });
    // Tee sin bufferizar: cada chunk sale tal cual y se mira de paso. Cerrar o fallar suman antes de avisar al cliente.
    const out = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await reader.read();
          // Un pull en vuelo cuando el cliente cancela: lo que lea se escanea pero cerrar y sumar es del drenado, que ya corre.
          if (cancelled) { if (!done) scan(value); return; }
          if (done) {
            finish();
            // Sumar ANTES de cerrar: al cerrar, la Function puede congelarse y el gasto no llegaría a Blob.
            deps.waitUntil(settle());
            await settle();
            ctrl.close();
            return;
          }
          scan(value);
          ctrl.enqueue(value);
        } catch (e) {
          if (cancelled) return;
          deps.waitUntil(settle());
          await settle();
          ctrl.error(e);
        }
      },
      cancel() {
        cancelled = true;
        // El cliente se fue: el upstream sigue, se drena hasta el usage real y se suma bajo waitUntil. Sin esto, cortar justo
        // después de enviar pagaría cero.
        const drain = (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              scan(value);
            }
            finish();
          } catch (e) {
            fail('drenado del stream', e);
          }
          await settle();
        })();
        deps.waitUntil(drain);
      },
    });
    return new Response(out, { status: up.status, headers: back });
  };
}

/** `verify` del proxy sobre signed-token. `maxTtlMs` = duración máxima de una corrida, de config del orquestador. */
export function runTokenVerifier(publicKey: KeyObject, maxTtlMs: number, now: () => number = Date.now): GatewayProxyDeps['verify'] {
  return (token) => {
    const v = verify(publicKey, token, { typ: 'run', maxTtlMs, now: now() });
    return v.ok && v.claims.run !== undefined ? { owner: v.claims.owner, run: v.claims.run } : undefined;
  };
}

/** Test de contrato para el priceOf real (y el de prueba): finito, >= 0, y un modelo desconocido nunca más barato que uno conocido.
 * La implementación real debe además cubrir contexto de 1M (header anthropic-beta) y cache de 1 h (ephemeral_1h_input_tokens, 2x). */
export function checkPriceOfContract(priceOf: GatewayProxyDeps['priceOf'], knownModels: readonly string[]): void {
  const sample: PricedUsage = { input: 1_000, output: 1_000, cache_creation_input: 1_000, cache_read_input: 1_000, server_tool_use: { web_search_requests: 1 } };
  const unknown = priceOf('unknown', sample);
  if (!Number.isFinite(unknown) || unknown < 0) throw new Error(`priceOf('unknown') devolvió ${unknown}`);
  for (const m of knownModels) {
    const p = priceOf(m, sample);
    if (!Number.isFinite(p) || p < 0) throw new Error(`priceOf('${m}') devolvió ${p}`);
    if (unknown < p) throw new Error(`priceOf('unknown') = ${unknown} es menor que '${m}' = ${p}: un modelo desconocido saldría más barato`);
  }
}
