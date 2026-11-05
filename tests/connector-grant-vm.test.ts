import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, type Composer } from '../src/runtime/server';

// Spec orquestador-enrutamiento §8.1 del lado de la VM: la tarjeta se registra en el orquestador, la decisión de la persona deja un permiso que la VM recoge una vez
// y presenta con ESA llamada. El orquestador es falso (loopback); el de verdad lo cubre tests/orchestrator-route-table.test.ts.
let server: Server | undefined;
let fake: ReturnType<typeof Bun.serve> | undefined;
let tmp = '';
const saved = { base: process.env.WT_GATEWAY_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
afterEach(() => {
  server?.close(); fake?.stop(true); rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [['WT_GATEWAY_BASE_URL', saved.base], ['ANTHROPIC_AUTH_TOKEN', saved.token]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('la VM registra la tarjeta, recoge el permiso tras la decisión y lo presenta con la llamada aprobada (y con ninguna otra)', async () => {
  tmp = mkdtempSync(join(tmpdir(), 'connector-grant-'));
  const scaffold = join(tmp, 'scaffold');
  mkdirSync(join(scaffold, 'src'), { recursive: true });
  writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
  const calls: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
  fake = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const body = (await req.json()) as Record<string, unknown>;
    calls.push({ path: new URL(req.url).pathname, auth: req.headers.get('authorization'), body });
    return Response.json(new URL(req.url).pathname.endsWith('/grant') ? { grant: 'g.fake' } : { patterns: [], rememberPatterns: [], expiresAt: 1 });
  } });
  process.env.WT_GATEWAY_BASE_URL = `http://127.0.0.1:${fake.port}/gw/claude-code`;
  process.env.ANTHROPIC_AUTH_TOKEN = 'run-token-1';
  const forwarded: { slug: string; message: unknown; runToken?: string; proof?: unknown }[] = [];
  const connectorsRemote = {
    mcp: async () => ({ apps: ['slack'], readOnlyTools: ['mcp__slack__list'], failed: [] as string[] }),
    forward: async (slug: string, message: unknown, _s?: string, runToken?: string, proof?: unknown) => { forwarded.push({ slug, message, runToken, proof }); return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) }; },
  };
  const seen: Record<string, unknown> = {};
  const compose: Composer = async (req) => {
    const origin = new URL(req.approval?.url as string).origin;
    const headers = { 'x-wt-approval-token': req.approval?.token as string };
    const rpc = async (id: number, name: string, args: unknown) => { const r = await fetch(`${origin}/connector-mcp/slack`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) }); return r.json(); };
    const asked = fetch(req.approval?.url as string, { method: 'POST', headers, body: JSON.stringify({ tool_name: 'mcp__slack__send', input: { text: 'hola' }, tool_use_id: 'toolu_s' }) });
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${origin}/chats/c1/approvals/toolu_s`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) });
      if (r.status === 200) break;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    await asked;
    seen.conGrant = await rpc(1, 'send', { text: 'hola' });
    seen.otraVez = await rpc(2, 'send', { text: 'hola' });
    return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
  };
  const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), connectorsRemote });
  server = t.listen(0);
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wt-run-token': 'run-token-1' }, body: JSON.stringify({ prompt: 'landing', messageId: 'c1', permissionMode: 'auto', connectors: ['slack'] }) });
  await (await fetch(`${base}/runs/c1/events?cursor=-1`)).text();
  expect(calls.map((c) => c.path)).toEqual(['/gw/approvals/pending', '/gw/approvals/grant']);
  expect(calls.every((c) => c.auth === 'Bearer run-token-1')).toBe(true);
  expect(calls[0]!.body).toEqual({ callId: 'toolu_s', tool: 'mcp__slack__send', input: { text: 'hola' } });
  expect(forwarded[0]).toMatchObject({ slug: 'slack', runToken: 'run-token-1', proof: { callId: 'toolu_s', grant: 'g.fake' } });
  // El permiso es de una llamada: la segunda ni siquiera sale hacia el orquestador.
  expect(forwarded).toHaveLength(1);
  expect(seen.otraVez).toMatchObject({ error: { code: -32001 } });
}, 30_000);
