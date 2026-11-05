// Arnés M2 "Contexto del agente" (docs/spec/contexto-agente.md §6 QA). Sin LLM y sin reloj: composer falso que llama al MCP
// `wt` de la corrida como lo haría el CLI, y esperas acotadas por intentos sobre el log en disco. Rojo hasta que aterricen
// memory-tool/brand-store/event-model de M2: es a propósito.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePagePlanMd, planInvented } from '../src/page-plan-md';
import { foldMessage, readEvents, type EngineEvent } from '../src/runtime/events';
import type { PreviewPool } from '../src/runtime/preview';
import type { PreviewChecker } from '../src/runtime/preview-check';
import type { PageModel } from '../src/runtime/runner';
import { Runtime, type ComposeRequest, type RuntimeOptions } from '../src/runtime/server';
import { parseBrowseInput, runWorkspaceTool, type WorkspaceToolContext } from '../src/runtime/workspace-tools';

const BRAND = 'acme';
const FACT = 'Atienden de lunes a viernes de 9 a 18';
const PLAN_MD = `# Plan de página: Acme
Idioma: es

## 01-hero · #inicio
- titular: Cobra desde WhatsApp
- apoyo: Links de pago en segundos.
- cta: Probar → wa.me
- conteo: ninguno
- focal: foto de tienda
- superficie: base
- inventado: 3 cifras del mockup

## 02-features · #funciones
- titular: Todo para cobrar
- apoyo: Tres razones.
- cta: ninguno
- conteo: 3 tarjetas
- focal: iconos
- superficie: muted
- inventado: nada
`;
const CONTEXT = { ratio: 0.21, lastTokens: 42_000, floorTokens: 18_000, window: 200_000 };

type Ev = EngineEvent & Record<string, unknown>;
type Step = (req: ComposeRequest, mcp: (name: string, args: unknown) => Promise<McpResult>) => Promise<void>;
interface McpResult { isError?: boolean; content?: { text: string }[] }

let tmp: string;
let root: string;
let servers: Server[];
let seen: ComposeRequest[];
let steps: Step[];
let tools: string[][];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agent-context-'));
  root = join(tmp, 'state');
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  writeFileSync(join(scaffold, 'src', 'main.tsx'), '// main\n');
  mkdirSync(join(tmp, 'vault'));
  mkdirSync(join(tmp, 'brands', `brand-pack-${BRAND}`), { recursive: true });
  writeFileSync(join(tmp, 'brands', `brand-pack-${BRAND}`, 'brand.json'), JSON.stringify({ name: 'Acme', accent: 'orange' }));
  servers = [];
  seen = [];
  steps = [];
  tools = [];
});
afterEach(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Agente falso: lista las tools del MCP `wt`, corre el paso del test y escribe una versión con traza de contexto. */
async function fakeAgent(req: ComposeRequest): Promise<PageModel> {
  seen.push(req);
  const origin = new URL(req.approval?.url as string).origin;
  const rpc = async (method: string, params?: unknown): Promise<{ result?: unknown }> =>
    (await (await fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${req.approval?.token as string}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: unknown };
  tools.push(((await rpc('tools/list')).result as { tools?: { name: string }[] } | undefined)?.tools?.map((t) => t.name) ?? []);
  const mcp = async (name: string, args: unknown) => (await rpc('tools/call', { name, arguments: args })).result as McpResult;
  const dir = req.workspace?.dir as string;
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'App.tsx'), `export default function App() { return <main>${seen.length}</main>; }\n`);
  await steps.shift()?.(req, mcp);
  return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'ok', missing: [], suggestions: [], trace: { context: CONTEXT } } } as unknown as PageModel;
}

