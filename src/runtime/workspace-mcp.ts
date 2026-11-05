// Del content de un tool_result de Anthropic al de MCP: la imagen cambia de forma, el texto no.

import { join } from 'node:path';
import { WORKSPACE_TOOL_DEFS, type ContentBlock } from './workspace-tools';

const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOL_DEFS.map((t) => t.name);

export const WORKSPACE_MCP_SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'workspace-mcp.ts');

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export const toMcpContent = (blocks: readonly ContentBlock[]): McpContent[] =>
  blocks.map((b) => (b.type === 'text' ? b : { type: 'image', data: b.source.data, mimeType: b.source.media_type }));

// `workspace` es un nombre reservado del CLI: con él el servidor no se carga y no avisa más que en --debug.
export const MCP_SERVER = 'wt';

/** El servidor lee el modelo de imagen de aquí: sin la variable, `generate_image` no existe en ese turno. */
export const IMAGE_MODEL_ENV = 'WT_WORKSPACE_IMAGE_MODEL';

/** La entrada de --mcp-config para `claude -p`, y los nombres con los que el CLI expone las tools. Con `image`, el
 * agente tiene `generate_image` con ese modelo, fuera de allowedTools: gasta créditos y pasa por la permission-prompt-tool
 * con kind spend (approvals.ts SPEND_TOOLS). */
export function workspaceMcpConfig(dir: string, url: string, script = WORKSPACE_MCP_SCRIPT, image?: { modelId: string }): { config: string; allowedTools: string[] } {
  return {
    config: JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: 'bun', args: [script, dir, url], ...(image ? { env: { [IMAGE_MODEL_ENV]: image.modelId } } : {}) } } }),
    allowedTools: WORKSPACE_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER}__${n}`),
  };
}

/** El mismo servidor `wt` servido por el transport (POST /mcp/:messageId) en lugar de un proceso hijo: las tools corren
 * con las credenciales del transport y no con el env filtrado del CLI. El token es el de la corrida, así que este config
 * solo puede ir al archivo 0600 de mcpConfigFile, nunca a argv. Formato `type: "http"` con `headers` de la doc de Claude
 * Code (code.claude.com/docs/en/mcp, "Example with variable expansion"); verificado con --mcp-config en el CLI 2.1.316. */
export function workspaceMcpHttpConfig(url: string, token: string): { config: string; allowedTools: string[] } {
  return {
    config: JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
    allowedTools: WORKSPACE_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER}__${n}`),
  };
}
