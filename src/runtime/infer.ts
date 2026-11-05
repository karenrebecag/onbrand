// Transporte LLM genérico para el agente de composición, por la CLI de Claude Code (`claude -p`).
// Sin key: usa la sesión autenticada de la máquina. Mismo mecanismo que copygen/claude-code-transport,
// pero con system prompt libre (el de copy está fijado a page-content-1).

import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { track } from './children';
import { GATEWAY_BASE_URL, gatewayConnection } from './gateway-auth';
import { config, type ComposeProvider } from '../config';

/** `signal`: la corrida que pidió la llamada; al abortar, el CLI muere y no se reintenta (auditoría #8). */
export type Infer = (system: string, userJson: string, signal?: AbortSignal) => Promise<unknown>;

export type RunCli = (bin: string, args: string[], input: string, signal?: AbortSignal) => Promise<string>;

// HACK: un techo fijo para todo `claude -p`. Sin él, un CLI colgado no moría nunca y su promesa tampoco resolvía; dentro de
// una tool serializada bloqueaba todas las siguientes de la corrida (auditoría #8). Un techo por llamador cuando alguno
// mida turnos más largos que esto.
export const CLI_TIMEOUT_MS = 300_000;
/** Tope de las llamadas opcionales (sugerencias, enhancer): bajo contención tras un turno pesado se colgaban hasta
 * CLI_TIMEOUT_MS y tiraban el enhancer a 500. Son prescindibles, así que se cortan pronto y se degradan. */
export const OPTIONAL_TIMEOUT_MS = Number(process.env.WT_OPTIONAL_TIMEOUT_MS) || 25_000;

