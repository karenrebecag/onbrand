import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentArgs } from '../src/runtime/agent-loop';
import { workspaceMcpConfig } from '../src/runtime/workspace-mcp';
import { Approvals, APPROVAL_MCP_SCRIPT, APPROVAL_TOOL, withApprovalServer, type ApprovalSink, type PermissionReply } from '../src/runtime/approvals';
import type { ApprovalDecision, ApprovalRequest, EngineEvent } from '../src/runtime/events';
import { agentDescribe, reasonOf, Runtime, type Composer } from '../src/runtime/server';
import { Connectors } from '../src/runtime/connectors';

const WRITE = { tool_name: 'mcp__slack__send_message', input: { channel: 'C1', text: 'hola' }, tool_use_id: 'toolu_1' };

function sink(): ApprovalSink & { requests: ApprovalRequest[]; decisions: ApprovalDecision[]; scopes: (string | undefined)[] } {
  const requests: ApprovalRequest[] = [];
  const decisions: ApprovalDecision[] = [];
  const scopes: (string | undefined)[] = [];
  return { requests, decisions, scopes, request: (r) => requests.push(r), decision: (_id, d, scope) => { decisions.push(d); scopes.push(scope); } };
}

describe('approvals', () => {
  test('sin allow la llamada no pasa: queda pendiente con su tarjeta hasta que se decide', async () => {
    const a = new Approvals();
    const s = sink();
    let reply: PermissionReply | undefined;
    const p = a.ask('chat', 'ask', new Set(), WRITE, s).then((r) => (reply = r));
    await new Promise((r) => setTimeout(r, 20));
    expect(reply).toBeUndefined();
    expect(s.requests).toEqual([{ callId: 'toolu_1', toolName: WRITE.tool_name, app: 'slack', input: WRITE.input, kind: 'write' }]);
    a.decide('chat', 'toolu_1', 'allow');
    await p;
    expect(reply).toEqual({ behavior: 'allow', updatedInput: WRITE.input });
  });

  test('GET de la tarjeta lee el pending con la forma del orquestador; 404 por otro chat y por vencido', async () => {
    let t = 1_000_000;
    const a = new Approvals(100_000, undefined, undefined, () => t);
    const s = sink();
    const p = a.ask('chat', 'ask', new Set(), WRITE, s);
    // Existe: misma forma que routes.ts pendingView (patrones derivados de la tool; conector = sin rememberPatterns).
    expect(a.pendingView('chat', 'toolu_1')).toEqual({
      callId: 'toolu_1',
      tool: WRITE.tool_name,
      patterns: [`Tool(${WRITE.tool_name}:*)`],
      rememberPatterns: [],
      input: WRITE.input,
      expiresAt: 1_000_000 + 100_000,
    });
    expect(a.pendingView('otro', 'toolu_1')).toBeUndefined(); // de otro chat
    t = 1_000_000 + 100_001; // el reloj pasó el vencimiento
    expect(a.pendingView('chat', 'toolu_1')).toBeUndefined();
    a.decide('chat', 'toolu_1', 'skip');
    await p;
  });

  test('tras decidir, el GET sigue dando la tarjeta con su decisión (no 404) mientras viva el proceso', async () => {
    const a = new Approvals(100_000);
    const s = sink();
    const p = a.ask('chat', 'ask', new Set(), WRITE, s);
    a.decide('chat', 'toolu_1', 'skip');
    await p;
    const card = a.pendingView('chat', 'toolu_1');
    expect(card?.decision).toBe('skip');
    expect(card?.tool).toBe(WRITE.tool_name);
    expect(a.pendingView('otro', 'toolu_1')).toBeUndefined(); // decidida pero de otro chat: 404
  });

  test('skip deniega con el mensaje del contrato', async () => {
    const a = new Approvals();
    const s = sink();
    const p = a.ask('chat', 'ask', new Set(), WRITE, s);
    a.decide('chat', 'toolu_1', 'skip');
    expect(await p).toEqual({ behavior: 'deny', message: 'El usuario no aprobó mcp__slack__send_message (skip)' });
    expect(s.decisions).toEqual(['skip']);
    // Ya decidido: otra decisión es 409.
    expect(() => a.decide('chat', 'toolu_1', 'allow')).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('vencido el plazo deniega como timeout', async () => {
    const a = new Approvals(10);
    const s = sink();
    expect(await a.ask('chat', 'ask', new Set(), WRITE, s)).toEqual({ behavior: 'deny', message: 'El usuario no aprobó mcp__slack__send_message (timeout)' });
    expect(s.decisions).toEqual(['timeout']);
  });

  test('auto deja pasar las lecturas sin tarjeta y sigue preguntando las escrituras', async () => {
    const a = new Approvals(10);
    const s = sink();
    const read = { ...WRITE, tool_name: 'mcp__slack__list_channels', tool_use_id: 'toolu_r' };
    expect(await a.ask('chat', 'auto', new Set([read.tool_name]), read, s)).toEqual({ behavior: 'allow', updatedInput: WRITE.input });
    await a.ask('chat', 'auto', new Set([read.tool_name]), WRITE, s);
    expect(s.requests.map((r) => r.kind)).toEqual(['write']);
  });

  test('lo que no es de conector se deniega sin preguntar', async () => {
    const a = new Approvals();
    const s = sink();
    for (const tool_name of ['Bash', 'mcp__wt__browser']) expect((await a.ask('chat', 'auto', new Set(), { ...WRITE, tool_name }, s)).behavior).toBe('deny');
    expect(s.requests).toEqual([]);
  });

  test('generate_image: sin aprobación no corre, "siempre" vale para todos los chats, y la preaprobación del T1 no lo guarda', async () => {
    const a = new Approvals(10);
    const s = sink();
    const img = { tool_name: 'mcp__wt__generate_image', input: { prompt: 'p', target_path: '/images/a.jpg' }, tool_use_id: 'toolu_i1' };
    // T1 con imágenes: pasa sin tarjeta, pero el siguiente turno vuelve a preguntar (y vence: no hay "siempre").
    expect((await a.ask('chat', 'ask', new Set(), img, s, undefined, true)).behavior).toBe('allow');
    expect(await a.ask('chat', 'auto', new Set(), { ...img, tool_use_id: 'toolu_i2' }, s)).toEqual({ behavior: 'deny', message: 'El usuario no aprobó mcp__wt__generate_image (timeout)' });
    expect(s.requests.map((r) => [r.kind, r.app])).toEqual([['spend', 'wt']]);
    const p = a.ask('chat', 'ask', new Set(), { ...img, tool_use_id: 'toolu_i3' }, s);
    a.decide('chat', 'toolu_i3', 'always');
    expect((await p).behavior).toBe('allow');
    expect(s.decisions).toEqual(['timeout', 'allow']);
    // QA G3a: el "Permitir siempre" queda en el evento como allow con scope always.
    expect(s.scopes).toEqual([undefined, 'always']);
    // Con "siempre" no espera decisión, pero la tarjeta llega resuelta (R4.5: ahí cuelga "Preguntar cada vez", Lovable
    // app-lazy-surfaces :1743-1748).
    expect((await a.ask('chat', 'ask', new Set(), { ...img, tool_use_id: 'toolu_i4' }, s)).behavior).toBe('allow');
    expect(s.requests).toHaveLength(3);
    // El "siempre" vale para cualquier chat, como el de Lovable ("Images generated from any chat", registry :4855-4859).
    expect((await a.ask('otro', 'ask', new Set(), { ...img, tool_use_id: 'toolu_i5' }, s)).behavior).toBe('allow');
    expect(s.requests).toHaveLength(4);
    expect(s.scopes.slice(2)).toEqual(['always', 'always']);
  });
});

test('el CLI recibe la permission-prompt-tool junto al servidor wt, con el token en env y no en args', () => {
  const config = withApprovalServer(workspaceMcpConfig('/ws', 'http://127.0.0.1:5173').config, { url: 'http://127.0.0.1:1/approval-requests', token: 'secreto' });
  const servers = JSON.parse(config).mcpServers;
  expect(Object.keys(servers)).toEqual(['wt', 'approval']);
  expect(servers.approval.env.WT_APPROVAL_TOKEN).toBe('secreto');
  const args = agentArgs({ dir: '/ws', system: '', prompt: '', model: 'sonnet', allowedTools: [], mcpConfig: config, permissionPromptTool: APPROVAL_TOOL });
  expect(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2)).toEqual(['--permission-prompt-tool', 'mcp__approval__approve']);
  expect(servers.approval.args.join(' ')).not.toContain('secreto');
});

test('el motivo de la tarjeta es lo que el agente escribió desde la última tool terminada', () => {
  const ev = (b: object, seq: number) => ({ v: 1, messageId: 'm', seq, at: seq, ...b }) as EngineEvent;
  const events = [
    ev({ type: 'message.start' }, 0),
    ev({ type: 'text.delta', text: 'Leo la página.' }, 1),
    ev({ type: 'step.end', stepId: 's1', label: 'Read', status: 'ok' }, 2),
    ev({ type: 'text.delta', text: 'Aviso al equipo en #ventas ' }, 3),
    ev({ type: 'text.delta', text: 'que la landing está lista.' }, 4),
    ev({ type: 'step.start', stepId: 'toolu_1', kind: 'tool', label: 'slack' }, 5),
  ];
  expect(reasonOf(events)).toBe('Aviso al equipo en #ventas que la landing está lista.');
  expect(reasonOf(events.slice(0, 3))).toBeUndefined();
});

describe('approvals por el transport', () => {
  let tmp: string;
  let server: Server;
  afterEach(() => {
    server?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // La cadena real: approval-mcp con la URL y el token del env, el endpoint interno y la decisión del builder.
  test('approval-mcp bloquea hasta POST /chats/:id/approvals/:callId y devuelve la decisión al CLI', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffold');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    let reply: unknown;
    const compose: Composer = async (req) => {
      expect(req.approval?.token).toBeString();
      const child = spawn('bun', [APPROVAL_MCP_SCRIPT], { env: { ...process.env, WT_APPROVAL_URL: req.approval?.url, WT_APPROVAL_TOKEN: req.approval?.token }, stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'approve', arguments: WRITE } })}\n`);
      const line = await new Promise<string>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(d.toString())));
      child.kill();
      reply = JSON.parse(JSON.parse(line).result.content[0].text);
      const dir = req.workspace?.dir as string;
      writeFileSync(join(dir, 'src', 'App.tsx'), 'export default function App() { return <main />; }\n');
      return { sections: [], page: { lang: 'es' }, agent: { files: ['src/App.tsx'], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'state'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault') });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'a1' }) });
    let pending = false;
    for (let i = 0; i < 200 && !pending; i++) {
      const { events } = (await (await fetch(`${base}/runs/a1`)).json()) as { events: EngineEvent[] };
      pending = events.some((e) => e.type === 'approval.request' && e.callId === 'toolu_1');
      if (!pending) await new Promise((r) => setTimeout(r, 25));
    }
    expect(pending).toBe(true);
    const decide = (decision: string) => fetch(`${base}/chats/a1/approvals/toolu_1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
    expect((await decide('skip')).status).toBe(200);
    expect((await decide('allow')).status).toBe(409);
    const text = await (await fetch(`${base}/runs/a1/events?cursor=-1`)).text();
    const evs = text.trim().split('\n').map((l) => JSON.parse(l) as EngineEvent);
    expect(evs.find((e) => e.type === 'approval.decision')).toMatchObject({ callId: 'toolu_1', decision: 'skip' });
    expect(reply).toEqual({ behavior: 'deny', message: 'El usuario no aprobó mcp__slack__send_message (skip)' });
  }, 20_000);

  test('en auto, la lectura que declaró la app de ESTA corrida pasa sin tarjeta; en otra corrida que ya no la declara, se pregunta', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldR');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    let marksRead = true;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/v1/oauth/token')) return Response.json({ access_token: 't', expires_in: 3600 });
      const body = JSON.parse(String(init?.body)) as { method: string };
      return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'initialize' ? {} : { tools: [{ name: 'slack-list-channels', annotations: { readOnlyHint: marksRead } }] } });
    }) as typeof fetch;
    const connectors = new Connectors({ clientId: 'id', clientSecret: 's', projectId: 'proj', environment: 'development', externalUserId: 'u1' }, f);
    const replies: unknown[] = [];
    const compose: Composer = async (req) => {
      const res = await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': req.approval?.token as string }, body: JSON.stringify({ tool_name: 'mcp__slack__slack-list-channels', input: {}, tool_use_id: `toolu_${req.messageId}` }) });
      replies.push(await res.json());
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'stateR'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), connectors, approvalTimeoutMs: 100 });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const run = async (messageId: string) => {
      await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId, permissionMode: 'auto', connectors: ['slack'] }) });
      return (await fetch(`${base}/runs/${messageId}/events?cursor=-1`)).text();
    };
    expect(await run('r1')).not.toContain('approval.request');
    expect(replies[0]).toEqual({ behavior: 'allow', updatedInput: {} });
    marksRead = false;
    expect(await run('r2')).toContain('approval.request');
    expect(replies[1]).toMatchObject({ behavior: 'deny' });
  }, 20_000);

  test('/connector-mcp: el transport pone el token de Pipedream; tools/call solo con aprobación de la corrida; otra app da 403', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldC');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const upstream: { auth: string | null; method: string }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/v1/oauth/token')) return Response.json({ access_token: 'pd-secreto', expires_in: 3600 });
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      upstream.push({ auth: (init?.headers as Record<string, string>).authorization ?? null, method: body.method });
      const result = body.method === 'tools/list' ? { tools: [{ name: 'list', annotations: { readOnlyHint: true } }, { name: 'send' }] } : body.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : {};
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    }) as typeof fetch;
    const connectors = new Connectors({ clientId: 'id', clientSecret: 's', projectId: 'proj', environment: 'development', externalUserId: 'u1' }, f);
    const seen: Record<string, unknown> = {};
    const compose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const headers = { 'x-wt-approval-token': req.approval?.token as string };
      const rpc = async (slug: string, body: unknown) => { const r = await fetch(`${origin}/connector-mcp/${slug}`, { method: 'POST', headers, body: JSON.stringify(body) }); return r.status === 200 ? r.json() : r.status; };
      seen.list = await rpc('slack', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      seen.sendSinAprobar = await rpc('slack', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send', arguments: {} } });
      await fetch(req.approval?.url as string, { method: 'POST', headers, body: JSON.stringify({ tool_name: 'mcp__slack__list', input: {}, tool_use_id: 'toolu_l' }) });
      seen.listAprobada = await rpc('slack', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list', arguments: {} } });
      seen.listOtraVez = await rpc('slack', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list', arguments: {} } });
      seen.otraApp = await rpc('gmail', { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
      seen.recurso = await rpc('slack', { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'x' } });
      const approve = (input: unknown, id: string) => fetch(req.approval?.url as string, { method: 'POST', headers, body: JSON.stringify({ tool_name: 'mcp__slack__send', input, tool_use_id: id }) });
      const decided = approve({ text: 'hola', canal: 'a' }, 'toolu_s');
      for (let i = 0; i < 200; i++) { if ((await fetch(`${origin}/chats/c1/approvals/toolu_s`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) })).status === 200) break; await new Promise((r) => setTimeout(r, 10)); }
      await decided;
      seen.sendOtrosArgs = await rpc('slack', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'send', arguments: { text: 'otro', canal: 'a' } } });
      seen.sendMismosArgs = await rpc('slack', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send', arguments: { canal: 'a', text: 'hola' } } });
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'stateC'), allow: {}, compose, agent: true, build: false, imageModels: [], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), connectors });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'c1', permissionMode: 'auto', connectors: ['slack'] }) });
    const text = await (await fetch(`${base}/runs/c1/events?cursor=-1`)).text();
    expect(seen.list).toMatchObject({ id: 1, result: { tools: [{ name: 'list' }, { name: 'send' }] } });
    expect(seen.sendSinAprobar).toMatchObject({ id: 2, error: { code: -32001 } });
    expect(seen.listAprobada).toMatchObject({ id: 3, result: { content: [{ text: 'ok' }] } });
    // Una aprobación vale para una llamada.
    expect(seen.listOtraVez).toMatchObject({ id: 4, error: { code: -32001 } });
    expect(seen.otraApp).toBe(403);
    expect(seen.recurso).toMatchObject({ id: 6, error: { code: -32601 } });
    // La tarjeta aprobó send con esos argumentos: otros argumentos no pasan; los mismos en otro orden sí.
    expect(seen.sendOtrosArgs).toMatchObject({ id: 7, error: { code: -32001 } });
    expect(seen.sendMismosArgs).toMatchObject({ id: 8, result: { content: [{ text: 'ok' }] } });
    expect(upstream.filter((u) => u.method === 'tools/call')).toHaveLength(2);
    expect(upstream.every((u) => u.auth === 'Bearer pd-secreto')).toBe(true);
    expect(text).not.toContain('pd-secreto');
  }, 20_000);
  // Fix de la key de imagen (KAREN 2026-11-02, MCP por HTTP): el wt lo sirve el transport y las tools de imagen corren
  // allá, con su proveedor; el CLI y su env filtrado nunca tocan la key.
  test('/mcp/:id: 401 sin token o con el de otra corrida; generate_image corre en el transport solo con aprobación y la consume', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldM');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    const genModels: string[] = [];
    const seen: Record<string, unknown> = {};
    const compose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const token = req.approval?.token as string;
      const rpc = async (id: string, auth: string, body: unknown, method = 'POST') => {
        const r = await fetch(`${origin}/mcp/${id}`, { method, headers: { 'content-type': 'application/json', authorization: auth }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: (await r.json().catch(() => null)) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } } | null };
      };
      const args = { prompt: 'equipo de ventas mirando el celular', target_path: '/images/hero.jpg' };
      const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: args } };
      seen.noToken = (await rpc(req.messageId, 'Bearer nope', { jsonrpc: '2.0', id: 1, method: 'initialize' })).status;
      seen.otherRun = (await rpc('otro', `Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'initialize' })).status;
      seen.sse = (await rpc(req.messageId, `Bearer ${token}`, null, 'GET')).status;
      seen.init = (await rpc(req.messageId, `Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).body;
      seen.tools = (await rpc(req.messageId, `Bearer ${token}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body?.result?.tools?.map((t) => t.name);
      seen.unapproved = (await rpc(req.messageId, `Bearer ${token}`, call)).body?.result;
      // La T1 está preaprobada para gastar: la permission-prompt-tool del CLI recibe allow y deja la aprobación en la corrida.
      await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': token }, body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', input: args, tool_use_id: 'toolu_img' }) });
      seen.approved = (await rpc(req.messageId, `Bearer ${token}`, call)).body?.result;
      seen.file = existsSync(join(req.workspace?.dir as string, 'public', 'images', 'hero.jpg'));
      seen.again = (await rpc(req.messageId, `Bearer ${token}`, call)).body?.result;
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'stateM'), allow: {}, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), imageService: { gen: (m) => async () => { genModels.push(m); return { bytes: JPG, mediaType: 'image/jpeg' }; } } });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'i1', imageGeneration: { modelId: 'img-1' } }) });
    await (await fetch(`${base}/runs/i1/events?cursor=-1`)).text();
    expect(seen.noToken).toBe(401);
    expect(seen.otherRun).toBe(401);
    expect(seen.sse).toBe(405);
    expect(seen.init).toMatchObject({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    expect(seen.tools).toContain('typecheck');
    expect(seen.tools).toContain('generate_image');
    // Sin editor en el proveedor (como el cli), edit_image no existe en el turno.
    expect(seen.tools).not.toContain('edit_image');
    expect(seen.unapproved).toMatchObject({ isError: true, content: [{ text: 'generate_image sin aprobación en esta corrida' }] });
    expect(seen.approved).not.toHaveProperty('isError');
    expect(seen.file).toBe(true);
    expect(genModels).toEqual(['img-1']);
    expect(seen.again).toMatchObject({ isError: true });
  }, 20_000);
  // Arq sobre b982009: el tope de --product-image-only cuenta llamadas por mensaje en el transport, no rutas en un archivo
  // del workspace que el agente puede borrar. Un fallo deja un reintento; después, ni la misma ruta llama al generador.
  test('/mcp: con imagesPerRun 1, un fallo deja un reintento y la tercera llamada se rechaza sin gastar, aunque borre .wt', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldCap');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    let calls = 0;
    const results: { isError?: boolean; content?: { text: string }[] }[] = [];
    const compose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const token = req.approval?.token as string;
      const generate = async (n: number, target: string) => {
        const args = { prompt: 'equipo', target_path: target };
        await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': token }, body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', input: args, tool_use_id: `toolu_${n}` }) });
        const r = await fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'generate_image', arguments: args } }) });
        results.push(((await r.json()) as { result: { isError?: boolean; content?: { text: string }[] } }).result);
      };
      await generate(1, '/images/hero.jpg');
      await generate(2, '/images/hero.jpg');
      rmSync(join(req.workspace?.dir as string, '.wt'), { recursive: true, force: true });
      await generate(3, '/images/hero.jpg');
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const gen = () => async () => { calls++; if (calls === 1) throw new Error('timeout'); return { bytes: JPG, mediaType: 'image/jpeg' }; };
    const t = new Runtime({ root: join(tmp, 'stateCap'), allow: {}, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), imageService: { gen }, imagesPerRun: 1 });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'cap1', imageGeneration: { modelId: 'img-1' } }) });
    await (await fetch(`${base}/runs/cap1/events?cursor=-1`)).text();
    expect(results.map((r) => Boolean(r.isError))).toEqual([true, false, true]);
    expect(results[2]?.content?.[0]?.text).toContain('admite 1 imagen');
    expect(calls).toBe(2);
  }, 20_000);

  // Arq sobre d04a933: dos tool_use paralelos no pasan los dos el tope (inFlight).
  test('/mcp: con imagesPerRun 1, dos generate_image a la vez generan una sola imagen', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldPar');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    let calls = 0;
    let errors: boolean[] = [];
    const compose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const token = req.approval?.token as string;
      const generate = async (n: number) => {
        const args = { prompt: 'equipo', target_path: `/images/p${n}.jpg` };
        await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': token }, body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', input: args, tool_use_id: `toolu_p${n}` }) });
        const r = await fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'generate_image', arguments: args } }) });
        return Boolean(((await r.json()) as { result: { isError?: boolean } }).result.isError);
      };
      errors = await Promise.all([generate(1), generate(2)]);
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const gen = () => async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return { bytes: JPG, mediaType: 'image/jpeg' }; };
    const t = new Runtime({ root: join(tmp, 'statePar'), allow: {}, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), imageService: { gen }, imagesPerRun: 1 });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'par1', imageGeneration: { modelId: 'img-1' } }) });
    await (await fetch(`${base}/runs/par1/events?cursor=-1`)).text();
    expect(errors.filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
  }, 20_000);

  // security-reviewer 2026-11-02 H1: browser con question no gasta el gateway del transport sin tarjeta.
  test('la visión del agente no usa el gateway del transport', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    await expect(agentDescribe('gateway')([], 'q', 1000)).rejects.toThrow('no está disponible');
  });

  // security-reviewer 2026-11-02 M1: una imagen que llega después de cerrar la corrida no se escribe en el workspace.
  test('/mcp: generate_image que termina con la corrida cerrada no escribe la imagen', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'v0-approvals-'));
    const scaffold = join(tmp, 'scaffoldK');
    mkdirSync(join(scaffold, 'src'), { recursive: true });
    writeFileSync(join(scaffold, '.gitignore'), 'node_modules\n');
    const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    let release: () => void = () => undefined;
    let started = false;
    let generated = false;
    let pending: Promise<{ result?: { isError?: boolean; content?: { text: string }[] } }> | undefined;
    let dir = '';
    const compose: Composer = async (req) => {
      const origin = new URL(req.approval?.url as string).origin;
      const token = req.approval?.token as string;
      dir = req.workspace?.dir as string;
      const args = { prompt: 'equipo', target_path: '/images/tarde.jpg' };
      await fetch(req.approval?.url as string, { method: 'POST', headers: { 'x-wt-approval-token': token }, body: JSON.stringify({ tool_name: 'mcp__wt__generate_image', input: args, tool_use_id: 'toolu_k' }) });
      pending = fetch(`${origin}/mcp/${req.messageId}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: args } }) }).then((r) => r.json() as never);
      while (!started) await new Promise((r) => setTimeout(r, 5));
      return { sections: [], page: { lang: 'es' }, agent: { files: [], summary: 'Listo', missing: [], suggestions: [] } };
    };
    const t = new Runtime({ root: join(tmp, 'stateK'), allow: {}, compose, agent: true, build: false, imageModels: [{ id: 'img-1', name: 'Img', provider: 'test' }], heartbeatMs: 50, scaffoldDir: scaffold, vaultRoot: join(tmp, 'vault'), imageService: { gen: () => async () => { started = true; await new Promise<void>((r) => { release = r; }); generated = true; return { bytes: JPG, mediaType: 'image/jpeg' }; } } });
    server = t.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'landing', messageId: 'k1', imageGeneration: { modelId: 'img-1' } }) });
    await (await fetch(`${base}/runs/k1/events?cursor=-1`)).text();
    // Con R1.6 el /mcp responde apenas la corrida cierra, sin esperar a un generador que no atiende su señal.
    const out = await pending;
    expect(out?.result).toMatchObject({ isError: true });
    expect(out?.result?.content?.[0]?.text).toContain('la corrida se detuvo');
    // Y cuando ese generador termina igual, la imagen no se escribe.
    release();
    while (!generated) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(dir, 'public', 'images', 'tarde.jpg'))).toBe(false);
  }, 20_000);
});
