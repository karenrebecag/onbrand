# Deploy con un Sandbox por chat: las cuatro piezas que deja ADR 0016

Estado: PROPUESTA, borrador (Arq, 2026-11-04, main al día). No decide dependencias, gasto ni topes: §5 lista lo que es
de Karen. Cada deploy concreto sigue pidiendo su OK.
Base: ADR 0016 (decisión y condiciones 1-3; "Lo que queda para las specs del deploy"), ADR 0013 (D1, D2, D3, D5),
`docs/spec/identidad-sesion.md` (§4, §9), `docs/notas/deploy-builder.md` (el rewrite fijo de hoy),
`re-iteracion/re-ejecucion/adr-borrador.md` §6. API de Sandbox: `vercel.com/docs/sandbox/sdk-reference`, consultada
el 2026-11-04.

## 0. Forma

```
builder (Vercel, estático) ──/api──▶ orquestador (Functions) ──▶ Sandbox del chat (VM): Runtime + CLI + vite
                                          │  sesión, índice global, crear/reanudar      ▲
                                          │  proxy de Gateway (llave fuera de la VM) ────┘ ANTHROPIC_BASE_URL
                                          └─ Blob privado: índice, logs, bundles git, registry
```

El orquestador no corre el loop ni las tools (ADR 0016). Es el único que tiene credenciales: OIDC del team para
Gateway, Blob y la API de Sandbox.

## 1. Proxy de Gateway con tope por dueño y por corrida (condición 2)

- **Hoy:** `agentEnv` quita `AI_GATEWAY_*` y `VERCEL_*` del entorno del CLI (`agent-loop.ts:97`). `gatewayInfer` lee la
  llave del entorno del proceso (`infer.ts:158-160`), que en la VM sería el del Runtime, y el agente puede leerlo con
  el mismo uid.
- **Propuesta:** dentro de la VM nadie tiene llave. El CLI arranca con
  `ANTHROPIC_BASE_URL=https://<orquestador>/gw/claude-code`, `ANTHROPIC_AUTH_TOKEN=<token de corrida>` y
  `ANTHROPIC_API_KEY=""`, que es la forma documentada de pasar Claude Code por Gateway
  (`ai-gateway/coding-agents/claude-code`). `gatewayInfer` (sugerencias, plan de imagen, enhancer) apunta al mismo
  proxy por `WT_GATEWAY_BASE_URL`, con el token de la corrida o uno del Runtime con alcance a la VM.
- **El proxy** (`/gw/*` en el orquestador):
  1. Valida el token: es el de `approvalRuns` (`agent-mcp.ts:77-93`), firmado y con `{ owner, messageId, exp }`, para que
     el orquestador lo verifique sin preguntarle a la VM.
  2. Comprueba el tope antes de reenviar: gasto acumulado del dueño en la ventana, y de la corrida. Si se pasa, responde
     429 con un cuerpo que el CLI muestra como error del turno, y la corrida cierra con su motivo (A7: el motivo se
     nombra).
  3. Reenvía a `ai-gateway.vercel.sh` con el OIDC del orquestador y suma `usage` de la respuesta (también en
     streaming) al contador. El contador vive en el índice global (§3), con un solo escritor (A2).
- **Lo que verificó orq contra el CLI** (`claude` 2.1.318, servidor local falso, sin gasto): con `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN` y `ANTHROPIC_API_KEY=""` el CLI hace `POST <base>/v1/messages` con `Authorization: Bearer <token>` y
  sin `x-api-key`. Antes manda un `HEAD <base>/api/hello` (el proxy debe tolerarlo: un 404 vale) y ante un 5xx reintenta el POST
  3 veces. Con `ANTHROPIC_AUTH_TOKEN` puesto el CLI avisa "claude.ai connectors are disabled": su login de claude.ai queda
  fuera, y con él los conectores que dependen de él (relevante para el MCP de imágenes de la distro, abajo).
- **Rutas que el CLI usa (re-verificado con `claude` 2.1.318 y servidor falso, sin gasto):** un turno normal llama solo a
  `POST /v1/messages?beta=true`; `/context` dispara decenas de `POST /v1/messages/count_tokens?beta=true`. El proxy reenvía
  ambas con la query tal cual, con el mismo token y la misma lista de headers; count_tokens no suma gasto ni mira el tope.
  Cualquier otra ruta es 404 y no se reenvía.
