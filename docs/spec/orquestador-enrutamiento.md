# Enrutamiento builder ↔ orquestador

Estado: PROPUESTA (orq, 2026-11-05). Base: `docs/spec/builder-rutas-inventario.md` (UI, #807: 40 llamadas reales),
`docs/spec/deploy-sandbox.md` §0, §3, §4 y `docs/spec/identidad-sesion.md`. Hoy `src/orchestrator/routes.ts` solo atiende
`/chats`, `/spend` y `/chats/:id/runs/*`; detrás de él todo lo demás del builder da 404. Esta spec fija el contrato; el código va
en PRs aparte (§9). No decide dependencias ni gasto.

## 1. Reglas

1. **Base por chat.** El builder usa `${api}/chats/<chatId>` como base de todo lo que es de un chat. El orquestador reenvía a la
   VM de ese chat con la ruta que el Runtime ya conoce (columna "VM" de §3). El chat sale del path, no del cuerpo.
2. **Allowlist explícita.** Una ruta existe si está en las tablas de §3 con método y scope; el resto es 404 (método fuera de
   la tabla para una ruta que sí existe: 405). Se acabó el patrón `((?:\/[a-z0-9-]+)*)` que deja pasar cualquier subruta.
3. **Orden de comprobación**, todo ANTES de despertar la VM (`runtimeUrl` puede crear un Sandbox): (a) sesión, (b) ruta y método en
   la allowlist, (c) scope de la fila, (d) dueño del chat (ajeno e inexistente = el mismo 404), (e) tamaño y tipo del cuerpo.
4. **El scope se comprueba aquí y otra vez en la VM** (la identidad firmada lleva los scopes; `scopeFor` de `http-router.ts`).
   Aquí evita despertar una VM para un 403; allá es la defensa si esta capa falla.
5. **Lo que se reenvía lo construye el orquestador.** De la request del cliente solo pasan las cabeceras de §5 y el cuerpo
   validado de la fila. `x-wt-identity` y `x-wt-run-token` los pone el orquestador; lo que el cliente mande con esos nombres se
   descarta. `redirect: 'manual'`, un 3xx de la VM es 502 (como hoy).

## 2. Decisiones sobre los cinco hallazgos de UI

| # | Hallazgo | Decisión |
|---|---|---|
| 1 | `<img src>` sin Bearer (`shots`, `canvas/files`) | **Token corto por recurso en la URL** (§4). Ni cookie ni Bearer en query. |
| 2 | El chat no va en el path de `POST /runs` | **Va en el path**: `POST /chats/:id/runs` para `startRun`, `startAutoRepair`, `steerRun`, `startVariants`. UI pasa el `chatId` a esas cuatro. `parentId`/`messageId` siguen en el cuerpo. |
| 3 | Nueve rutas del dueño, no de un chat | Dos clases (§3.4): **catálogo** (`models`, `image-models`, `spend`) las sirve el orquestador sin VM; **estado del dueño** (`brands/*`, `connectors/*`, `approvals/always`) cuelgan de un chat (`/chats/:id/...`) y viven en la VM de ese chat. Deuda explícita en §8. |
| 4 | `x-wt-request: 1` en multipart | El orquestador la **exige** en las rutas multipart (fuerza preflight del navegador) y la reemite hacia la VM; nada más del cliente la reenvía. |
| 5 | Dos streams | `events` y `prompt-enhancements` pasan **sin bufferizar** con su content-type propio (§6). |

Por qué token y no cookie para el hallazgo 1: el contrato de sesión del core es `Authorization: Bearer` y el perfil decide el
IdP (`SessionVerifier`, `docs/profile-module.md`); una cookie ata el orquestador a un IdP concreto y con el builder en otro
origen el navegador la bloquea como de terceros. El token firmado no depende de ninguno de los dos.

## 3. Tablas de rutas

`${base}` = `/chats/:chatId`. "VM" es la ruta que recibe el Runtime. Scope = el mínimo que exige el orquestador (todos a la
vez); la VM puede exigir más (`spend`).

### 3.1 Chats y gasto (del orquestador, sin VM)

| Método | Ruta | Scope | Notas |
|---|---|---|---|
| POST | `/chats` | `chat:write` | existe; JSON ≤ 1 MiB, 10/min por dueño, 100 por dueño |
| GET | `/chats` | `chat:read` | existe |
| GET | `/spend` | `spend` | existe (#810) |
| GET | `/models`, `/image-models` | sesión, sin scope | **nuevo**: catálogo del perfil (`deps.catalog`), no despierta VM. Sin él, 404. |

### 3.2 Corridas y lectura de una versión (`${base}/runs...`)

| Método | Ruta | VM | Scope | Notas |
|---|---|---|---|---|
| POST | `${base}/runs` | `/runs` | `chat:write` | JSON ≤ 1 MiB; **único** que recibe `x-wt-run-token`; primera corrida: `messageId = chatId` |
| GET | `${base}/runs/:m/events?cursor=N` | `/runs/:m/events` | `chat:read` | NDJSON en stream (§6) |
| POST | `${base}/runs/:m/cancel` | igual | `chat:write` | sin cuerpo |
| POST | `${base}/runs/:m/publish` | igual | `chat:write` | `{}` |
| GET | `${base}/runs/:m/files`, `/diff`, `/versions` | igual | `chat:read` | JSON |
| GET | `${base}/runs/:m/export[?format=F]` | igual | `chat:read` | zip o HTML hasta 50 MiB: **no cabe en una Function** (4,5 MiB de respuesta no streameada); sale por stream o por el Blob (§8) |
| GET | `${base}/runs/:m/shots/:file` | igual | `chat:read` + token de recurso | `<img>`; §4 |
| POST | `${base}/variants/:g/cancel` | `/variants/:g/cancel` | `chat:write` | sin cuerpo |

### 3.3 Chat, lienzo, plan, aprobaciones, voz, archivos

| Método | Ruta | VM | Scope | Notas |
|---|---|---|---|---|
| GET | `${base}` | `/chats/:id` | `chat:read` | hilo |
| GET / PUT | `${base}/canvas` | `/chats/:id/canvas` | `chat:read` / `chat:write` | PUT JSON ≤ 1 MiB (`CanvasDoc` con `rev`) |
| POST | `${base}/canvas/files?name=N` | `/chats/:id/canvas/files` | `chat:write` | bytes crudos; `name` `[A-Za-z0-9._-]{1,128}`; tope §7 |
| GET | `${base}/canvas/files/:name` | igual | `chat:read` + token de recurso | `<img>`; §4; un solo segmento, sin `..` |
| GET | `${base}/plans/:m` | `/chats/:id/plans/:m` | `chat:read` | |
| GET | `${base}/approvals/:callId` | — | `chat:read` | la tarjeta del registro de aprobaciones (§8.1): `{callId, tool, patterns, rememberPatterns, expiresAt, decision?}`; 404 si no hay registro vigente |
| POST | `${base}/approvals/:callId` | `/chats/:id/approvals/:callId` | `chat:write` (+ `spend` en tools de gasto) | JSON `{decision}` (`allow\|always\|skip`) sin patrones; responde `{ok, always?}`, nunca lo que conteste la VM (§8.1) |
| POST | `${base}/uploads` | `/uploads` | `chat:write` | multipart + `x-wt-request: 1`; tope §7 |
| POST | `${base}/transcribe` | `/transcribe` | `chat:write` + `spend` | multipart + `x-wt-request: 1` |
| POST | `${base}/prompt-enhancements` | `/prompt-enhancements` | `chat:write` + `spend` | JSON `{prompt}`; respuesta `text/plain` en stream; 429 si ya hay una |
| POST | `${base}/preview/heartbeat` | `/preview/heartbeat` | `chat:read` | JSON `{visible}` cada 5 s; los `visible` fuera del chat los descarta la VM |

### 3.4 Estado del dueño colgado de un chat

El chat se crea con el primer envío (v0: `isNew: true` en el primer `POST /chat/api/chat`, `docs/notas/b8-vs-v0.md:38`; el primer mensaje crea la
conversación, `re-iteracion/transport.md:55`) y los borradores sin enviar viven en el cliente (`localStorage` `v0-local-drafts`,
`deob/v0-layers/deobfuscated.js:34002-34037`). Lo que es del dueño y no de un chat (catálogo, gasto, **conectores**, "siempre") se sirve sin chat
y sin VM; visitar el builder sin enviar nada no reserva chats ni gasta el tope de 100 (§3.1). Las marcas (instrucciones y memoria) pasan a la raíz del dueño (§8.2); el catálogo de packs, mientras no haya puerto `brands`, sigue por chat.

| Método | Ruta | VM | Scope | Estado |
|---|---|---|---|---|
| GET | `/brands` | — | `chat:read` | el orquestador con el puerto `brands` del perfil (catálogo de packs); sin el puerto, **404** y el builder usa la ruta del chat (§8.2) |
| GET | `/brands/:id/instructions`, `/brands/:id/memory` | — | `chat:read` | el orquestador, índice global por dueño (§8.2) |
| PUT | `/brands/:id/instructions`, `/brands/:id/memory` | — | `brand:write` | igual; validación y límites de §8.2 |
| GET | `/connectors/apps`, `/connectors/accounts` | — | `chat:read` | el orquestador, con el puerto `connectors` del perfil, por dueño; sin el puerto, **501** `connectors-unavailable` |
| POST | `/connectors/connect` | — | `chat:write` | igual; `{app}` con `[a-z0-9_]{1,100}`, el enlace devuelto debe ser https |
| DELETE | `/connectors/accounts?id=` | — | `chat:write` | igual; una cuenta que no es del dueño es 404 |

Las filas de conectores y de marcas viven en la raíz del dueño (sin `/chats/:id`). Las mismas rutas bajo `${base}/connectors/...` y `${base}/brands/...` siguen como alias (mismo
manejador, mismo scope, y además exigen que el chat sea del dueño) hasta el **2026-12-05** (propuesta: la confirman Karen y UI cuando el builder migre); entonces se quitan de `ROUTES`. Las de marcas por chat atienden desde el mismo almacén del dueño, no desde la VM.

`/approvals/always` (GET, `chat:read`) y `/approvals/always/:tool` (DELETE, `chat:write`) son del dueño y no de un chat: el orquestador los
atiende sobre el índice global, sin VM. `POST ${base}/approvals/:callId` pasa a la VM, pero el "siempre" no sale de lo que ella conteste: el orquestador lo
escribe en el índice (`Dynamic(<tool>)`) solo si el registro de la tarjeta (§8.1) lo ofrecía, la petición traía `decision: 'always'` y la sesión tiene `spend`;
el cliente recibe `{ok: true, always: <bool>}` (false = no quedó guardado). La VM consulta el índice con `GET /gw/always` y el token de la corrida.

`:id`, `:tool`, `:callId`, `:file`, `:name` solo `[A-Za-z0-9._-]{1,128}`, nunca `.` ni `..`; `:m` y `:g` con la forma de `MESSAGE_ID`
(`[a-z0-9-]{1,63}`) y `:chatId` con `[a-z0-9-]{26,63}`. Un `%` en un segmento no casa con ningún parámetro. La tabla vive en
`src/orchestrator/route-table.ts`.

### 3.5 Lo que NO se expone

- `/approval-requests`, `/mcp/:x`, `/connector-mcp`: callbacks del CLI con el token de la corrida; son loopback dentro de la VM.
- `/chats/:id/plans` PUT, `/runs/:m` (snapshot), `/runs/:m/tree`, `/file`, `/publishable`, `/sections/:s/suggestions`: el builder
  no las llama (inventario). Entran a la tabla el día que una pantalla las use, con su scope.
- Cualquier método fuera de la tabla, `OPTIONS` incluido salvo el preflight que resuelva la capa de CORS del despliegue.
- El listener de preview (`<ws>.<host>:<puerto>`): va por su token de preview, no por esta API.

### 3.6 Rutas de la VM (token de corrida)

Las llama el Runtime de un chat (no el navegador) con `Authorization: Bearer <token de corrida>`: `typ: 'run'`, firma Ed25519 del orquestador, vida ≤ `MAX_RUN_TTL_MS`,
claims `owner`, `chat`, `run` y, para conectores, `apps`. Se atienden **antes** de `authenticate` y el dueño sale siempre del token, nunca de un parámetro. Un token de otro
`typ` (identity, preview, media) o sin firma es 401. La tabla es `GW_ROUTES` en `src/orchestrator/route-table.ts` y un test la recorre como la allowlist de §1.2: todo `/gw/*`
que no esté en ella es 404 (método ajeno 405) sin llegar a ninguna autenticación, así que una ruta nueva no entra sin fila.

| Método | Ruta | Auth | Cuerpo | Límites | Códigos |
|---|---|---|---|---|---|
| cualquiera | `/gw/claude-code/*` | token de corrida (lo verifica el proxy de Gateway) | el de la API de Anthropic | tope por dueño y por llamada (reserva), `deadlineMs` del despliegue | 401, 429 (tope), el del proveedor |
| GET | `/gw/always` | `run` | — | — | 200 `{tools}`, 401, 502 (índice caído: la VM lo trata como "sin siempre") |
| POST | `/gw/connectors/mcp` | `run` + claim `apps` | JSON `{slugs}` (≤ 20, `APP_SLUG`) | 10/min por dueño; 1 MiB de cuerpo | 200 `{apps, readOnlyTools}`, 400 `bad-app`, 401, 403 `app-not-requested`, 415, 429, 501 sin puerto `mcp`/`forward` |
| POST | `/gw/approvals/pending` | `run` (claims `chat`, `apps`) | JSON `{callId, tool}` | 120/min por dueño; `PENDING_LIMIT` por chat | 200 `{patterns, rememberPatterns, expiresAt}`, 400 `bad-call`/`bad-tool`, 401, 403 `tool-not-allowed`, 415, 429 |
| POST | `/gw/approvals/grant` | `run` (claim `chat`) | JSON `{callId}` | una entrega por llamada | 200 `{grant, tool}`, 404 `no-grant` (sin decisión, ya entregado o vencido), 400, 401, 415 |
| GET | `/gw/brands/:id` | `run` | — | 120/min por dueño; 2 MiB como máximo | 200 `{instructions, memory}` (marca sin estado = vacío), 400 `bad-brand`, 401, 429 |
| POST | `/gw/brands/:id/facts` | `run` (claims `owner`, `chat`) | JSON `{text, messageId}` | 30/min por dueño; 1 MiB de cuerpo | 200 `{memory, added}`, 400 `bad-brand`/código de §8.2, 401, 409 `duplicate`, 415, 429 |
| POST | `/gw/connectors/forward/:slug` | `run` + claim `apps` (`:slug` en `apps`) | JSON `{message, session?, callId?, grant?}`, `message.method` en la lista del CLI | 120/min por dueño; respuesta ≤ `CONNECTOR_REPLY_MAX_BYTES` | 200 `{status, text, session?}`, 400 `bad-message`, 401, 403 `app-not-requested` / `not-read-only` / `bad-grant`, 415, 429, 501, 502 `too-large` |

## 4. Imágenes sin Bearer: token corto por recurso

`<img src>` no manda `Authorization`. El builder pide las URLs firmadas y las pone en `src`.

- `POST ${base}/media-urls` (`chat:read`), JSON `{ "paths": ["runs/<m>/shots/<f>", "canvas/files/<n>"] }`, hasta 50 rutas.
  Cada una debe casar con las dos filas "token de recurso" de §3; otra cosa es 400 y no se firma nada. Responde
  `{ "urls": { "<path>": "<path>?wt_media=<token>" }, "expiresAt": <ms> }`: la URL es relativa a la base del chat y el builder
  la compone (`${api}/chats/<id>/<valor>`), porque el orquestador no conoce el origen público detrás de un rewrite.
- **Token**: mismo firmador que `identity.ts` (`signed-token.ts`; hay que añadir `'media'` a `TokenType` y un claim `path` firmado, hoy solo hay `identity|preview|run`), `typ: 'media'`, `{ owner, chat, path, exp }`, **vida 5 min**
  (no 2 h: se pide de nuevo al repintar). Un token `media` no vale como `identity`, `run` ni `preview` (el verificador de
  cada tipo exige su `typ`), y al revés.
- **GET con token** (sin `Authorization`): se verifica firma, `exp`, que `chat` y `path` sean exactamente los de la URL, y
  que el dueño siga siendo dueño del chat. Solo `GET` y solo esas dos familias de ruta: el mismo token en otra ruta es 401.
  Entonces se reenvía a la VM con identidad firmada nueva de ese `owner` con scope `chat:read`.
- **Respuesta**: `cache-control: private, max-age=300`, `referrer-policy: no-referrer`, `x-content-type-options: nosniff`,
  `content-type` solo `image/png|jpeg|webp|gif` (el SVG y el HTML no salen: un SVG del agente ejecutaría script bajo el origen
  de la API). Sin `set-cookie`.
- **Fuga**: el token solo abre ese archivo 5 minutos. El orquestador no escribe URLs en sus logs; el log de acceso del despliegue (Vercel) debe
  redactar el query `wt_media`. Es el
  mismo riesgo que una URL firmada de Blob.
- El `Bearer` **nunca** viaja en la query.

## 5. Cabeceras

Del cliente al orquestador y de ahí a la VM:

| Cabecera | Regla |
|---|---|
| `accept`, `last-event-id` | pasan |
| `content-type` | JSON en las filas JSON (si no, 415); multipart o `image/*` en las suyas; el valor se reconstruye, no se copia |
| `x-wt-request: 1` | **exigida** en `uploads` y `transcribe` (multipart); el orquestador la reemite |
| `authorization`, `cookie`, `origin`, `host`, `x-forwarded-*` | no pasan |
| `x-wt-identity`, `x-wt-run-token` | las pone el orquestador (§1.5) |

De la VM al cliente: solo `content-type` (del §6), `cache-control`, `x-content-type-options: nosniff` y las fijas de §4. Nunca
`set-cookie`, `location` ni `access-control-*` de la VM.

## 6. Streams y tipos de respuesta

Hoy `JSON_TYPES` deja salir solo `application/json` y `text/event-stream`: `events` (NDJSON) daría 502. Pasa a una tabla por fila:

| Fila | Content-type permitido |
|---|---|
| `events` | `application/x-ndjson` |
| `prompt-enhancements` | `text/plain` |
| `export` | `application/zip`, `text/html`, `text/markdown` (design-md, brief); siempre `attachment` y CSP sandbox, el nombre sintetizado si el de la VM no es simple |
| `shots`, `canvas/files/:n` | `image/png|jpeg|webp|gif` |
| el resto | `application/json` |

Un tipo fuera de la fila es 502 y se cancela el cuerpo. Los streams se reenvían con `upstream.body` directo, sin leerlo; si el cliente
cierra, `req.signal` corta la request a la VM. Las filas `stream` (`events`, `prompt-enhancements`) las corta el orquestador a los `WT_ORCH_STREAM_MAX_MS` (default 270 000: una Function de
Vercel corta a los 300 s) y cancelan la request a la VM. `events` cierra con fin limpio y el builder reconecta por `cursor` (ya lo hace); `prompt-enhancements` no tiene cursor, así que cierra con error y el builder no toma un texto cortado por completo.
`no-store` se conserva.

## 7. Tamaños

| Ruta | Tope | Por qué |
|---|---|---|
| JSON (todas) | 1 MiB (como hoy) | |
| `uploads`, `transcribe`, `canvas/files` | **4 MiB** en v1 | una Function no recibe más de 4,5 MiB de cuerpo; el Runtime acepta 10 MiB (`MAX_UPLOAD`) y el lienzo 200 MiB. Subir más exige subida directa a Blob (§8). UI baja `VITE_MAX_UPLOAD_BYTES` al mismo valor. |
| `export` | por stream | |

El orquestador cuenta bytes mientras reenvía y corta en el tope (413), como `readText`.

## 8. Lo que no vive en la VM, y la deuda

Revisión de Arq a #819/#823. La regla: una VM corre código del agente, así que nada que guarde un secreto ni un estado que deba valer en
todos los chats del dueño vive en ella.

- **Conectores (`connectors/*`): fuera de la VM, hecho (4b).** El runtime lee `PIPEDREAM_*` y con la allowlist de env de #810 no llegan a la
  VM. Puerto `connectors` del perfil (rol `orchestrator`): `apps(q, after)`, `accounts(owner)`, `connect(owner, app)`, `disconnect(owner, id)`.
  El orquestador valida la entrada, proyecta la salida y exige https en el enlace; `connect` tiene tope de 10 por minuto por instancia (mismo HACK que las altas de chat).
  **Corridas del agente (hecho):** el puerto suma `mcp(owner, slugs)` y `forward(owner, slug, message, session?)`. La VM (`connectors-remote.ts`) llama a
  `POST /gw/connectors/mcp` y `/gw/connectors/forward/:slug` con el token de corrida; el dueño sale del token y la credencial no entra en la VM.
  Acceso: el token de corrida lleva el claim firmado `apps` (los `connectors` del `POST /runs`, ya validados con `APP_SLUG`) y ambas rutas lo exigen: el agente no llega a
  otras apps del dueño (403 `app-not-requested`). Límites: `mcp` 10/min por dueño, `forward` 120/min por dueño (cubos propios, HACK en `routes.ts`), y las tools de lectura
  de cada app se cachean 60 s por instancia. Las respuestas se miden en **bytes** en los dos lados (`CONNECTOR_REPLY_MAX_BYTES` = 2 MiB, `src/runtime/connector-mcp.ts`; más es 502 `too-large`).
  El slug de app es `[a-z0-9]+(_[a-z0-9]+)*` (sin `_` en los bordes ni doble) para que `mcp__<slug>__<tool>` se lea de una sola forma.
  **Vida del token:** el token de corrida vale hasta su `exp`, como máximo `MAX_RUN_TTL_MS` (2 h, `routes.ts`), aunque la corrida termine, y no se revoca al desconectar una
  cuenta. Consecuencia: un agente que siga vivo tras la corrida (o un token copiado) lee las apps *pedidas en esa corrida* hasta que caduque; no otras apps ni otro dueño.
  **Límite transitorio:** el agente (mismo uid) también tiene ese token y el orquestador no distingue "la VM reenvía lo aprobado" de "el agente llama directo". Por eso las tools con `readOnlyHint` (comprobado contra el puerto en cada `tools/call`) pasan sin permiso, y una tool que escribe pasa solo con el
  grant de esa llamada (§8.1); sin él, 403 `not-read-only`.
- **"Siempre" (`approvals/always`): índice global, hecho (4b).** El orquestador es el único escritor de `always/<owner>.json` (Blob, rmw con
  etag, tope 16, solo nombres `mcp__x__y`). La VM no escribe: pregunta con `GET /gw/always` (token de corrida) y falla cerrado (si no hay
  respuesta, se pregunta a la persona). Fuera del orquestador (core local) manda el `AlwaysStore` de la VM.
- **Marcas (`brands/*`): en el índice del dueño, spec en §8.2** (antes vivían en el disco de la VM del chat: no se compartían entre chats y morían con la VM).
- **Subidas > 4 MiB y export > 4,5 MiB**: requieren subida/bajada directa a Blob con URL firmada del orquestador. Fuera de esta spec.
- **CORS**: si el builder y el orquestador no comparten origen (rewrite `/api`), el despliegue define las cabeceras y el preflight; el
  orquestador no inventa `access-control-*`.
- **Catálogo**: lo aporta el puerto `catalog` del perfil (`{ models, imageModels, capabilities? }`). Sin él, `/models` y `/image-models` dan 404 en
  vez de despertar una VM.

### 8.1 Aprobación por llamada (grant)

**Estado: implementado** (PR 4d; diseño confirmado por Arq). Reemplaza la regla "solo `readOnlyHint`" de §8 para las tools que escriben: las de lectura siguen sin permiso. Fuente: v0, verificada en los extracts (`re-iteracion/deob/`).

**Qué hace v0**
- La aprobación viaja con la herramienta y el patrón exactos. Allow: `{type:'confirmed-permissions', permissions:[{toolName, mcpName|integrationName, patterns:['Tool(patrón:*)'], rememberPatterns:['Dynamic(<tool>)']}], userMessage}`; Skip: `permissions:[]` + `skipped:true`. `v0-layers/deobfuscated.js:10023-10026` (follow-up), `:36197-36199` (skip).
- "Always allow" solo se ofrece si `rememberPatterns` es exactamente `[Dynamic(<toolName>)]` (`:36440-36456`): lo recordado es siempre `Dynamic(<tool>)`; `Tool(<prefijo>:*)` va en `patterns`, el alcance de esa llamada.
- Lo que vuelve al servidor es lo que el servidor sugirió: `permissions: e.suggestedPermissions` (`:36248-36253`, `:36355`), no lo que arme el cliente.
- Tarjeta: Allow / "Always allow <patrón>" / Skip / Allow all (`:36470-36486`). "Allow all" acepta cada tarjeta pendiente con sus propias `suggestedPermissions`, sin comodín (`:36345-36364`), y solo se ofrece con más de una pendiente (`:36783-36796`).
- Política por integración `disabled | manual | auto` ("Disable" / "Ask for approval before using Remote MCP" / "Always run Remote MCP"), `POST /chat/api/integrations/mcp/permissions`: `v0-design-mode/deobfuscated.js:4267-4300` (default `manual`), `:4331`, `:4353`, `:4447`.
- Modo por chat `permissionsMode` en cada POST (`v0-design-mode/deobfuscated.js:34981`, `:38266`); valores literales en `:32757-32775`: `ask` ("v0 asks before running commands"), `auto` ("v0 decides when to ask for confirmation"), `full` ("v0 runs any command without asking"); capturado `auto` en `v0-re/orq/net/014-REQ-v0.app_chat_api_chat.txt:1`. Sin filtro lectura/escritura en ningún punto.

**Diseño**
1. `POST ${base}/approvals/:callId` lleva `decision` (`allow|always|skip`) y **no** lleva patrones. El orquestador usa los de la petición pendiente de ese `callId`, tal como los vio la tarjeta, nunca los que mande el cliente (si no, un `chat:write` mandaría `Tool(*)`). Lo manda la persona (Bearer de sesión); el agente solo tiene el token de corrida. La decisión se fija una sola vez en el registro (segunda vez: 409 `already-decided`).
2. **Una sola fuente.** La VM registra la tarjeta antes de mostrarla: `POST /gw/approvals/pending {callId, tool}` con el token de corrida. La VM manda `callId`, `tool` y `input` (los argumentos de la llamada, objeto JSON ≤ 16 KiB, 413 `input-too-large`); los patrones los calcula el orquestador (`Tool(<tool>:*)`, y `Dynamic(<tool>)` solo para tools de gasto), así que no hay patrón que validar contra un cliente o una VM. Si el registro falla, la tarjeta no se muestra (falla cerrado). El builder pinta la tarjeta con `GET ${base}/approvals/:callId` (patrones, `rememberPatterns` y `input` del registro), no con el evento de la VM: una VM comprometida no puede mostrar `Tool(x:read*)` y registrar `Tool(x:*)`. Solo se registran tools de gasto o de una app que la corrida pidió (claim `apps`).
   - Dónde vive: `pending/<owner>/<chat>.json` en el índice (un blob por chat, rmw con etag). Tope: `PENDING_LIMIT` = 16 pendientes vigentes por chat (`src/orchestrator/chat-index.ts`); se tomó el mismo valor que `ALWAYS_LIMIT` a falta de fuente (ni v0 ni `approvals.ts` limitan pendientes; de este solo el timeout `APPROVAL_TIMEOUT_MS`, `src/runtime/approvals.ts:21`); son límites distintos y uno no arrastra al otro. Pasado el tope: 429 `pending-limit`.
   - Limpieza: cada registro vence a los `APPROVAL_TIMEOUT_MS`; un vencido se ignora al leer y se poda en la siguiente escritura del mismo blob (el contrato de Blob no tiene borrado, así que no hay un borrado que acotar: nada fuera de `pending/<owner>/<chat>.json` se toca).
3. Decidida la tarjeta (`allow|always`), la VM recoge el permiso con `POST /gw/approvals/grant {callId}`: el orquestador lo entrega **una vez** (marca `granted`) y solo si la persona ya decidió. Es un token firmado `typ:'grant'` con `{owner, chat, call, tool, patterns, args}`, donde `args` es el sha256 del JSON canónico (claves ordenadas) de los argumentos registrados con la tarjeta, vida `MAX_TTL_MS.grant` (120 s = `APPROVAL_TIMEOUT_MS`; v0 no tiene vida de grant, buscado sin coincidencias en `deob/*/deobfuscated.js`, así que es constante nuestra). La VM lo presenta con el `callId` en `/gw/connectors/forward/:slug` (`{message, callId, grant}`), junto al `tools/call` que esa aprobación cubre.
4. El orquestador exige: firma, `typ`, `chat` del token de corrida, dueño, `callId`, `tool` (`mcp__<slug>__<name>`), que `patterns` incluya `Tool(<tool>:*)` y que el hash de `params.arguments` del mensaje que se reenvía sea igual a `args` (el mismo permiso no sirve para otro destinatario u otro recurso); y consume el uso **antes** de reenviar (`used` en el mismo registro, rmw). Como mucho una vez: un reintento de red pide aprobación nueva y una tool de escritura no se ejecuta dos veces. El `callId` une aprobación y llamada en el log y cierra el límite de que el orquestador no ataba la tool al `callId`. Sin permiso: 403 `not-read-only`; con uno que no cubre (otra tool, otros argumentos, otro callId, ya usado): 403 `bad-grant`. `POST /gw/approvals/grant` limita a 120/min por dueño.
   - La decisión se fija en el registro antes de reenviar a la VM (la VM recoge el permiso en cuanto la acepta); si la VM no la acepta (no 200 o error), se revierte y la tarjeta puede decidirse otra vez. Nota: sin registro vigente (VM sin orquestador o vencido) la decisión pasa a la VM sin comprobar `spend` ni 409; es una ventana de milisegundos junto al vencimiento y la VM sigue siendo árbitro.
   - Las lecturas que no cambian nada (`none`, `decided`, sin permiso) no escriben el blob; y los errores del índice citan un hash corto de la ruta, nunca el dueño en base64url.
5. Decidir `allow|always` una tool de gasto exige el scope `spend` (403 sin él). Cierra M3 en aprobaciones; `POST /runs` sigue pendiente de Karen.
6. "Siempre" se persiste por patrón pero solo `Dynamic(<toolName>)` con `toolName` válido: `always/<owner>.json` pasa de `{tools}` a `{patterns}`, las entradas actuales se leen como `Dynamic(<tool>)`, tope 16. `Tool(<prefijo>:*)` vale únicamente en el grant de esa llamada. El "siempre" de tools de conector que escriben no se implementa (la tarjeta no ofrece el botón: `rememberPatterns` vacío); sigue siendo por llamada, como hasta ahora.
7. Política por integración (`disabled|manual|auto`) y modo por chat (`ask|auto|full`): solo diseño. Estado por dueño en el índice (`policy/<owner>.json`) y campo `permissionsMode` en `POST /runs`; se implementan cuando Karen lo pida. "Allow all" tampoco se implementa ahora.

**Riesgos para el security-reviewer del PR de código**: robo del grant desde la memoria de la VM (acotado: una llamada, una herramienta, un `callId`, 120 s, dueño y chat); `jti` consumido antes de reenviar (reintentos); un patrón `Tool(<prefijo>:*)` demasiado amplio (la tarjeta lo muestra, como en v0); que el registro `pending` no se pueda usar para escribir fuera de `pending/<owner>/`.

### 8.2 Marcas en la raíz del dueño (instrucciones y memoria)

Hoy `brands/*` lo atiende la VM del chat (`src/runtime/brand-store.ts`, `server.ts:372-410`): archivos en el disco de la VM, así que cada chat ve las suyas, mueren con ella y
la escritura de la memoria se serializa solo dentro de una instancia (`withMemory`). Lo que la persona escribe sobre su marca es del dueño, como los conectores y el "siempre".

**Qué hace v0 (buscado, `/usr/bin/grep`)**
- Sus instrucciones personalizadas son **de cuenta, sin chat**: `GET /api/v2/internal/custom-instructions` → `{instructions:[{id,title,rule,isDefault}]}` y `/custom-instructions/:instructionId`
  para editar o borrar (`deob/v0-design-mode/deobfuscated.js:29974-29975`; captura `~/v0-fe-capture/v0-re/orq-mcp/net/0010-GET-v0.app_api_v2_internal_custom-instructions.txt`;
  `~/v0-fe-capture/MAPA-menu-plus-v0.md:34-36`, métodos de la ruta con id inferidos, no vistos). Tienen tope de cantidad: `i.length >= eR.ZV` y el aviso "Maximum ${eR.ZV} custom instructions reached"
  (`:30436`, `:30493`); el valor de `ZV` vive en otro módulo y **no se encontró**, por eso el tope de abajo es nuestro.
- La selección viaja en el POST del chat como `customInstructionIds` y el servidor resuelve el texto (`MAPA-menu-plus-v0.md:36`): el texto de la regla no viaja desde el cliente.
- **No hay equivalente de v0 para la memoria por marca ni instrucciones por proyecto**: buscado `projectInstructions`, `project-instructions`, `api/v2/internal/projects` y `"memories"` en
  `deob/v0-layers` y `deob/v0-design-mode`, sin coincidencias. Memoria e instrucciones por marca son decisión nuestra (ya existen en el Runtime); lo que se toma de v0 es que viven **fuera del chat**.

**Almacén.** Un blob por (dueño, marca) en el índice global: `brands/<b64owner>/<brandId>.json` = `{ instructions: string[], memory: string, updatedAt }`, con `rmw` y etag (mismo mecanismo que `always/`).
Esto sustituye `withMemory`: dos chats del mismo dueño que escriben a la vez ya no pisan. `brandId` con `isBrandId`; el dueño sale siempre de la sesión o del token de corrida. Lo vacío no crea blob (GET devuelve `[]`/`''`).
Los errores citan `ref(pathname)`, nunca el dueño en base64url (PII, como en el índice de chats).

**Formato y límites** (los del Runtime, importados del módulo puro `memory-edit.ts` y de `shared.ts` para que no diverjan): instrucciones ≤ `MAX_INSTRUCTIONS` (10) de ≤ `MAX_INSTRUCTION_CHARS` (4000);
memoria ≤ `MAX_MEMORY_LINES` (40) y `MAX_MEMORY_BYTES` (4 KiB), líneas `- <hecho> · <messageId> · <AAAA-MM-DD>`, hecho ≤ `MAX_FACT_CHARS` (200) y filtro PII (correo, teléfono de ≥ 8 dígitos, token/clave);
errores `invalid|too_large|too_many_lines|bad_line|fact_too_long|pii|duplicate` en el cuerpo (`code`), 400 (409 para `duplicate`). Tope de marcas con estado por dueño: **32**
(`HACK:` sin fuente, nuestro; sube con el primer dueño que lo toque; pasado el tope, 429 `brand-limit`). El PUT reemplaza el campo completo (como hoy).

**Rutas del dueño** (`ROUTES`, sin `vm`, atendidas por el orquestador): `GET /brands/:id/instructions` → `{instructions}`, `PUT` `{instructions}`; `GET /brands/:id/memory` → `{text}`, `PUT` `{text}`.
Scope: lectura `chat:read`; **PUT `brand:write`** (el mismo que hoy, `http-router.ts:41`). `:id` con `isBrandId`; id inválido 400; el PUT de una marca que no está en el catálogo es 404 si hay puerto `brands`
(sin él no se puede saber y se acepta cualquier `isBrandId`, tope incluido). Alias bajo `/chats/:id/brands/...` hasta el 2026-12-05 (§3.4), con el chat del dueño exigido pero **sin tocar la VM**.

**Catálogo `GET /brands`** (packs publicados, `registry.brandIds` en `brand-store.ts`) no es estado del dueño: lo deriva la VM. Para servirlo sin chat hace falta un puerto `brands` del perfil (rol `orchestrator`,
`list() → {brands, items}`, como `catalog`). Sin el puerto, 404 en la raíz y el builder cae a `${base}/brands` (la VM, A2 perezosa). No se despierta una VM para listar.

**La VM lee y escribe por token de corrida** (`GW_ROUTES`, §3.6): `GET /gw/brands/:id` al armar el prompt (instrucciones + memoria; falla cerrado = prompt sin marca, no error del turno) y `POST /gw/brands/:id/facts`
`{text, messageId}` desde la tool `remember` (`agent-mcp.ts:200-221`), que aplica `addFact` con el rmw y devuelve la memoria resultante; la VM emite `memory.write` como hoy. Fuera del orquestador (core local sin `WT_GATEWAY_BASE_URL`) manda
el `BrandStore` del disco, igual que el "siempre" (`GET /gw/always`).

**Seguridad.**
- La memoria es superficie de prompt injection: un contenido ajeno que el agente lea puede pedirle `remember`. Contención: solo con marca y fuera de la fase plan (ya hoy), un hecho por llamada, filtro PII, 200 caracteres, tope de líneas y bytes, rate limit (30/min por dueño),
  `memory.write` visible en el stream, y la persona la ve y edita o borra con el PUT. Lo guardado entra al prompt como dato del usuario, no como instrucción del sistema (sin cambio respecto a hoy).
- `/gw/brands/*` con el dueño del token, nunca de un parámetro; una VM comprometida alcanza las marcas de **su** dueño (no otras) y solo añade hechos validados; no puede reescribir instrucciones (solo existe `facts`).
- `brand:write` para cualquier PUT; `chat:read` para leer. El cuerpo se valida con los mismos parsers antes de escribir; un blob corrupto se lee como vacío y se registra con `ref`, sin citar su contenido.
- Escribe un solo componente (el orquestador); la VM nunca recibe credenciales del Blob.

**Sin migración.** Lo que hay en el disco de las VMs vivas muere con ellas (§8); no se copia al índice. Costo conocido: instrucciones o memoria escritas antes de este cambio se pierden al despachar la VM; se dice en el PR de código.

**Tests del PR de código**: dos escritores concurrentes de la memoria no se pierden hechos; límites y PII por la ruta raíz y por `/gw/brands/:id/facts`; un dueño no lee ni escribe la marca de otro; token de otro `typ` o sin firma = 401; `brand:write` ausente = 403; `GET /brands` sin puerto = 404 sin despertar la VM.

## 9. Orden de PRs

1. Esta spec.
2. `routes.ts`: allowlist por tabla (método + patrón + scope + tipo de respuesta + tope), base `/chats/:id/...`, 404/405, tests por
   fila de §3.2-§3.4 (ruta fuera de la tabla = 404, scope por ruta, chat ajeno = 404 sin despertar la VM, cabeceras que no pasan,
   tipos de respuesta, tope de cuerpo).
3. `media-urls` + token `media` + GET con token, con test de que un token de otro chat, otra ruta, vencido o de otro `typ` falla,
   y de que el SVG no sale. Pasa por security-reviewer.
4. Catálogo (puerto `catalog`), corte de streams, conectores fuera de la VM (501) y §8.
4b. Índice global de "siempre" y puerto `connectors` (hechos) y reenvío del `connector-mcp` por el orquestador (solo lectura).
4c. Esta spec (§3.4 conectores en la raíz, §3.6, §8.1) + `GW_ROUTES` + `/connectors/*` en la raíz con alias hasta 2026-12-05 + límites y bytes de `/gw/connectors/*` (hecho).
4d. Grant por llamada (§8.1, hecho): registro `pending`, tarjeta de una sola fuente, `typ:'grant'`, "siempre" por patrón `Dynamic(<tool>)`; security-reviewer antes del merge.
4e. Marcas en la raíz del dueño: spec en §8.2 (este PR, solo docs); luego el código (almacén, rutas raíz y de la VM, tool `remember` por `/gw/brands`, alias por chat) con security-reviewer.
5. UI adapta `run-client.ts` (chat en el path, `media-urls`, tope de subida) cuando 2-4 estén en main.
