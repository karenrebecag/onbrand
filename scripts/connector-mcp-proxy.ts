// Servidor MCP stdio de una app conectada para `claude -p`: reenvía cada mensaje JSON-RPC al transport, que es quien
// tiene el token de Pipedream y pone las cabeceras. El agente puede leer este proceso y su --mcp-config (mismo uid), así
// que aquí solo hay la URL del transport y el token de la corrida, que no sirve fuera de ella.
//   WT_CONNECTOR_URL=http://127.0.0.1:<port>/connector-mcp/<slug> WT_APPROVAL_TOKEN=<token> bun scripts/connector-mcp-proxy.ts

import { createInterface } from 'node:readline';

const url = process.env.WT_CONNECTOR_URL;
const token = process.env.WT_APPROVAL_TOKEN;
if (!url || !token) { console.error('connector-mcp-proxy: faltan WT_CONNECTOR_URL y WT_APPROVAL_TOKEN'); process.exit(2); }

const FETCH_TIMEOUT_MS = 60_000;
const send = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

async function forward(msg: { id?: number | string }): Promise<void> {
  try {
    const r = await fetch(url as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wt-approval-token': token as string },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (msg.id === undefined) return;
    const text = await r.text();
    if (!r.ok || !text) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `conector no disponible (${r.status})` } });
    process.stdout.write(`${text.trim()}\n`);
  } catch (e) {
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `conector no disponible (${e instanceof Error ? e.message : String(e)})` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  void forward(msg as { id?: number | string });
});