- **El gasto no depende de que el cliente se quede** (security-reviewer, HIGH): quien tiene el token controla cuándo corta. El
  abort del cliente no llega al upstream; la respuesta se drena hasta el usage real bajo `waitUntil`; si el upstream no lo
  entrega (corte de red, error del stream) se cobra una estimación (bytes del body / 3 de entrada, `max_tokens` de salida).
  Si `addSpend` agota reintentos, el dueño queda bloqueado (429) hasta que el gasto pendiente se registre (en memoria de la
  instancia: HACK con disparador en el código). `priceOf` es del orquestador y debe pasar `checkPriceOfContract`; la
  implementación real debe cubrir contexto de 1M (header `anthropic-beta`), cache de 1 h (`ephemeral_1h_input_tokens`, 2x) y
  `server_tool_use` (web_search), que llega acumulado en `message_delta`.
- **Reserva antes de reenviar** (security-reviewer, 2.ª pasada): el proxy cobra la estimación (bytes/3 de entrada + `max_tokens` de
  salida, a `priceOf(modelo)`) ANTES de reenviar y la ajusta al usage real al cerrar (`adjustSpend`, delta de cualquier signo).
  Así el gasto no depende de que la instancia viva hasta el final (`maxDuration`, upstream colgado) y las requests paralelas del
  dueño se ven entre sí. Un rechazo del upstream devuelve la reserva; un 502 la deja cobrada. `deps.deadlineMs` (maxDuration menos
  margen) cierra la cuenta con lo visto antes de que la Function muera. El body se lee con contador y tope `maxBodyBytes`
  (default 4.5 MB, el límite de Functions). **Pendiente:** `count_tokens` no tiene límite de tasa por dueño; un token robado
  puede martillarlo sin costo. Rate limit en memoria por dueño cuando haya una cifra aprobada.
- **Notas de la reserva (tercera pasada):** los ajustes llevan un id y el contador recuerda los últimos 64 (`applied`), así un
  reintento tras un error ambiguo de Blob no suma dos veces. No se cubre en la reserva: server tools, `cache_creation` a
  1.25x/2x ni contexto de 1M (HACK en el código; el ajuste final lo corrige). Casos conocidos: si el deadline vence en la ruta JSON,
  el `text()` sigue vivo y su resultado se descarta (502); un 2xx sin body devuelve la reserva; si `credential()` lanza tras
  reservar, responde 502 y la reserva queda cobrada; el 429 por tope no suma la reserva de la propia request (ya HACK en
  `chat-index`: reserva condicional dentro del rmw).
