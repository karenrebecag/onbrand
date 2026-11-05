// Puente de errores del preview al builder: lo que falla después de que la persona hace clic (console.error, errores
// no capturados, promesas rechazadas) no pasa por el build ni por el turno del agente, y sin esto "Arreglar errores"
// no lo ve. Solo manda a un origen fijo que el preview recibe por env; sin él (deploy, build propio) no hace nada.
// También manda logs de consola y requests: el builder los adjunta a cada turno, como client_logs y network_requests
// de Lovable (re-sistema/lovable/datos/contexto-pipeline.md), para que el agente vea qué hizo la página en vivo.

export const WT_ERROR_MESSAGE = 'wt:runtime-error';
/** Documento nuevo o update de HMR: los errores anteriores ya no describen la página. v0 los borra con el CLEARED del
 * dev bridge (v0-layers deob :66274-66276); Lovable descarta los anteriores al último update de Vite
 * (app-lazy-shared deob :49493-49495 y :48871). Sin esto, el error de un archivo a medio escribir por el agente queda
 * en el builder sobre una versión limpia (7571e1fd: ChatThread usado antes de su import). */
export const WT_PREVIEW_UPDATED = 'wt:preview-updated';
export const WT_LOG_MESSAGE = 'wt:runtime-log';
export const WT_NETWORK_MESSAGE = 'wt:network';
export type RuntimeErrorKind = 'console.error' | 'error' | 'unhandledrejection';
export interface RuntimeErrorMessage {
  type: typeof WT_ERROR_MESSAGE;
  kind: RuntimeErrorKind;
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
  /** Ruta de la página, sin query ni hash: el query puede traer datos de la persona. */
  path: string;
}

export type LogLevel = 'log' | 'info' | 'warn' | 'debug';
export interface RuntimeLogMessage {
  type: typeof WT_LOG_MESSAGE;
  level: LogLevel;
  message: string;
  ts: number;
  path: string;
}
/** Solo metadatos: bodies y headers pueden traer datos de la persona o tokens. */
export interface NetworkMessage {
  type: typeof WT_NETWORK_MESSAGE;
  method: string;
  /** Origen y ruta, sin query ni hash. */
  url: string;
  /** 0 = no hubo respuesta (red, CORS, abort). */
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  ts: number;
  path: string;
}

const MESSAGE_MAX = 2000;
const STACK_MAX = 4000;
// Un error en un bucle de render saturaría el canal del builder: con este tope ya se ve que algo falla.
const SEND_MAX = 30;
// El builder guarda los últimos 50 de cada uno; este tope por documento o update solo evita inundar el canal.
const CONTEXT_SEND_MAX = 200;
const URL_MAX = 500;
const LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'debug'];

interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  location: { pathname: string; href?: string };
  console: { error: (...args: unknown[]) => void } & { [L in LogLevel]?: (...args: unknown[]) => void };
  // Métodos y no propiedades: así `window` encaja aunque sus tipos de fetch y XHR sean más estrictos.
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  XMLHttpRequest?: { prototype: XMLHttpRequest };
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function text(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** El query y el hash pueden traer tokens o datos de la persona; data: y blob: no dicen nada útil y pesan. */
function safeUrl(raw: string, base: string | undefined): string {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? cut(`${u.origin}${u.pathname}`, URL_MAX) : u.protocol;
  } catch {
    return cut(raw.split(/[?#]/)[0] ?? '', URL_MAX);
  }
}

function requestTarget(input: unknown, init?: { method?: string }): { method: string; url: string } {
  const req = typeof input === 'object' && input !== null && 'url' in input ? (input as { url: string; method?: string }) : null;
  return { method: (init?.method ?? req?.method ?? 'GET').toUpperCase(), url: req ? req.url : String(input) };
}

/** Lo que usa del `import.meta.hot` de Vite. */
export interface BridgeHot {
  on(event: 'vite:beforeUpdate', cb: () => void): void;
}

/** Instala el puente y devuelve cómo quitarlo. Inerte si no hay origen o si la página no está dentro de un iframe. */
export function installErrorBridge(win: BridgeWindow, origin: string | undefined, hot?: BridgeHot): () => void {
  if (!origin || (win.parent as unknown) === win) return () => {};
  let contextSent = 0;
  const updated = (): void => {
    contextSent = 0;
    try {
      win.parent.postMessage({ type: WT_PREVIEW_UPDATED }, origin);
    } catch {
      // El builder cerró o el origen no coincide: el preview sigue igual.
    }
  };
  // Antes del update y no después: como Lovable (q - 500), lo que tire al aplicar este update sí cuenta.
  updated();
  hot?.on('vite:beforeUpdate', updated);
  let sent = 0;
  let sending = false;
  const send = (m: Omit<RuntimeErrorMessage, 'type' | 'path'>): void => {
    // Si postMessage falla y algo lo registra con console.error, el puente se llamaría a sí mismo.
    if (sending || sent >= SEND_MAX) return;
    sending = true;
    sent += 1;
    try {
      win.parent.postMessage({ type: WT_ERROR_MESSAGE, path: win.location.pathname, ...m, message: cut(m.message, MESSAGE_MAX), ...(m.stack ? { stack: cut(m.stack, STACK_MAX) } : {}) } satisfies RuntimeErrorMessage, origin);
    } catch {
      // El builder cerró o el origen no coincide: el preview sigue igual.
    } finally {
      sending = false;
    }
  };

  const post = (m: RuntimeLogMessage | NetworkMessage): void => {
    if (sending || contextSent >= CONTEXT_SEND_MAX) return;
    sending = true;
    contextSent += 1;
    try {
      win.parent.postMessage(m, origin);
    } catch {
      // El builder cerró o el origen no coincide: el preview sigue igual.
    } finally {
      sending = false;
    }
  };
  const log = (level: LogLevel, args: unknown[]): void =>
    post({ type: WT_LOG_MESSAGE, level, message: cut(args.map(text).join(' '), MESSAGE_MAX), ts: Date.now(), path: win.location.pathname });
  const net = (method: string, url: string, started: number, status: number, error?: string): void =>
    post({ type: WT_NETWORK_MESSAGE, method: cut(method, 16), url: safeUrl(url, win.location.href), status, ok: status >= 200 && status < 400, durationMs: Math.max(0, Date.now() - started), ...(error ? { error: cut(error, MESSAGE_MAX) } : {}), ts: Date.now(), path: win.location.pathname });

  const originalLevels = LEVELS.map((level) => [level, win.console[level]] as const);
  for (const [level, fn] of originalLevels) {
    if (!fn) continue;
    win.console[level] = (...args: unknown[]) => {
      fn.apply(win.console, args);
      log(level, args);
    };
  }
  const originalFetch = win.fetch;
  if (originalFetch) {
    win.fetch = (input, init) => {
      const { method, url } = requestTarget(input, init);
      const started = Date.now();
      return originalFetch.call(win, input, init).then(
        (res) => { net(method, url, started, res.status); return res; },
        (err: unknown) => { net(method, url, started, 0, text(err)); throw err; },
      );
    };
  }
  const xhr = win.XMLHttpRequest?.prototype;
  const originalOpen = xhr?.open;
  const originalSend = xhr?.send;
  const targets = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  if (xhr && originalOpen && originalSend) {
    xhr.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      targets.set(this, { method: method.toUpperCase(), url: String(url) });
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as XMLHttpRequest['open'];
    xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const target = targets.get(this);
      const started = Date.now();
      if (target) this.addEventListener('loadend', () => net(target.method, target.url, started, this.status));
      return originalSend.call(this, body);
    };
  }

  const original = win.console.error;
  win.console.error = (...args: unknown[]) => {
    original.apply(win.console, args);
    const err = args.find((a): a is Error => a instanceof Error);
    send({ kind: 'console.error', message: args.map(text).join(' '), ...(err?.stack ? { stack: err.stack } : {}) });
  };
  const onError = (event: Event): void => {
    const e = event as Partial<ErrorEvent>;
    const stack = e.error instanceof Error ? e.error.stack : undefined;
    send({ kind: 'error', message: e.message || text(e.error), ...(stack ? { stack } : {}), ...(e.filename ? { source: e.filename } : {}), ...(e.lineno ? { line: e.lineno } : {}), ...(e.colno ? { column: e.colno } : {}) });
  };
  const onRejection = (event: Event): void => {
    const e = event as Partial<PromiseRejectionEvent>;
    const stack = e.reason instanceof Error ? e.reason.stack : undefined;
    send({ kind: 'unhandledrejection', message: text(e.reason), ...(stack ? { stack } : {}) });
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.console.error = original;
    for (const [level, fn] of originalLevels) if (fn) win.console[level] = fn;
    if (originalFetch) win.fetch = originalFetch;
    if (xhr && originalOpen && originalSend) {
      xhr.open = originalOpen;
      xhr.send = originalSend;
    }
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
