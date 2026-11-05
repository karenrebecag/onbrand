# Rutas que llama el builder (inventario para el enrutamiento builder ↔ orquestador)

Fuente: grep sobre `apps/builder/src` en main `f436d379` (2026-11-05). Cada fila sale de una llamada real; las líneas son de
`apps/builder/src/lib/run-client.ts` salvo que se diga otro archivo. `${api}` es la base del builder (`VITE_RUN_API`, hoy
`/api` detrás del proxy de vite hacia el runtime). Entrada para `docs/spec/orquestador-enrutamiento.md` (orq).

Qué dice cada columna:
- **Bearer**: todas las llamadas por `apiFetch` (`lib/session-provider.ts`) llevan `Authorization: Bearer` si el provider
  tiene token. Las que no pasan por `apiFetch` están marcadas: hoy no llevan sesión.
- **Scope propuesto**: lo que el orquestador debería exigir. Es una PROPUESTA de UI para que orq la decida, no un hecho del
  código. Criterio: leer = `chat:read`; escribir en el chat o gastar modelo dentro de él = `chat:write`; escribir en la marca
  = `brand:write`; ver el gasto = `spend` (hoy GET /spend no lo exige, hallazgo ya con orq).
- **Cuerpo**: lo que manda el builder; el tamaño solo cuando el código lo acota.

## Corridas y su stream

| Método | Path | Llamada (archivo:línea) | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| POST | `${api}/runs` | `startRun` :148 ← `use-builder.ts:401` | turno: prompt, follow-up, Continuar, restore, patch, edición directa (texto, imagen, sección), aplicar marca/tema | JSON (`runBody`: el pedido + `timezone`); `parentId` y `messageId` en el cuerpo, el chat no va en el path | chat:write | content-type json |
| POST | `${api}/runs` | `startAutoRepair` :163 ← `use-builder.ts:617` | arreglo automático tras errores de runtime | JSON (`repair: 'runtime'`, `auto: true`, `runtimeErrors`) | chat:write | content-type json |
| POST | `${api}/runs` | `steerRun` :305 ← `use-builder.ts:528` | mensaje durante una corrida en curso | JSON (`steer: true`, `parentId`, `selectedSections?`) | chat:write | content-type json |
| POST | `${api}/runs` | `startVariants` :329 ← `use-builder.ts:570` | pedir N variantes | JSON (`variants`, `model?`, `imageGeneration?`, `thinking?`) | chat:write | content-type json |
| GET | `${api}/runs/:messageId/events?cursor=N` | `streamRun` :625 ← `use-builder.ts:329, 543` | cada turno y cada variante, con reconexión por cursor | — (respuesta NDJSON en stream, abierta mientras corre) | chat:read | — |
| POST | `${api}/runs/:messageId/cancel` | `cancelRun` :346 ← `use-builder.ts:534, 581` | Stop del turno o de una variante | sin cuerpo | chat:write | content-type json |
| POST | `${api}/variants/:groupId/cancel` | `cancelVariants` :339 ← `use-builder.ts:584` (alias `cancelVariantsRun`) | detener un grupo de variantes | sin cuerpo | chat:write | content-type json |

## Lectura de una versión

| Método | Path | Llamada | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| GET | `${api}/runs/:messageId/files` | `fetchFiles` :180 ← `use-builder.ts:303` | al asentarse un turno | — | chat:read | — |
| GET | `${api}/runs/:messageId/diff` | `fetchDiff` :183 ← `use-builder.ts:303` | al asentarse un turno | — | chat:read | — |
| GET | `${api}/runs/:messageId/versions` | `fetchVersions` :266 ← `use-builder.ts:303` | al asentarse un turno | — | chat:read | — |
| GET | `${api}/runs/:messageId/export` | `fetchExportFormats` :498 ← `export-menu.tsx:46` | al abrir Exportar | — | chat:read | — |
| GET | `${api}/runs/:messageId/export?format=F` | `exportUrl` :493 por `apiFetch` ← `export-menu.tsx:52` (descarga) y `fetchPageHtml` :569 ← `export-menu.tsx:59` (Copiar página) | Descargar o Copiar página | — (respuesta zip o HTML; 413 sobre 50 MiB) | chat:read | — |
| POST | `${api}/runs/:messageId/publish` | `publishVersion` :560 ← `export-menu.tsx:95` | Publicar en este servidor | JSON `{}` | chat:write | content-type json |
| GET | `${api}/runs/:messageId/shots/:file` | **sin apiFetch**: `<img src>` desde `use-builder.ts:586` (`shotUrl`) → `chat-panel.tsx:252` | capturas del navegador en los pasos del agente | — (imagen) | chat:read | **no lleva Bearer** |

