// Servidor MCP stdio con las tools de verificación del agente de página (typecheck, browser), para `claude -p`:
//   bun scripts/workspace-mcp.ts <workspace> <preview-url>
// La URL la da el transport, que ya tiene el preview del workspace arrancado; este proceso no levanta otro vite.
// JSON-RPC por líneas, el subconjunto de MCP que usa el CLI (initialize, tools/list, tools/call), sin dependencias.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { toMcpContent } from '../src/runtime/workspace-mcp';
import { MCP_PID_FILE } from '../src/runtime/tool-watchdog';
import { runWorkspaceTool, WORKSPACE_TOOL_DEFS, type WorkspaceToolContext } from '../src/runtime/workspace-tools';
import { IMAGE_MODEL_ENV } from '../src/runtime/workspace-mcp';
import { EDIT_IMAGE_DEF, gatewayImageEdit, IMAGE_TOOL_DEF } from '../src/runtime/image-tool';
import { defaultImageGen, imageProvider } from '../src/runtime/image-step';

const [dirArg, url] = process.argv.slice(2);
if (!dirArg || !url) { console.error('uso: bun scripts/workspace-mcp.ts <workspace> <preview-url>'); process.exit(2); }
const imageModel = process.env[IMAGE_MODEL_ENV];
// El mismo generador que el composer (agent-composer.ts imageGenOf), elegido por WT_IMAGE_PROVIDER.
const imageGen = imageModel ? defaultImageGen(imageModel) : undefined;
// Editar exige AI Gateway (generateImage con prompt {images, mask}); el generador cli no edita, y ahí edit_image no existe.
const imageEdit = imageModel && imageProvider() === 'gateway' ? gatewayImageEdit(imageModel) : undefined;
const ctx: WorkspaceToolContext = { dir: resolve(dirArg), previews: { ensure: async () => ({ url }) }, ...(imageGen ? { imageGen } : {}), ...(imageEdit ? { imageEdit } : {}) };
const toolDefs = imageGen ? [...WORKSPACE_TOOL_DEFS, IMAGE_TOOL_DEF, ...(imageEdit ? [EDIT_IMAGE_DEF] : [])] : WORKSPACE_TOOL_DEFS;
// El watchdog del transport corta este proceso si una tool queda sin respuesta (tool-watchdog.ts).
try {
  const pidFile = join(ctx.dir, MCP_PID_FILE);
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  // Un pidfile viejo apunta a un pid que el sistema puede reasignar; al salir se borra.
  process.on('exit', () => rmSync(pidFile, { force: true }));
  process.on('SIGTERM', () => process.exit(143));
} catch {
  // sin pidfile el watchdog corta el turno entero en vez de solo este servidor
}

const send = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

async function handle(req: { id?: number | string; method: string; params?: Record<string, unknown> }): Promise<void> {
  // Las notificaciones no llevan id y no se responden.
  if (req.id === undefined) return;
  switch (req.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web-transformer-workspace', version: '1' } } });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id: req.id, result: { tools: toolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) } });
    case 'tools/call': {
      const r = await runWorkspaceTool(String(req.params?.name ?? ''), req.params?.arguments ?? {}, ctx);
      return send({ jsonrpc: '2.0', id: req.id, result: r.ok ? { content: toMcpContent(r.content) } : { content: [{ type: 'text', text: r.error }], isError: true } });
    }
    case 'ping':
      return send({ jsonrpc: '2.0', id: req.id, result: {} });
    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `método desconocido: ${req.method}` } });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
    continue;
  }
  await handle(req);
}
