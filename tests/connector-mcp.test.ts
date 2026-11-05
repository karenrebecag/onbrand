import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { CONNECTOR_PROXY_SCRIPT, connectorProxyServers, listReadOnlyTools, mcpPost, parseJsonRpc, pipedreamHeaders, UPSTREAM_MAX_BYTES } from '../src/runtime/connector-mcp';
import { Connectors } from '../src/runtime/connectors';
import { agentEnv } from '../src/runtime/agent-loop';

const cfg = { clientId: 'id', clientSecret: 'secret', projectId: 'proj', environment: 'development', externalUserId: 'u1' };
const tools = { tools: [{ name: 'slack-list-channels', annotations: { readOnlyHint: true } }, { name: 'slack-send-message', annotations: { readOnlyHint: false } }, { name: 'slack-sin-hint' }, { name: 'otra__send', annotations: { readOnlyHint: true } }] };

describe('conectores como MCP del agente', () => {
  test('el --mcp-config del agente solo lleva proxies stdio al transport: ni el token ni las cabeceras de Pipedream', () => {
    expect(pipedreamHeaders('slack', cfg, 'tok')).toEqual({ authorization: 'Bearer tok', 'x-pd-project-id': 'proj', 'x-pd-environment': 'development', 'x-pd-external-user-id': 'u1', 'x-pd-app-slug': 'slack' });
    const servers = connectorProxyServers(['slack'], { url: 'http://127.0.0.1:5300/approval-requests', token: 'run-tok' }, '/p.ts');
    expect(servers).toEqual({ slack: { command: 'bun', args: ['/p.ts'], env: { WT_CONNECTOR_URL: 'http://127.0.0.1:5300/connector-mcp/slack', WT_APPROVAL_TOKEN: 'run-tok' } } });
    expect(JSON.stringify(servers)).not.toMatch(/Bearer|x-pd-|pipedream/);
  });

  test('el CLI del agente no hereda las credenciales del transport, sí las suyas', () => {
    const env = agentEnv({ PATH: '/bin', PIPEDREAM_CLIENT_SECRET: 's', PIPEDREAM_CLIENT_ID: 'i', BLOB_READ_WRITE_TOKEN: 'b', VERCEL_OIDC_TOKEN: 'v', WT_ORIGIN_SECRET: 'o', WT_HOST: '0.0.0.0', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'c' });
    // WT_ORIGIN_SECRET: el visitante del Sandbox escribe el prompt y le pediría al agente su env (security-reviewer, deploy).
    expect(env).toEqual({ PATH: '/bin', WT_HOST: '0.0.0.0', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'c' });
  });

  test('WT_FACTS_URL, que puede traer credenciales del proxy de hechos, no llega al CLI del agente', () => {
    const env = agentEnv({ PATH: '/bin', WT_FACTS_URL: 'https://user:tok@proxy.test/v1?key=k', WT_TZ: 'UTC' });
    expect(env.WT_FACTS_URL).toBeUndefined();
    expect(env.WT_TZ).toBe('UTC');
  });

  test('la credencial del colector OTLP no llega al agente', () => {
    // H20 R20-a: el exporter OTLP del transport lee OTEL_EXPORTER_OTLP_HEADERS ("authorization=Bearer …"); en el Sandbox
    // público un prompt le pediría al agente su env y se llevaría el token del colector.
    const env = agentEnv({ PATH: '/bin', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer t', OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-key=k', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c', WT_OTLP_URL: 'https://c/v1/traces', WT_OTLP_HEADERS: 'x-key=k' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  test('el fetch al upstream no sigue redirecciones y corta una respuesta de más de 1 MB', async () => {
    const seen: RequestInit[] = [];
    const big = (async (_u: string | URL | Request, init?: RequestInit) => { seen.push(init as RequestInit); return new Response('x'.repeat(UPSTREAM_MAX_BYTES + 1)); }) as typeof fetch;
    await expect(mcpPost({}, { jsonrpc: '2.0', id: 1, method: 'ping' }, undefined, big)).rejects.toThrow(/más de/);
    expect(seen[0].redirect).toBe('error');
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('el proxy stdio reenvía el JSON-RPC al transport con el token de la corrida y devuelve su respuesta', async () => {
    const got: { auth: string | null; body: unknown }[] = [];
    const srv = Bun.serve({ port: 0, fetch: async (r) => { const body = await r.json(); got.push({ auth: r.headers.get('x-wt-approval-token'), body }); return Response.json({ jsonrpc: '2.0', id: (body as { id: number }).id, result: { ok: true } }); } });
    try {
      const child = spawn('bun', [CONNECTOR_PROXY_SCRIPT], { env: { ...process.env, WT_CONNECTOR_URL: `http://127.0.0.1:${srv.port}/connector-mcp/slack`, WT_APPROVAL_TOKEN: 'run-tok' }, stdio: ['pipe', 'pipe', 'inherit'] });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })}\n`);
      const line = await new Promise<string>((resolve) => child.stdout.once('data', (d: Buffer) => resolve(d.toString())));
      child.kill();
      expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } });
      expect(got).toEqual([{ auth: 'run-tok', body: { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} } }]);
    } finally {
      srv.stop(true);
    }
  });

  test('tools/list: solo las tools con readOnlyHint, con prefijo del CLI; acepta JSON directo o event-stream', async () => {
    const calls: string[] = [];
    const f = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls.push(body.method);
      if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'mcp-session-id': 's1' } });
      expect((init?.headers as Record<string, string>)['mcp-session-id']).toBe('s1');
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: tools })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    expect(await listReadOnlyTools('slack', pipedreamHeaders('slack', cfg, 't'), f)).toEqual(['mcp__slack__slack-list-channels']);
    expect(calls).toEqual(['initialize', 'tools/list']);
    expect(parseJsonRpc('')).toBeUndefined();
  });

  test('Connectors.mcp: pide el token una vez, junta servidores y lecturas, y una app sin respuesta queda fuera sin tumbar', async () => {
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/oauth/token')) return Response.json({ access_token: 't', expires_in: 3600 });
      const slug = (init?.headers as Record<string, string>)['x-pd-app-slug'];
      if (slug === 'rota') return new Response('no', { status: 503 });
      const body = JSON.parse(String(init?.body)) as { method: string };
      return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'initialize' ? {} : tools });
    }) as typeof fetch;
    const r = await new Connectors(cfg, f).mcp(['slack', 'rota']);
    expect(r.apps).toEqual(['slack']);
    expect(r.readOnlyTools).toEqual(['mcp__slack__slack-list-channels']);
    expect(r.failed).toEqual(['rota']);
  });
});
