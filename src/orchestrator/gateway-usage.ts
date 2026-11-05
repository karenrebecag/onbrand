// Lectura del gasto real de una respuesta del Gateway: el scanner de usage (JSON o SSE message_start/message_delta) y la
// info de la request para la estimación. Extraído de gateway-proxy.ts (B1); cuerpos sin cambio. Módulo puro, sin deps.

export interface Seen {
  model: string | undefined;
  input: number;
  output: number;
  cache_creation_input: number;
  cache_read_input: number;
  server_tool_use: Record<string, number>;
  any: boolean;
  /** El upstream entregó el usage final (JSON con usage, o stream hasta message_stop). */
  complete: boolean;
}

export interface RequestInfo {
  readonly model: string | undefined;
  readonly maxTokens: number;
  readonly bytes: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const asObj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function toolUse(v: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  for (const [k, n] of Object.entries(asObj(v))) out[k] = num(n);
  return out;
}

export function readJsonUsage(seen: Seen, body: unknown): void {
  const b = asObj(body);
  const u = asObj(b.usage);
  if (typeof b.model === 'string') seen.model = b.model;
  seen.input = num(u.input_tokens);
  seen.output = num(u.output_tokens);
  seen.cache_creation_input = num(u.cache_creation_input_tokens);
  seen.cache_read_input = num(u.cache_read_input_tokens);
  seen.server_tool_use = toolUse(u.server_tool_use);
  seen.any = true;
  seen.complete = b.usage !== undefined;
}

/** message_start trae input y cachés; message_delta trae el acumulado de output y, con server tools, también de input, cachés y
 * server_tool_use: vale el último valor presente, no la suma. */
export function readSseEvent(seen: Seen, data: string): void {
  let e: Record<string, unknown>;
  try { e = asObj(JSON.parse(data)); } catch { return; }
  if (e.type === 'message_start') {
    const m = asObj(e.message);
    const u = asObj(m.usage);
    if (typeof m.model === 'string') seen.model = m.model;
    seen.input = num(u.input_tokens);
    seen.cache_creation_input = num(u.cache_creation_input_tokens);
    seen.cache_read_input = num(u.cache_read_input_tokens);
    seen.output = num(u.output_tokens);
    seen.server_tool_use = toolUse(u.server_tool_use);
    seen.any = true;
  } else if (e.type === 'message_delta') {
    const u = asObj(e.usage);
    if (u.output_tokens !== undefined) seen.output = num(u.output_tokens);
    if (u.input_tokens !== undefined) seen.input = num(u.input_tokens);
    if (u.cache_creation_input_tokens !== undefined) seen.cache_creation_input = num(u.cache_creation_input_tokens);
    if (u.cache_read_input_tokens !== undefined) seen.cache_read_input = num(u.cache_read_input_tokens);
    if (u.server_tool_use !== undefined) seen.server_tool_use = toolUse(u.server_tool_use);
  } else if (e.type === 'message_stop') {
    seen.complete = true;
  }
}

export function requestInfo(buf: ArrayBuffer): RequestInfo {
  try {
    const b = asObj(JSON.parse(new TextDecoder().decode(buf)));
    return { model: typeof b.model === 'string' ? b.model : undefined, maxTokens: num(b.max_tokens), bytes: buf.byteLength };
  } catch {
    return { model: undefined, maxTokens: 0, bytes: buf.byteLength };
  }
}