/** La señal del llamador más un tope propio: la que se pasa a una llamada opcional. */
export const boundedSignal = (ms: number, signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export const spawnCli: RunCli = (bin, args, input, signal) =>
  new Promise((resolve, reject) => {
    // `signal` y `timeout` de execFile matan al hijo con killSignal (https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback).
    const child = track(execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: CLI_TIMEOUT_MS, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude-code: ${signal?.aborted ? ((signal.reason as Error | undefined)?.name === 'TimeoutError' ? 'sin respuesta en el tope de la llamada' : 'cortado: la corrida se detuvo') : err.killed ? `sin respuesta en ${CLI_TIMEOUT_MS / 1000} s` : err.message}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`));
      resolve(stdout);
    }));
    // Un CLI que muere antes de leer stdin da EPIPE en el pipe: sin handler sería un 'error' sin escuchar.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });

/** Extrae el primer objeto JSON de la salida, tolerante a fences, texto alrededor y más de un objeto. Staging V4: haiku por
 * Gateway dio "JSON Parse error" con llaves fuera del objeto; cortar de la primera `{` a la última las juntaba. */
export function parseJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const body of fence ? [fence[1], text] : [text]) {
    const value = firstObject(body);
    if (value !== undefined) return value;
  }
  if (!text.includes('{')) throw new Error('claude-code: la salida no contiene un objeto JSON');
  // El final de la salida dice si se cortó o qué la rompió; es texto del modelo, no hay secretos.
  throw new Error(`la salida no trae un objeto JSON válido (${text.length} caracteres, termina en: ${JSON.stringify(text.slice(-160))})`);
}

function firstObject(body: string): unknown {
  for (let start = body.indexOf('{'); start !== -1; start = body.indexOf('{', start + 1)) {
    const end = closingBrace(body, start);
    if (end === -1) continue;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      // Una llave dentro de texto suelto no abre el objeto: se prueba con la siguiente.
    }
  }
  return undefined;
}

/** La llave que cierra la de `start`, saltando las que están dentro de strings JSON. -1 si no cierra. */
function closingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

export interface InferOptions {
  model?: string;
  bin?: string;
  run?: RunCli;
  allowedTools?: string[]; // habilita tools MCP en el subproceso (p. ej. atom_generate_image para imágenes)
  /** Los únicos servidores MCP que ve el subproceso (forma `mcpServers` de --mcp-config). */
  mcpServers?: Record<string, unknown>;
}

/** Un fallo TRANSITORIO que vale la pena reintentar: rate-limit/overload (429/529), 5xx del proveedor, o
 * un error de conexión (sin respuesta HTTP). Con maxRetries:0 en el cliente del gateway, withRetry es el
 * único retry, así que cubre lo que el SDK reintentaba. Distinto de una salida no-JSON (eso lo reintenta
 * inferJson, el parse) o de un 4xx de verdad (no se reintenta). El path CLI solo tiene el stderr. */
function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true; // sin status: timeout/caída de conexión
  if (e instanceof Anthropic.APIError) return e.status === 429 || e.status >= 500;
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes('429') || m.includes('529') || m.includes('rate limit') || m.includes('rate_limit') || m.includes('overloaded') || m.includes('econnreset') || m.includes('etimedout') || m.includes('connection error') || m.includes('service unavailable') || m.includes('internal server error') || m.includes('bad gateway');
}

const MAX_RATE_RETRIES = 3;

/** Reintenta SOLO ante fallos transitorios (isRetryable), con backoff exponencial + jitter, hasta
 * MAX_RATE_RETRIES. La concurrencia de secciones del agente puede toparse con el límite de la sesión CLI
 * o del gateway; sin esto, un 429/5xx/caída tumba la sección. Un error que no es transitorio (p. ej. salida
 * no-JSON, 4xx) se propaga tal cual para que lo maneje quien corresponda. */
async function withRateLimitRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      // Una corrida detenida no reintenta: cada intento es otra llamada que gasta.
      if (signal?.aborted || attempt >= MAX_RATE_RETRIES || !isRetryable(e)) throw e;
      const base = (Number(process.env.WT_INFER_RETRY_BASE_MS) || 500) * 2 ** attempt;
      const wait = base + Math.random() * base;
      console.warn(`[infer] fallo transitorio (reintento ${attempt + 1}/${MAX_RATE_RETRIES}) en ${Math.round(wait)}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Infer libre: `claude -p --model <m> --append-system-prompt <sys>` con el userJson por stdin.
 * Con allowedTools, el agente puede llamar esas tools (genera imágenes y devuelve el JSON de la sección). */
export function claudeCodeInferFree(opts: InferOptions = {}): Infer {
  const run = opts.run ?? spawnCli;
  const bin = opts.bin ?? process.env.WT_COMPOSE_CLI ?? 'claude';
  const model = opts.model ?? process.env.WT_COMPOSE_MODEL ?? 'sonnet';
  return async (system, userJson, signal) => {
    // Sin --strict-mcp-config el subproceso arrancaba los MCP globales de quien corre el transport (QA caso 2: flowstudio en
    // cada imagen), y sin --setting-sources project corría sus hooks y plugins: procesos, latencia y tools ajenas. Mismo
    // piso que visionArgs (vision.ts:73-76) y agentArgs (agent-loop.ts:172-174).
    const args = ['-p', '--model', model, '--append-system-prompt', system, '--strict-mcp-config', '--setting-sources', 'project'];
    if (opts.mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(','));
    return withRateLimitRetry(async () => parseJsonObject(await run(bin, args, userJson, signal)), signal);
  };
}

export { GATEWAY_BASE_URL };
/** Nombres cortos del CLI -> slugs del Gateway (provider/model, con punto). Un id que ya trae '/'
 * pasa tal cual; cualquier otro se prefija con anthropic/. */
const GATEWAY_MODELS: Record<string, string> = {
  sonnet: 'anthropic/claude-sonnet-5.5',
  opus: 'anthropic/claude-opus-5.5',
  haiku: 'anthropic/claude-haiku-5.5',
};
export function gatewayModel(m?: string): string {
  const id = m ?? process.env.WT_COMPOSE_MODEL ?? 'sonnet';
  if (id.includes('/')) return id;
  return GATEWAY_MODELS[id] ?? `anthropic/${id}`;
}

/** Infer por Vercel AI Gateway (Messages API de Anthropic sobre el baseURL del Gateway). Sin sesión
 * de CLI: es el transporte del deploy. Auth por Bearer con AI_GATEWAY_API_KEY (local/CI) o
 * VERCEL_OIDC_TOKEN (deploy en Vercel); el Gateway acepta ambos como Authorization. Con proxy del orquestador
 * (gateway-auth.ts) no hay llave: base y token de la corrida. No hay tools MCP
 * aquí, así que allowedTools se ignora: la generación de imágenes vive en el provider 'cli'. */
export function gatewayInfer(opts: InferOptions = {}): Infer {
  const { baseURL, token } = gatewayConnection();
  // maxRetries: 0 — el reintento de rate-limit lo lleva withRateLimitRetry (único, con backoff+jitter y
  // tope propio). Sin esto, el SDK reintenta por su cuenta (2 por defecto) y los reintentos se MULTIPLICAN
  // ante un 429 sobre el gateway.
  const client = new Anthropic({ baseURL, authToken: token, maxRetries: 0 });
  const model = gatewayModel(opts.model);
  return async (system, userJson, signal) =>
    withRateLimitRetry(async () => {
      // RequestOptions.signal del SDK (@anthropic-ai/sdk internal/request-options.d.ts:92).
      const res = await client.messages.create({
        model,
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: userJson }],
      }, signal ? { signal } : undefined);
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      // Un JSON cortado por el tope no se arregla parseando: el error tiene que decir que fue el tope.
      if (res.stop_reason === 'max_tokens') throw new Error(`gateway: la salida se cortó en max_tokens (${res.usage.output_tokens} tokens de salida)`);
      return parseJsonObject(text);
    }, signal);
}

/** Selecciona el transporte LLM por el seam de config: 'cli' (sesión de Claude Code, local, con tools MCP) o 'gateway'
 * (Vercel AI Gateway, deploy). WT_COMPOSE_PROVIDER gana al default del perfil. */
export function createInfer(opts: InferOptions = {}, provider: ComposeProvider = config().composeProvider): Infer {
  return provider === 'gateway' ? gatewayInfer(opts) : claudeCodeInferFree(opts);
}
