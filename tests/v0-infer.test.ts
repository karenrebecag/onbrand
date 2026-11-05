import { test, expect, beforeAll } from 'bun:test';

// Backoff corto para que el test no espere segundos reales.
beforeAll(() => { process.env.WT_INFER_RETRY_BASE_MS = '1'; });
const { claudeCodeInferFree } = await import('../src/runtime/infer');

// La concurrencia puede toparse con el rate-limit de la sesión CLI; infer reintenta SOLO ante rate-limit
// (429/overloaded), con backoff, separado del reintento de parse (salida no-JSON) que vive en inferJson.
test('infer reintenta ante 429 y luego resuelve', async () => {
  let calls = 0;
  const run = async () => { calls += 1; if (calls === 1) throw new Error('claude-code: 429 rate limit exceeded'); return '{"role":"hero","children":[]}'; };
  const infer = claudeCodeInferFree({ run });
  const out = (await infer('sys', '{}')) as { role: string };
  expect(out.role).toBe('hero');
  expect(calls).toBe(2); // una llamada fallida + un reintento
});

test('infer propaga el 429 tras agotar los reintentos (máx 3)', async () => {
  let calls = 0;
  const run = async () => { calls += 1; throw new Error('overloaded_error'); };
  const infer = claudeCodeInferFree({ run });
  await expect(infer('sys', '{}')).rejects.toThrow(/overloaded/);
  expect(calls).toBe(4); // intento inicial + 3 reintentos
});

test('infer NO reintenta un error que no es rate-limit (salida no-JSON la maneja inferJson)', async () => {
  let calls = 0;
  const run = async () => { calls += 1; return 'no json aquí'; };
  const infer = claudeCodeInferFree({ run });
  await expect(infer('sys', '{}')).rejects.toThrow(/no contiene un objeto JSON/);
  expect(calls).toBe(1); // sin reintento: no es rate-limit
});

test('infer reintenta ante 5xx transitorio (service unavailable) y luego resuelve', async () => {
  let calls = 0;
  const run = async () => { calls += 1; if (calls === 1) throw new Error('claude-code: 503 Service Unavailable'); return '{"role":"hero","children":[]}'; };
  const out = (await claudeCodeInferFree({ run })('sys', '{}')) as { role: string };
  expect(out.role).toBe('hero');
  expect(calls).toBe(2);
});

test('infer reintenta ante error de conexión y luego resuelve', async () => {
  let calls = 0;
  const run = async () => { calls += 1; if (calls === 1) throw new Error('ECONNRESET'); return '{"role":"hero","children":[]}'; };
  const out = (await claudeCodeInferFree({ run })('sys', '{}')) as { role: string };
  expect(out.role).toBe('hero');
  expect(calls).toBe(2);
});

// Staging V4 (QA): agent:suggestions por Gateway dio "JSON Parse error". Cortar de la primera `{` a la última junta llaves
// de texto suelto con el objeto; el parse tiene que encontrar el primer objeto completo.
test('parseJsonObject toma el primer objeto válido aunque haya texto con llaves alrededor o después', async () => {
  const { parseJsonObject } = await import('../src/runtime/infer');
  expect(parseJsonObject('Aquí va: {"page": [{"title": "Logos", "message": "Añade {logos}"}]}\n\nNota: usa {marca} si aplica.')).toEqual({ page: [{ title: 'Logos', message: 'Añade {logos}' }] });
  expect(parseJsonObject('```json\n{"a": "}"}\n```\ny luego {"b": 2}')).toEqual({ a: '}' });
  expect(parseJsonObject('{"a": "comilla \\" y llave }"} {"b": 1}')).toEqual({ a: 'comilla " y llave }' });
  expect(() => parseJsonObject('{"page": [{"title": "Lo')).toThrow(/no trae un objeto JSON válido .*termina en/);
});

test('gateway: una respuesta cortada en max_tokens falla con ese motivo, no con un error de parse', async () => {
  const { gatewayInfer } = await import('../src/runtime/infer');
  const realFetch = globalThis.fetch;
  process.env.AI_GATEWAY_API_KEY = 'test-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: '{"page": [{"title": "Lo' }], stop_reason: 'max_tokens', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 8192 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  try {
    await expect(gatewayInfer({ model: 'haiku' })('sys', '{}')).rejects.toThrow(/max_tokens \(8192/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.AI_GATEWAY_API_KEY;
  }
});

// QA caso 2: el `claude -p` del paso de imagen arrancaba los MCP globales de la máquina (flowstudio). Solo ve los que se le pasan.
test('infer aísla el subproceso: --strict-mcp-config y solo los servidores MCP pedidos', async () => {
  let seen: string[] = [];
  const run = async (_b: string, args: string[]) => { seen = args; return '{}'; };
  await claudeCodeInferFree({ run })('sys', '{}');
  expect(seen).toContain('--strict-mcp-config');
  expect(seen).not.toContain('--mcp-config');
  await claudeCodeInferFree({ run, mcpServers: { 'knowledge': { type: 'http', url: 'https://x/mcp' } } })('sys', '{}');
  expect(seen).toContain('--strict-mcp-config');
  expect(JSON.parse(seen[seen.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { 'knowledge': { type: 'http', url: 'https://x/mcp' } } });
});