## Chat, lienzo, plan y aprobaciones

| Método | Path | Llamada | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| GET | `${api}/chats/:chatId` | `fetchThread` :227 ← `use-builder.ts:360, 498` | al abrir/recargar un chat; al cambiar el DS | — | chat:read | — |
| GET | `${api}/chats/:chatId/canvas` | `fetchCanvas` :263 ← `use-builder.ts:357` | al abrir un chat | — | chat:read | — |
| PUT | `${api}/chats/:chatId/canvas` | `putCanvas` :678 ← `canvas-writer.ts:52` | mover, ordenar o borrar imágenes del lienzo (un escritor serializado) | JSON (el CanvasDoc con `rev`) | chat:write | content-type json |
| POST | `${api}/chats/:chatId/canvas/files?name=N` | `uploadCanvasFile` :686 ← `use-canvas-nodes.ts:124` | subir o pegar una imagen al lienzo | bytes crudos de la imagen (`content-type` = tipo del archivo) | chat:write | content-type del archivo |
| GET | `${api}/chats/:chatId/canvas/files/...` | **sin apiFetch**: `<img src>` por `urlOf` en `use-canvas-nodes.ts:120` → `canvas-image-nodes.tsx:77` | pintar cada imagen del lienzo | — (imagen) | chat:read | **no lleva Bearer** |
| GET | `${api}/chats/:chatId/plans/:messageId` | `fetchPlan` :439 ← `chat-panel.tsx:257` | abrir el plan de un turno en modo plan | — | chat:read | — |
| POST | `${api}/chats/:chatId/approvals/:callId` | `decideApproval` :410 ← `use-builder.ts:504` | Permitir/Rechazar una tool o decidir un plan | JSON (`decision`, `feedback?` o `plan`) | chat:write | content-type json |
| DELETE | `${api}/approvals/always/:toolName` | `revokeAlways` :384 ← `use-builder.ts:523` | quitar un "Permitir siempre" | sin cuerpo | chat:write (no es de un chat: es del dueño) | content-type json |

## Archivos, voz y prompt

| Método | Path | Llamada | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| POST | `${api}/uploads` | `uploadFile` :191 (**XHR**, no fetch; Bearer puesto a mano) ← `use-builder.ts:463, 587` | adjuntar un archivo al prompt | multipart (`file`); tope propio de `upload-limit.ts`, ajustable por `VITE_MAX_UPLOAD_BYTES` | chat:write | `x-wt-request: 1` (fuerza preflight) |
| POST | `${api}/transcribe` | `transcribe` :451 ← `use-builder.ts:588` | dictado por micrófono | multipart (`file` webm/mp4) | chat:write (gasta modelo) | `x-wt-request: 1` |
| POST | `${api}/prompt-enhancements` | `enhancePrompt` :423 ← `chat-panel.tsx:159` | Mejorar prompt | JSON `{prompt}` (respuesta de texto en stream; 429 si ya hay una) | chat:write (gasta modelo) | content-type json |

## Marca, modelos, conectores y gasto (no son de un chat)

