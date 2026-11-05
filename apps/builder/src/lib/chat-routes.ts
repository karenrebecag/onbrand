// Las URLs del builder en un solo sitio (docs/spec/orquestador-enrutamiento.md §1.1): lo que es de un chat cuelga de
// `${api}/chats/<chatId>` en los dos modos, y solo el catálogo, la lista de chats, el "siempre" y los conectores van a la raíz. Cada
// constructor de `chatRoutes` tiene que casar con una fila de src/orchestrator/route-table.ts (lo comprueba
// tests/builder-chat-routes.test.ts): una URL que el orquestador no conoce da 404 en producción aunque el Runtime local la atienda.

/** La base de un chat. Marcada para que una función de chat no reciba `api` a secas por error. */
export type ChatBase = string & { readonly __chatBase: true }

const seg = encodeURIComponent

export const chatBase = (api: string, chatId: string): ChatBase => `${api}/chats/${seg(chatId)}` as ChatBase

export const chatRoutes = {
  thread: (b: ChatBase) => `${b}`,
  runs: (b: ChatBase) => `${b}/runs`,
  events: (b: ChatBase, m: string, cursor: number) => `${b}/runs/${seg(m)}/events?cursor=${cursor}`,
  cancel: (b: ChatBase, m: string) => `${b}/runs/${seg(m)}/cancel`,
  publish: (b: ChatBase, m: string) => `${b}/runs/${seg(m)}/publish`,
  files: (b: ChatBase, m: string) => `${b}/runs/${seg(m)}/files`,
  diff: (b: ChatBase, m: string) => `${b}/runs/${seg(m)}/diff`,
  versions: (b: ChatBase, m: string) => `${b}/runs/${seg(m)}/versions`,
  export: (b: ChatBase, m: string, format?: string) => `${b}/runs/${seg(m)}/export${format ? `?format=${seg(format)}` : ''}`,
  shot: (b: ChatBase, m: string, file: string) => `${b}/runs/${seg(m)}/shots/${seg(file)}`,
  variantCancel: (b: ChatBase, g: string) => `${b}/variants/${seg(g)}/cancel`,
  canvas: (b: ChatBase) => `${b}/canvas`,
  canvasUpload: (b: ChatBase, name: string) => `${b}/canvas/files?name=${seg(name)}`,
  canvasFile: (b: ChatBase, name: string) => `${b}/canvas/files/${seg(name)}`,
  plan: (b: ChatBase, m: string) => `${b}/plans/${seg(m)}`,
  approval: (b: ChatBase, callId: string) => `${b}/approvals/${seg(callId)}`,
  uploads: (b: ChatBase) => `${b}/uploads`,
  transcribe: (b: ChatBase) => `${b}/transcribe`,
  enhance: (b: ChatBase) => `${b}/prompt-enhancements`,
  heartbeat: (b: ChatBase) => `${b}/preview/heartbeat`,
  brands: (b: ChatBase) => `${b}/brands`,
  brandInstructions: (b: ChatBase, id: string) => `${b}/brands/${seg(id)}/instructions`,
  brandMemory: (b: ChatBase, id: string) => `${b}/brands/${seg(id)}/memory`,
  /** §4: no es una fila de la tabla (lo firma el orquestador sin VM), pero cuelga del chat igual. */
  mediaUrls: (b: ChatBase) => `${b}/media-urls`,
} as const

/** Lo que no es de un chat (§3.1 y §3.4): el orquestador lo atiende sin VM. */
export const rootRoutes = {
  chats: (api: string) => `${api}/chats`,
  models: (api: string) => `${api}/models`,
  imageModels: (api: string) => `${api}/image-models`,
  always: (api: string, tool: string) => `${api}/approvals/always/${seg(tool)}`,
  // Conectores del dueño (§3.4, #880): no dependen de un chat ni de una VM, así que no esperan a la reserva ni al veredicto del hilo.
  connectorApps: (api: string, q: string, after?: string) => `${api}/connectors/apps?q=${seg(q)}${after ? `&after=${seg(after)}` : ''}`,
  connectorAccounts: (api: string) => `${api}/connectors/accounts`,
  connect: (api: string) => `${api}/connectors/connect`,
  disconnect: (api: string, id: string) => `${api}/connectors/accounts?id=${seg(id)}`,
} as const
