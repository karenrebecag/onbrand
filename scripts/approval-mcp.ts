// Permission-prompt-tool de `claude -p` (`--permission-prompt-tool mcp__approval__approve`): reenvía cada pedido al
// transport y devuelve su decisión. La URL y el token llegan por env desde --mcp-config, nunca por argv: el token
// ata el pedido a la corrida que lo lanzó y no debe quedar en `ps`.
//   WT_APPROVAL_URL=http://127.0.0.1:<port>/approval-requests WT_APPROVAL_TOKEN=<token> bun scripts/approval-mcp.ts

import { createInterface } from 'node:readline';
import { APPROVAL_TIMEOUT_MS, type PermissionReply } from '../src/runtime/approvals';

const url = process.env.WT_APPROVAL_URL;
const token = process.env.WT_APPROVAL_TOKEN;
if (!url || !token) { console.error('approval-mcp: faltan WT_APPROVAL_URL y WT_APPROVAL_TOKEN'); process.exit(2); }

// Margen sobre el timeout del transport: si él vence primero, su respuesta trae el `timeout` del contrato.
const FETCH_MARGIN_MS = 15_000;

const send = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

async function approve(args: unknown): Promise<PermissionReply> {
  try {
    const r = await fetch(url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wt-approval-token': token as string },
      body: JSON.stringify(args ?? {}),
      signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS + FETCH_MARGIN_MS),
    });
    if (!r.ok) return { behavior: 'deny', message: `aprobación no disponible (${r.status})` };
    return (await r.json()) as PermissionReply;
  } catch (e) {
    // Sin transport no hay quién apruebe: se deniega, nunca se deja pasar.
    return { behavior: 'deny', message: `aprobación no disponible (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function handle(req: { id?: number | string; method: string; params?: Record<string, unknown> }): Promise<void> {
  if (req.id === undefined) return;
  switch (req.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web-transformer-approval', version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'approve', description: 'Pide al usuario permiso para una tool de conector.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'tool_use_id'] } }] } });
    case 'tools/call': {
      if (req.params?.name !== 'approve') return send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'tool desconocida' }], isError: true } });
      const reply = await approve(req.params.arguments);
      return send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } });
    }
    case 'ping':
      return send({ jsonrpc: '2.0', id: req.id, result: {} });
    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `método ${req.method} no soportado` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req: Parameters<typeof handle>[0];
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  void handle(req);
});