| Método | Path | Llamada | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| GET | `${api}/models` | `fetchModels` :576 ← `use-builder.ts:293` | al montar | — | chat:read | — |
| GET | `${api}/image-models` | `fetchImageModels` :459 ← `use-builder.ts:291` | al montar | — | chat:read | — |
| GET | `${api}/brands` | `fetchBrands` :462 ← `use-builder.ts:416` | al montar / al abrir Tema | — | chat:read | — |
| GET | `${api}/brands/:id/instructions` | `fetchBrandInstructions` :466 ← `chat-panel.tsx:137` | abrir Instrucciones | — | chat:read | — |
| PUT | `${api}/brands/:id/instructions` | `saveBrandInstructions` :469 ← `chat-panel.tsx:138` | guardar Instrucciones | JSON `{instructions: string[]}` | brand:write | content-type json |
| GET | `${api}/brands/:id/memory` | `fetchBrandMemory` :478 ← `chat-panel.tsx:139` | abrir la pestaña Memory | — (404 = vacía) | chat:read | — |
| PUT | `${api}/brands/:id/memory` | `saveBrandMemory` :485 ← `chat-panel.tsx:139` | guardar Memory | JSON `{text}` | brand:write | content-type json |
| GET | `${api}/connectors/apps?q=&after=` | `fetchConnectorApps` :285 ← `use-builder.ts:590` | buscar apps en Conectores | — | chat:read | — |
| GET | `${api}/connectors/accounts` | `fetchConnectorAccounts` :288 ← `use-builder.ts:591` | abrir Conectores | — | chat:read | — |
| POST | `${api}/connectors/connect` | `connectApp` :291 ← `use-builder.ts:592` | conectar una app (devuelve la URL de OAuth) | JSON `{app}` | chat:write | content-type json |
| DELETE | `${api}/connectors/accounts?id=` | `disconnectAccount` :296 ← `use-builder.ts:593` | desconectar una cuenta | sin cuerpo | chat:write | content-type json |
| GET | `${api}/spend` | `fetchSpend` en `lib/spend.ts:40` ← `chat-panel.tsx` (`useSpend`) | al montar y al asentarse el último turno | — | spend | — |

## Preview (fuera de `${api}`)

| Método | Path | Llamada | Cuándo | Cuerpo | Scope propuesto | Cabeceras |
|---|---|---|---|---|---|---|
| POST | `${api}/preview/heartbeat` | `previewHeartbeat` :373 ← `preview-heartbeat.ts:65` | cada 5 s con la pestaña visible y enfocada | JSON `{visible: string[]}` | chat:read | content-type json |
| GET | url del preview (`<ws>.localhost:<puerto>` en local) | iframes de `artboard-canvas.tsx` con `?wt_preview=<token>` (`preview-access.ts`) | cada montaje de un marco | — | token de preview del latido, no Bearer | `wt_preview` en la url |

## Hallazgos para la spec

1. **Dos lecturas sin sesión**: las capturas de los pasos (`/runs/:id/shots/:file`) y las imágenes del lienzo
   (`/chats/:id/canvas/files/...`) se piden con `<img src>`, que no lleva `Authorization`. Detrás del orquestador con
   sesión obligatoria fallarían. Opciones para la spec: un token en la url como el de preview, o que el builder las pida
   por `apiFetch` y las muestre como `blob:`.
2. **El chat no va en el path de POST /runs**: va en el cuerpo (`parentId`/`messageId`). Una base por chat
   (`/chats/:id/runs`) exige que el builder conozca el chat en cada llamada: `startRun`, `startAutoRepair`, `steerRun` y
   `startVariants` reciben hoy solo `api`.
3. **Rutas del dueño, no de un chat**: `approvals/always`, `brands/*`, `connectors/*`, `models`, `image-models`,
   `uploads`, `transcribe`, `prompt-enhancements` y `spend`. No caben en `/chats/:id/...` sin decidir a qué chat atarlas.
4. **Cabecera propia**: `x-wt-request: 1` en las dos subidas multipart, para forzar el preflight (el guard de escritura
   del runtime rechaza un multipart simple sin ella). Si el orquestador reenvía, tiene que dejarla pasar.
5. **Streams largos**: `/runs/:id/events` (NDJSON, se reconecta por cursor) y `/prompt-enhancements` (texto en stream). El
   proxy no puede bufferizarlos.