- **`waitUntil` obligatorio** (Arq, seguimiento de #727): `createGatewayProxy` lanza sin él. **Pendiente de Karen (gasto real):** si el Gateway
  deja de generar cuando el cliente corta. Hoy el abort del cliente no llega al upstream y el drenaje se cobra entero, aunque nadie
  lea el output; si el Gateway cortara al cancelar, se cancelaría el upstream y se cobraría lo visto más la estimación conservadora.
  Verificarlo cuesta una corrida real mínima (`max_tokens` 50).
- **Token por corrida en la VM** (`x-wt-run-token` en `POST /runs` → `agentEnv`): el runtime lo trata como opaco y no lo ata a la
  sesión. **Requisito del forwarder:** el orquestador borra o reemplaza cualquier `x-wt-run-token` del cliente antes de
  reenviar (test futuro con el forwarder). El token no se escribe en `request.json` (`requestRecord`). Solo `POST /runs` normal
  lo lleva: restore, patch, continue, variants, repair, updateDs, applyBrand, applyTheme (`run-cycle.ts` despacho previo), la
  aprobación de plan (`startTurn`) y el steer caen al token de la VM (por chat) hasta que se extienda.
- **Guard de arranque:** con proxy, `scripts/serve.ts` sale con 2 si el entorno trae `AI_GATEWAY_API_KEY` o `VERCEL_OIDC_TOKEN`
  (`assertNoKeyWithProxy`). Hoy leen la llave directo `image-step.ts` (gatewayImageGen), `image-tool.ts` (gatewayImageEdit) y
  `transcribe.ts`: con proxy y una llave sobrante la usarían sin avisar y el agente podría leerla. Con el guard fallan sin
  llave en vez de filtrarla.
- **Pendiente del proxy: otra familia de rutas.** La transcripción (`transcribe.ts:12`, `POST /v4/ai/transcription-model`)
  y las imágenes (`image-step.ts`, `image-tool.ts`, con `@ai-sdk/gateway`, base `https://ai-gateway.vercel.sh/v4/ai`)
  usan el protocolo propio del Gateway, no la Messages API, y cobran por imagen o por audio, no por tokens. Ninguna sale
  aún por el proxy; sin proxy siguen como siempre. Para pasarlas: `createGateway({ baseURL: <orquestador>/gw/v4/ai,
  apiKey: <token> })` (el SDK instalado acepta las dos opciones), y la familia `/gw/v4/ai/*` en el proxy con su propio
  contador.
- **Token por corrida o por VM.** Hoy `agentEnv` toma `ANTHROPIC_AUTH_TOKEN` del entorno del Runtime: es un token por VM,
  o sea por chat. El tope por corrida necesita `{ owner, messageId, exp }` por corrida: el orquestador lo firma y lo manda
  en el reenvío de `POST /runs` (§4), y `agentEnv` lo recibe por corrida. Hasta entonces el tope es por chat. Un token con
  `exp` en el entorno de una VM persistente vence entre reanudaciones, así que se renueva en el reenvío o en `onResume`.
  El tope suma el `usage` de las respuestas, no los reintentos del CLI.
- **Imágenes en la VM.** La generación de imágenes del perfil de la distro va por el MCP de imágenes de la distro con el OAuth de la
  persona, solo en `cli` (memoria del deploy: "imágenes solo en cli"). En la VM no sirve: con `ANTHROPIC_AUTH_TOKEN` se
  apagan los conectores de claude.ai, y además la credencial de la persona tendría que estar dentro de la VM, que es lo
  que este punto prohíbe. Ya hay alternativa en el código, sin OAuth: `imageProvider: 'gateway'` (`config.ts:16`, flux
  por el Gateway), pasada por el proxy de arriba. Recomendación de Arq: `gateway` en la VM y el MCP de imágenes solo en local
  o `cli`. Cambiar el proveedor del perfil de la distro es de Karen (§5).

## 2. Sandbox desde un snapshot base

- **Snapshot base:** un Sandbox con el scaffold ya instalado (`templates/base-scaffold` en el core; `templates/arc-scaffold` en la distro, que lo lleva desde el alpha) (`bun install`) y el registry del DS montado
  se congela con `sandbox.snapshot()`. Cada chat nuevo nace con
  `Sandbox.create({ source: { type: 'snapshot', snapshotId }, ports: [api, preview], env, networkPolicy, tags: { chat, owner } })`.
  Sin instalar, el primer turno arranca en segundos (hoy instala por ws).
- **La base se rehace** cuando cambia el hash del scaffold (`templates/base-scaffold` o, en la distro, `templates/arc-scaffold`; lockfile incluido) o el pin del registry.
  `snapshotExpiration` por defecto es de 30 días: la base se fija con `0` (sin vencimiento) o se rehace antes de que
  venza. Esto se anota como HACK con disparador si se elige rehacerla por cron.
- **Chat existente:** `persistent: true` (el default) guarda el FS al parar y lo restaura al reanudar, y `onResume`
  relanza vite (D3, `adr-borrador.md:194`). El snapshot del chat **no es verdad** (D5): si venció o falta, el chat se
  recrea desde la base más el bundle git del último commit en Blob (D5-a).
- **Vida:** el timeout por defecto es de 5 minutos. El latido del builder (`POST /preview/heartbeat`, D3) le llega al
  orquestador, que llama a `extendTimeout` del Sandbox del chat. Sin latido, la VM se para sola y conserva su snapshot.
- **Red de salida:** `networkPolicy` con lista permitida (el proxy del orquestador, el registry de paquetes y las
  fuentes) en vez del `allow-all` por defecto. La forma exacta de `NetworkPolicy` hay que verificarla en la docs antes
  de implementar. Así una página del agente no puede mandar datos a terceros desde la VM.

## 3. Índice global de chats

- **Hoy:** `index.json` vive en el root del Runtime (`server.ts`, `indexPath`) y es la verdad de todo: dueño,
  versiones, plan, `pendingRepair`. Con un Runtime por VM queda un índice por chat dentro de su VM, pero el orquestador
  necesita saber qué chats existen y de quién son sin despertar N VMs.
- **Propuesta:** dos niveles.
  - **Global (orquestador, Blob):** una entrada por chat
    `{ chatId, owner, title, sandbox: { name, snapshotId? }, head: { messageId, commit }, updatedAt, spend }`. La
    escribe solo el orquestador (A2), al crear el chat y cuando la VM le avisa un `settled`. Sirve para listar chats
    por dueño (`GET /chats`), resolver chat → Sandbox y llevar el contador del proxy (§1).
  - **Local (VM):** el `index.json` de hoy, sin cambios. Sigue siendo la verdad del detalle del chat.
- **Escritura concurrente:** el contador de gasto y el `head` se escriben desde varias Functions. Blob sí ofrece
  escritura condicional (verificado el 2026-11-04 en `vercel.com/docs/vercel-blob`): `head()` da el `etag`, y
  `put(path, body, { allowOverwrite: true, ifMatch: etag })` solo escribe si nadie cambió el blob; si cambió, lanza
  `BlobPreconditionFailedError` y se relee y reintenta. Sin `allowOverwrite`, `put` falla si el blob ya existe, y eso
  sirve para crear la entrada una sola vez. Está en `@vercel/blob` 2.8.2; desde el alpha el core ya no depende de `@vercel/blob`: el orquestador recibe un `BlobClient` por deps
  (`src/orchestrator/chat-index.ts`) y el adaptador sobre `@vercel/blob` lo aporta la distro. Cuando esto se escribió el paquete estaba en `package.json` y no hacía falta dependencia nueva.
  - **Contención:** un blob por dueño para el contador (`spend/<base64url(owner)>.json`) y uno por chat para la entrada
    (`chats/<base64url(owner)>/<chatId>.json`), no un solo `index.json` global. Así el reintento solo choca entre
    corridas del mismo dueño, y `GET /chats` lista por dueño con `list({ prefix })`.
  - **Tope no atómico:** el proxy lee el contador antes de reenviar y suma después. N corridas paralelas del mismo dueño
    pueden pasarse del tope por hasta N respuestas. Se anota como HACK con disparador: "reservar un presupuesto antes de
    reenviar, cuando el exceso medido supere el 10 % del tope".
- **Recuperación (A6):** primero el estado y después el evento. La VM escribe su `index.json` antes de avisar `settled`,
  y el orquestador escribe la entrada global antes de responder al builder.

## 4. Destino por chat en vez del rewrite fijo (I2b)

- **Hoy:** `vercel.json` reenvía `/api/*` a **un** host de Sandbox con el secreto de origen (`deploy-builder.md` §proxy).
  ADR 0016 condición 1 lo prohíbe con el agente dentro de la VM.
- **Propuesta:** `/api/*` llega a una Function del orquestador, no a un rewrite estático.
  1. Corre el `SessionVerifier` del perfil (identidad §4) y resuelve el dueño contra el índice global. Un chat ajeno o
     inexistente da 404 (identidad §5).
  2. Despierta o crea el Sandbox del chat (§2) y reenvía al Runtime de la VM con un header de identidad firmado
     `{ owner, scopes, chat, exp }` (ADR 0016, "Dónde se valida el token"). El Runtime lo verifica con un
     `SessionVerifier` "orquestador firmado", que es el adaptador de la VM, en `http-router.ts`, sin cambiar el puerto.
     **La firma es asimétrica**, por la misma razón que el preview (abajo): el orquestador firma con su llave privada
     Ed25519 y la VM solo tiene la pública, en el entorno al crearla. Con un HMAC compartido, el agente leería el
     secreto del entorno del Runtime (mismo uid) y se fabricaría headers con cualquier `owner` y cualquier `scopes`, por
     ejemplo `spend` en un chat que solo tenía `chat:read`. El header lleva `exp` corto (minutos) y el `chat` de la VM: la
     VM rechaza un header de otro chat aunque la firma valga.
     **Cableado (`WT_SESSION_PROVIDER=signed`):** el verifier firmado REEMPLAZA a `localVerifier`, no se compone con él: el
     agente hace `curl` a 127.0.0.1 con el mismo uid y `isTrustedRequest` por loopback lo dejaría pasar. La VM recibe en el
     entorno `WT_IDENTITY_PUBLIC_KEY` y `WT_CHAT_ID`; si falta cualquiera, `serve.ts` sale con 2. Los callbacks del CLI
     (`/mcp`, approval-requests, connector-mcp) siguen con el token de corrida y sin verifier. `WT_ORIGIN_SECRET` puede
     convivir, pero el agente lo alcanza en el entorno: suma a la identidad, nunca la sustituye.
     **Riesgo aceptado (Arq):** `x-wt-identity` vive en la memoria del Runtime y el agente podría leerlo. Vale 15 min
     (`MAX_TTL_MS`), solo para ese chat, con los scopes del dueño, y el gasto lo acota el proxy del Gateway.
  3. Las rutas sin chat (`/models`, `/brands`, `/uploads`, `/connectors`) las responde el orquestador o una VM de
     servicio. La lista sale de `NO_ID_FAMILIES` (`http-router.ts:28`).
- **Stream de eventos** (`GET /runs/:id/events`, largo): pasarlo por la Function depende del tope de duración de
  Functions, que hay que verificar. Alternativa, como v0 (`vm/open`): el orquestador entrega un token con alcance de
  chat y el builder abre el stream directo contra `sandbox.domain(api)`, con el mismo patrón del token de preview
  (identidad §9). En ese caso la CSP del builder suma `connect-src https://*.vercel.run` (`deploy-builder.md`, CSP).
- **Preview:** ya es por chat (`sandbox.domain(preview)`). El `WT_PREVIEW_SECRET` **no entra en la VM**. #711 lo saca
  del entorno del CLI y de `sh`, pero el agente corre con el mismo uid que el Runtime y puede leer el entorno de ese
  proceso (`/proc/<pid>/environ`). Con el secreto podría firmarse tokens de cualquier ws. Es la misma clase de fuga que
  la llave del Gateway (ADR 0016, condición 2). Dos formas, a elegir al implementar §4:
  - **(a) Lo firma y lo verifica el orquestador.** El latido ya pasa por la Function (§2, "Vida"), así que el token se
    firma ahí. El preview se sirve a través del orquestador, que verifica el token antes de reenviar a
    `sandbox.domain(preview)`, y la VM no verifica nada. Costo: el HMR y los assets del preview pasan por la Function.
  - **(b) Firma asimétrica.** El orquestador firma con una llave privada y la VM verifica con la pública. La VM solo
    tiene la pública, que no sirve para firmar. Cambia el HMAC de `preview-token.ts` por una firma asimétrica: el
    formato del token y la verificación son código nuevo, sin dependencia (Ed25519 de `node:crypto`).
  - **Decidida: (b)** [Orq, 2026-11-04, por delegación de Karen; recomendación de Arq]: sin dependencia nueva, el
    preview sigue directo contra la VM (D3) y lo que hay dentro de la VM no sirve para fabricar acceso. Usa el mismo par
    de llaves que el header de identidad (§4.2), con `typ` distinto en el payload (`preview` | `identity`), para que un
    token de preview no valga como identidad ni al revés.
  - **Implementado** (#726): la VM verifica con `WT_PREVIEW_PUBLIC_KEY` (Ed25519) y nunca firma; el orquestador acuña con
    `issuePreviewToken` (`src/orchestrator/identity.ts`). El gate reautoriza el owner del token contra el dueño del ws
    (`ownsWs`), porque el orquestador podría firmar para cualquiera. **Pendiente de cableado:** en modo asimétrico el
    latido (`preview-dist.tokenFor`) reenvía el token por el hook `forwardedPreviewToken`, que hoy el orquestador aún no
    inyecta; hasta entonces `POST /preview/heartbeat` no devuelve `previewToken` bajo el orquestador (la VM no acuña).

## 5. Lo que decide Karen (no esta spec)

| decisión | por qué es suya |
|---|---|
| Topes de gasto por dueño y por corrida (cifras y ventana) | gasto |
| `@vercel/sandbox` en el orquestador | dependencia nueva |
| Región y recursos de la VM (`region`, `resources`), retención de snapshots | gasto |
| Proveedor de imágenes del perfil de la distro en la VM: `imageProvider: 'gateway'` por el proxy (recomendación de Arq, §1) o el MCP de imágenes de la distro con credencial en la VM | gasto y proveedor |
| Transcripción en la VM: por el proxy (§1) o apagada | gasto |
| Cada deploy | regla de la casa |

## 6. Orden sugerido (cuando haya OK)

1. §3 índice global (sin VM todavía: el orquestador lista y resuelve contra el Runtime de hoy).
2. §4 orquestador en `/api` con el header firmado; el Runtime gana su `SessionVerifier` de VM.
3. §1 proxy de Gateway y fuera las llaves del entorno del Runtime.
4. §2 Sandbox por chat desde la base; recién ahí se retira el rewrite fijo.

Cada paso deja el deploy funcionando con el paso anterior; ninguno exige los cuatro a la vez.
