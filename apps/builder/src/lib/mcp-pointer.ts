// "Copiar para MCP" (H9, export-zip-mcp.md §2 Builder): como Stitch, un puntero y no contenido. Lleva los ids de la versión
// y la config del MCP de lectura (scripts/export-mcp.ts, cabecera: Claude Code y Cursor). El token NUNCA va en el texto:
// el portapapeles termina en chats e historiales; el script lo lee de WT_MCP_TOKEN y aquí solo se dice dónde ponerlo.

export interface McpVersion { chatId: string; messageId: string; commit: string; api: string; origin: string }

/** La misma base que usa el builder, absoluta y con su path (/api detrás de vite o del orquestador): con solo el origin
 * el MCP pediría /runs/... a quien sirve el builder y no al runtime. */
export const mcpRuntimeUrl = (o: Pick<McpVersion, 'api' | 'origin'>): string => new URL(o.api, o.origin).href.replace(/\/$/, '')

export function mcpPointer(o: McpVersion): string {
  const version = { chatId: o.chatId, messageId: o.messageId, commit: o.commit }
  const config = { mcpServers: { onbrand: { command: 'bun', args: ['<repo>/scripts/export-mcp.ts'], env: { WT_RUNTIME_URL: mcpRuntimeUrl(o) } } } }
  return [
    'Versión de onbrand para leer con el MCP "onbrand" (solo lectura: list_files y read_file con este messageId).',
    JSON.stringify(version, null, 2),
    'Config del MCP: .mcp.json en Claude Code o .cursor/mcp.json en Cursor; <repo> es tu copia de onbrand.',
    JSON.stringify(config, null, 2),
    'Si el servidor pide sesión, agrega WT_MCP_TOKEN con tu token en ese "env" o en tu shell. No lo pegues en un chat.',
  ].join('\n\n')
}