async function boot(extra: Partial<RuntimeOptions> = {}): Promise<string> {
  const t = new Runtime({ root, allow: {}, agent: true, compose: fakeAgent, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: join(tmp, 'scaffold'), vaultRoot: join(tmp, 'vault'), brandsRoot: join(tmp, 'brands'), ...extra });
  const s = t.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

const send = (at: string, method: string, path: string, body?: unknown) => fetch(`${at}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const logOf = (id: string): Ev[] => readEvents(join(root, 'logs'), id).events as Ev[];
async function settled(id: string, tries = 500): Promise<Ev[]> {
  for (let i = 0; i < tries; i++) {
    if (logOf(id).some((e) => e.type === 'settled')) return logOf(id);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`agent-context: ${id} sin settled; eventos: ${logOf(id).map((e) => e.type).join(',')}`);
}
async function run(at: string, body: Record<string, unknown>): Promise<Ev[]> {
  expect((await send(at, 'POST', '/runs', body)).ok).toBe(true);
  return settled(body.messageId as string);
}
const memoryOf = async (at: string): Promise<string> => ((await (await send(at, 'GET', `/brands/${BRAND}/memory`)).json()) as { text: string }).text;
const lines = (text: string) => text.split('\n').filter((l) => l.trim());

describe('M2 (a) remember', () => {
  test('sin marca la tool no existe; con marca sí', async () => {
    const at = await boot();
    await run(at, { prompt: 'landing', messageId: 'a1' });
    await run(at, { prompt: 'landing', messageId: 'a2', brand: BRAND });
    expect(tools[0]).not.toContain('remember');
    expect(tools[1]).toContain('remember');
  });

  test('guarda una línea por hecho con messageId y fecha, y emite memory.write', async () => {
    const at = await boot();
    let reply: McpResult | undefined;
    steps.push(async (_req, mcp) => { reply = await mcp('remember', { fact: FACT }); });
    const evs = await run(at, { prompt: 'landing', messageId: 'a3', brand: BRAND });
    expect(reply?.isError).toBeFalsy();
    expect(lines(await memoryOf(at))).toEqual([expect.stringMatching(new RegExp(`^- ${FACT} · a3 · \\d{4}-\\d{2}-\\d{2}$`))]);
    expect(evs.find((e) => e.type === 'memory.write')).toMatchObject({ fact: FACT });
    // Un duplicado exacto no suma otra línea.
    steps.push(async (_req, mcp) => { await mcp('remember', { fact: FACT }); });
    await run(at, { prompt: 'otra', messageId: 'a4', parentId: 'a3', brand: BRAND });
    expect(lines(await memoryOf(at))).toHaveLength(1);
  });

  test('rechaza correos, teléfonos, tokens y hechos de más de 200 caracteres sin escribir', async () => {
    const at = await boot();
    const replies: McpResult[] = [];
    steps.push(async (_req, mcp) => {
      for (const fact of ['El contacto es ana@acme.com', 'Llamar al +52 55 1234 5678', 'La key es sk_live_51HxYzAbCdEfGhIjKlMnOp', 'x'.repeat(201)]) replies.push(await mcp('remember', { fact }));
    });
    await run(at, { prompt: 'landing', messageId: 'a5', brand: BRAND });
    expect(replies.map((r) => r.isError)).toEqual([true, true, true, true]);
    expect(lines(await memoryOf(at))).toEqual([]);
  });

  test('llena (40 líneas) falla con "memoria llena: usa replaces"; replaces sustituye y lo marca en el evento', async () => {
    const at = await boot();
    const full = Array.from({ length: 40 }, (_, i) => `- hecho ${i} · seed · 2026-11-04`).join('\n');
    expect((await send(at, 'PUT', `/brands/${BRAND}/memory`, { text: full })).ok).toBe(true);
    let over: McpResult | undefined;
    let swap: McpResult | undefined;
    steps.push(async (_req, mcp) => {
      over = await mcp('remember', { fact: FACT });
      swap = await mcp('remember', { fact: FACT, replaces: 'hecho 7' });
    });
    const evs = await run(at, { prompt: 'landing', messageId: 'a6', brand: BRAND });
    expect(over).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('memoria llena: usa `replaces`') }] });
    expect(swap?.isError).toBeFalsy();
    const now = lines(await memoryOf(at));
    expect(now).toHaveLength(40);
    expect(now.some((l) => l.includes('hecho 7 '))).toBe(false);
    expect(now.some((l) => l.startsWith(`- ${FACT} · a6 · `))).toBe(true);
    expect(evs.find((e) => e.type === 'memory.write')).toMatchObject({ fact: FACT, replaced: expect.stringContaining('hecho 7') });
  });

  test('GET/PUT /brands/:id/memory: el PUT reemplaza y respeta los topes (40 líneas, 4 KiB, PII)', async () => {
    const at = await boot();
    expect(await memoryOf(at)).toBe('');
    expect((await send(at, 'PUT', `/brands/${BRAND}/memory`, { text: `- ${FACT} · persona · 2026-11-04` })).ok).toBe(true);
    expect(lines(await memoryOf(at))).toEqual([`- ${FACT} · persona · 2026-11-04`]);
    const tooMany = Array.from({ length: 41 }, (_, i) => `- h${i} · p · 2026-11-04`).join('\n');
    const tooBig = Array.from({ length: 30 }, (_, i) => `- ${'y'.repeat(150)}${i} · p · 2026-11-04`).join('\n');
    for (const text of [tooMany, tooBig, '- escribir a ana@acme.com · p · 2026-11-04']) expect((await send(at, 'PUT', `/brands/${BRAND}/memory`, { text })).status).toBe(400);
    expect(lines(await memoryOf(at))).toHaveLength(1);
  });
});

describe('M2 (b) la memoria llega inyectada al siguiente turno', () => {
  test('el turno siguiente de la misma marca la recibe; uno sin marca no', async () => {
    const at = await boot();
    steps.push(async (_req, mcp) => { await mcp('remember', { fact: FACT }); });
    await run(at, { prompt: 'landing', messageId: 'b1', brand: BRAND });
    await run(at, { prompt: 'cambia el hero', messageId: 'b2', parentId: 'b1', brand: BRAND });
    await run(at, { prompt: 'otra landing', messageId: 'b3' });
    // Inyectada en el request del composer (que la lleva al bloque MEMORIA DE LA MARCA), no leída por tools.
    expect(JSON.stringify(seen[1])).toContain(FACT);
    expect(JSON.stringify(seen[2])).not.toContain(FACT);
  });
});

// M2 (c) C6: en tests/instructions-inherit.test.ts, que va verde y se mergea aparte.

describe('M2 (d) facts.invented', () => {
  test('al cerrar el turno emite planInvented del page-plan.md de la versión', async () => {
    const at = await boot();
    steps.push(async (req) => { writeFileSync(join(req.workspace?.dir as string, 'page-plan.md'), PLAN_MD); });
    const evs = await run(at, { prompt: 'landing', messageId: 'd1' });
    const expected = planInvented(parsePagePlanMd(PLAN_MD));
    expect(expected).toEqual([{ slug: '01-hero', text: '3 cifras del mockup' }]);
    expect(evs.find((e) => e.type === 'facts.invented')).toMatchObject({ items: expected });
    expect((foldMessage(evs) as unknown as { invented?: unknown }).invented).toEqual(expected);
  });
});

describe('M2 (e) Q6 viewport de la persona', () => {
  const ctx = (seenBrowse: number[]): WorkspaceToolContext => ({
    dir: tmp,
    previews: { ensure: async () => ({ url: 'http://127.0.0.1:5399/' }) },
    browse: async (req) => { seenBrowse.push(req.viewport); return { pngs: [], texts: [], actionErrors: [], issues: [], mounted: [], overflow: { scrollWidth: req.viewport, clientWidth: req.viewport, offenders: [] }, pageHeight: 800, shownHeight: 800, from: 0 } as never; },
    viewport: { width: 1280, height: 800 },
  } as WorkspaceToolContext);

  // Contrato confirmado por orq (wt-orq workspace-tools.ts): sin viewport mide al ancho y alto de la persona; 1440 y 375 se
  // respetan sin arrastrar su alto; otro ancho que no sea el suyo se rechaza.
  test('el browser sin viewport mide al ancho de la persona (1280 × 800)', async () => {
    const widths: number[] = [];
    expect((await runWorkspaceTool('browser', { full: false }, ctx(widths))).ok).toBe(true);
    expect(widths).toEqual([1280]);
    expect(parseBrowseInput({}, { width: 1280, height: 800 })).toMatchObject({ ok: true, value: { viewport: 1280 } });
  });

  test('1440 y 375 se respetan; el ancho de la persona se acepta; otro ancho se rechaza nombrándolo', async () => {
    const widths: number[] = [];
    for (const viewport of [1440, 375, 1280]) expect((await runWorkspaceTool('browser', { viewport, full: false }, ctx(widths))).ok).toBe(true);
    expect(widths).toEqual([1440, 375, 1280]);
    const other = parseBrowseInput({ viewport: 1024 }, { width: 1280, height: 800 });
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('1280') });
    // Sin persona, como hoy: solo 1440 o 375.
    expect(parseBrowseInput({ viewport: 1280 }).ok).toBe(false);
  });

  test('el viewport del request llega al preview-check de la versión', async () => {
    const got: unknown[] = [];
    const previews = { ensure: async () => ({ url: 'http://127.0.0.1:5399/', localUrl: 'http://127.0.0.1:5399/', port: 5399 }), drainErrors: () => [] } as unknown as PreviewPool;
    const previewCheck: PreviewChecker = async (_url, _dir, opts) => { got.push((opts as { viewport?: unknown } | undefined)?.viewport); return []; };
    const at = await boot({ previews, previewCheck });
    await run(at, { prompt: 'landing', messageId: 'e1', viewport: { width: 1280, height: 800 } });
    expect(got).toEqual([{ width: 1280, height: 800 }]);
  });
});

describe('M2 (f) context.usage', () => {
  test('cada turno con agente emite context.usage desde agent.trace.context y el fold lo guarda', async () => {
    const at = await boot();
    const t1 = await run(at, { prompt: 'landing', messageId: 'f1' });
    const t2 = await run(at, { prompt: 'cambia el hero', messageId: 'f2', parentId: 'f1' });
    for (const evs of [t1, t2]) {
      expect(evs.filter((e) => e.type === 'context.usage')).toEqual([expect.objectContaining(CONTEXT)]);
      expect((foldMessage(evs) as unknown as { contextUsage?: unknown }).contextUsage).toEqual(CONTEXT);
    }
  });

  test('memory.write queda en el fold como memoryWrites', async () => {
    const at = await boot();
    steps.push(async (_req, mcp) => { await mcp('remember', { fact: FACT }); });
    const evs = await run(at, { prompt: 'landing', messageId: 'f3', brand: BRAND });
    expect((foldMessage(evs) as unknown as { memoryWrites?: unknown }).memoryWrites).toEqual([{ fact: FACT }]);
  });
});
