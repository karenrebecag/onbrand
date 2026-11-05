# Spec: plan mode sobre Approvals (M1 / H6)

Estado: PROPUESTO (la aprobación la escribe Karen) | Dueña: Arq (contrato) | Fecha: 2026-11-04
Base: main dc5de86d. Ajusta ADR 0012 (el bloque PLAN cambia en este modo) sin tocar `page-plan.md`.

## Referencias

- **Lovable** (`re-sistema/lovable/vivo/agente/README.md:29-36`): el agente escribe `.lovable/plan.md` y en la misma
  salida llama a `plan--show {path}`, que emite `toolApprovalRequired` (botón Approve). Un mensaje nuevo con el plan
  pendiente lo rechaza con `TOOL_REJECTION_REASON_CANCELLED_BY_USER_MESSAGE_AWAITING_APPROVAL`, y el turno siguiente
  reanuda la misma activación sin `agentStart`.
- **Make** (`re-sistema/figma-make/flujos/F-B-codigo.md:6`): `apply_patch` escribe `/plans/<slug>.md` y el turno termina
  con `toolDeferred ExitPlanMode{path, plan, planFilePath}`. La decisión vuelve como `deferredToolResponse`, que es un
  mensaje oculto al mismo endpoint, etiquetado `plan-build-response`. El proceso no se queda bloqueado.
- **Nuestro código**: `Approvals` (`src/runtime/approvals.ts`). Gasto: `SPEND_TOOLS` en :46, enforzado en el `tools/call` del
  MCP `wt` (`agent-mcp.ts:232-237`). Apertura por corrida en `run-cycle.ts:551` (`openApprovals`, `agent-mcp.ts:75-84`). Reanudación con `resume: sessionId`
  en `run-cycle.ts:598-616` (build-resume C2). Steer del turno vivo en `run-cycle.ts:311-316` y `:395-403`. `ask_user`:
  #402/#406, "el turno que pregunta no crea versión" (`index.asked`, `agent-stream.ts:81/106`, `ask-user.ts`).
  `page-plan.md` viene de ADR 0012. Builder: `tool-approval.tsx`, `run-state.ts:171-185` y `run-client.ts:305-345`.

## Decisiones

**1. Activación.** Es un flag por turno en `POST /runs`: `mode: 'plan' | 'build'`, por defecto `build`, como el chip
Plan de Make. No se hereda del padre, a diferencia de `permissionMode`, porque cada turno elige si quiere un plan.
Plan mode necesita el endpoint de aprobación (`this.port`): sin él, responde 400. No se combina con variantes,
`continue`, `restoreFrom`, `elements` ni `runtimeRepair` (también 400). Se guarda en `index[messageId].mode`.

**2. Artefacto: `.wt/plans/<messageId>.md`, no `page-plan.md`.** `page-plan.md` es estado de la página: se commitea con
la versión y el follow-up lo edita (ADR 0012 RF5). Si el turno de plan lo escribiera, ensuciaría el árbol de un turno
que no crea versión, y el siguiente commit metería un plan que nadie aprobó. `.wt/` ya está fuera del commit
(`git-workspace.ts:27`, `canvas-store.ts:2`), sobrevive al reinicio y deja historial por mensaje, como `/plans/<slug>.md`
de Make. Formato: cabecera (objetivo del turno, idioma), `## Cambios` con entradas en formato `page-plan.md`
(`## NN-rol · #ancla` + campos; en follow-up solo las secciones que toca), `## Archivos` (ruta + crear/editar/mover) y
`## Preguntas` (lo que el agente supone, marcado). Al aprobar, el turno de build vuelca las entradas en `page-plan.md`
(en el primer turno lo crea) y después escribe código. ADR 0012 sigue igual en todo lo demás.

**3. Tool `exit_plan_mode`.** Es MCP del servidor `wt` (`mcp__wt__exit_plan_mode`) con args
`{ planPath: string, summary: string }`. `summary` es una línea de hasta 200 caracteres para la tarjeta. Pasa por
Approvals igual que una tool de gasto: va en `SPEND_TOOLS`-like (`PLAN_TOOLS`), con `kind: 'plan'`. Nunca se
autoaprueba: ni `mode: 'auto'`, ni "siempre", ni `preapproveSpend`. Hay una diferencia con el gasto: **no bloquea**. El
`tools/call` valida que `planPath === .wt/plans/<messageId>.md`, que el archivo exista y que `parsePagePlanMd` encuentre al
menos una entrada en `## Cambios`. Si pasa, emite `approval.request` y `plan.ready`, guarda el pendiente en el índice y
responde al CLI "Plan enviado. Termina el turno sin escribir nada más". Es diferido, como el de Make, por tres motivos.
Primero, la persona lee un plan en minutos, y `APPROVAL_TIMEOUT_MS` es de 120 s. Segundo, un CLI bloqueado ocupa un
slot de `maxRunning` y el workspace (`running`). Tercero, una promesa en memoria se pierde al reiniciar; el pendiente en
`index.json` no. La decisión entra por la misma ruta `POST /chats/:chat/approvals/:callId`, con este cuerpo:
`{decision:'approve'}`, `{decision:'reject', feedback?}` o `{decision:'edit', plan: string}`. `edit` fusiona el texto
(la misma función que el PUT), lo escribe en `<id>.md` y aprueba con `edited: true`. `approve` aplica `<id>.md` tal
como esté: si antes hubo un borrador PUT, el prompt de build también avisa de las líneas `usuario:`. Lo decide la
presencia de líneas `usuario:` en `<id>.md`, no la decisión.
`ApprovalDecision` no cambia: approve y edit se emiten como `allow`, y reject como `skip`.

**Rechazar con feedback** (2026-11-04; antes el servidor descartaba el texto). `{decision:'reject', feedback}`, con
`feedback.trim()` no vacío, se comporta como el §5:
1. Se valida que el mensaje nuevo pueda arrancar, con las mismas precondiciones que `assertCanBuildPlan`: workspace
   libre y por debajo del tope de corridas.
2. Si no puede arrancar, se responde **409 `workspace-busy` o 429, sin marcar `rejected` y sin emitir nada**. El plan
   sigue `pending` y el texto se queda en el editor de la tarjeta, igual que un approve o un edit que no pueden
   construir (#568, #573). No se rechaza perdiendo el feedback: la persona reintenta cuando termine la otra corrida.
3. Si puede arrancar, el plan pasa a `rejected` con `approval.decision{skip}` y `plan.cancelled{rejected}`, y se crea
   un mensaje nuevo hijo del plan con `prompt = feedback`, `mode:'plan'` y `resume: plan.sessionId`. La respuesta es
   `{ok: true, messageId}`, y el builder sigue ese mensaje como cualquier turno de plan.
   - Si el plan no tiene `sessionId`, cosa que no debería pasar después de `keepPlan`, el mensaje arranca sin `resume`.
     El plan escrito sigue en `.wt/plans/` para que lo lea.

Sin feedback, o con solo espacios, el rechazo termina como hasta ahora: `rejected`, sin mensaje nuevo, respuesta
`{ok: true}`.

**Edición (ec, `plan-edit.ts`).** El marcador va dentro de la línea, nunca como prefijo, porque `ENTRY_RE` y `FIELD_RE`
están anclados a `^`. Las formas son tres:
- Campo: `- titular: usuario: Texto`.
- Entrada nueva: sin marca en el `## NN-rol`, con todos sus campos marcados.
- Resto de líneas: `- usuario: <línea>` si es viñeta, `usuario: <línea>` si no lo es.

Se exportan `stripUserMarks` y `userLines`. El diff es LCS por línea contra el plan original del agente, quitando las
marcas antes de comparar, así que es idempotente. Las líneas borradas no se marcan. El original lo congela Secondary
al validar `exit_plan_mode`, en `.wt/plans/<messageId>.agent.md`, y no se vuelve a escribir.
`PUT /chats/:chat/plans/:messageId` (solo con el plan `pending`; 409 si no) escribe el borrador fusionado en
`.wt/plans/<messageId>.md`.

Validación:
- ≤ 64 KiB UTF-8.
- Tiene `## Cambios`.
- ≥ 1 entrada `## NN-rol` parseable.
- Sin slugs repetidos.
- No se exige `planDefects`.

`plan-edit.ts` devuelve el error tipado `{ok:false, code, message}`. El PUT lo responde con 400 y cuerpo
`{error: message, code}`, donde `code` ∈ `too_large | no_changes_section | no_entries | duplicate_slug`. `parsePagePlanMd` se aplica SOLO al bloque `## Cambios`, cortado hasta el siguiente `## ` que no sea
`NN-rol`. Sin ese corte, las viñetas `clave: valor` de `## Archivos` o `## Preguntas` se pegan como campos a la última
sección. Esto vale también para el validador de `exit_plan_mode` (orq).

**Tools en modo plan.** `allowedTools` = `Read`, `Glob`, `Grep`, `Bash(ls:*|cat:*|head:*|grep:*)`, `mcp__wt__ask_user` y
`mcp__wt__exit_plan_mode`. `Write` y `Edit` no van: caen en la permission-prompt-tool. En `Approvals.ask`, con
`phase: 'plan'`, solo pasan si `file_path` resuelve a `.wt/plans/<messageId>.md`; el resto se deniega con "modo plan: sin
cambios al código". Corrección al mapa de orq: Write y Edit son nativas del CLI y no pasan por `workspace-mcp`, así que
el filtro por ruta vive en `approvals.ts`. Si una tool de conector de lectura está conectada, sigue la regla actual;
las de escritura y gasto se deniegan en esta fase.

**4. Estados y eventos.** Estado del pendiente en `index[messageId].plan`:
`{ callId, path, summary, sessionId, status: 'pending' | 'approved' | 'rejected' | 'cancelled' }`. Eventos en el log
del mensaje:

| evento | cuándo |
|---|---|
| `plan.start {path}` | arranca un turno con `mode:'plan'` |
| `plan.ready {callId, path, summary}` | `exit_plan_mode` válido (después de `approval.request {kind:'plan'}`) |
| `approval.decision {callId, decision, reason?}` | la persona decide; `reason: 'user-message' \| 'stopped'` si se cancela |
| `plan.resumed {callId, edited}` | approve/edit: arranca la fase build del mismo mensaje |
| `plan.cancelled {callId, reason: 'rejected' \| 'user-message' \| 'stopped'}` | reject, un mensaje nuevo o `POST /runs/:id/cancel` |

El agente expone `turn.planExit {callId, planPath, summary}` en `AgentTurn`, igual que `turn.question`. El composer
lo pasa a `agent.planExit` en `page.json` y a la traza.

**Fase build (approve).** Se lanza otra corrida sobre el **mismo messageId**, con `resume: sessionId`, `CLI_TOOLS`
completos, aprobaciones nuevas (`openApprovals`) y el prompt "Plan aprobado en `<path>`[, editado por la persona: sus
líneas `usuario:` mandan] (el aviso va siempre que `<path>` tenga líneas `usuario:`, venga de `edit` o de un PUT previo
+ `approve`). Vuelca sus entradas en `page-plan.md` y aplícalo". Reusa el patrón de build-resume
(`run-cycle.ts:598-616`). Esta fase sí crea la versión del mensaje.
Si el build aprobado no cambia nada fuera de `.wt/` (`commitAll` devuelve el commit del padre), el mensaje queda **sin
versión propia** (`planOnly`, #554), como un turno `asked`. El resumen del turno lo dice explícitamente, con un texto
que pinta el builder: "El plan se aplicó sin cambios en la página: no hay versión nueva". Así la persona no lo lee
como un fallo ni busca una versión que no existe.

**Sin auto-repair después de la fase build** (2026-11-04, hallazgo 6 de la QA en vivo). `autoRepairAfter` no lanza
nada sobre un mensaje con `plan`. Si el preview-check marca defectos, se ofrece el botón manual de arreglar.
- Por qué: la persona aprobó un plan concreto, y un arreglo automático es otro cambio y otro gasto que no aprobó. La fase
  build ya verificó la página con su tool browser.
- Regla en código: `if (e.plan) return undefined` en `autoRepairAfter`, junto a las demás exclusiones (`asked`,
  `variantOf`, `kind`…).

Aparte, y para todo turno, no solo de plan: el auto-repair `runtime` se disparó por `cta-wrap` y `contrast`, que son
defectos de diseño y no de runtime. **Cerrado.** `hasRuntimeErrors` (`runtime-repair.ts:97`) filtra por `RUNTIME_KINDS`
(`pageerror | console | request | unmounted`), la única lista, definida en `runtime-kinds.ts:7` y re-exportada por
`runtime-repair.ts:95`. El builder importa la misma constante (`run-state.ts:4`, `:261`; la usa al contar en `:276`), así que
"Arreglar" y el auto-repair cuentan lo mismo. Los defectos de diseño no disparan ningún auto-repair.

**Ciclo de vida de un mensaje con dos fases** (corrección 2026-11-04, BUG 2 de la QA de UI). El log del mensaje tiene
dos tramos: plan (`message.start … message.end{asked}`) y build (`plan.resumed … message.end`). La regla es que **la
corrida de un mensaje terminó si su último evento de ciclo es `message.end`**, y `plan.resumed` abre un tramo nuevo.
Cómo se aplica:
- `readEvents(...).done` (`events.ts:87`) = el último evento entre `message.end` y `plan.resumed` es `message.end`.
  Hoy mira si hay *algún* `message.end`, y por eso `GET /chats` da `done: true` durante el build.
- El fold (`event-model.ts`, `plan.resumed`) vuelve a poner `status: 'streaming'` y borra `outcome`, `usage`,
  `interrupted` y `continuable` del tramo anterior. Se quedan el plan, las aprobaciones y los pasos del plan, que son
  historia del turno.
- `resumePlanBuild` hace `finished.delete(id)` antes de `launch`. Si no, `stream()` corta el SSE porque
  `isFinished(id)` sigue en true desde el `settle` del plan.

La corrección va en el fold y en `done`, no en `thread()`. `thread()`, `stream()` y el replay del builder leen esas
dos fuentes; un parche solo en `thread()` deja el SSE cortado y el replay en `stop`.

**5. Un mensaje nuevo cancela y reanuda.** Hay dos casos de `POST /runs` con `parentId` = el mensaje del plan:
- El turno de plan sigue vivo: no cambia nada, el mensaje es un steer (`run-cycle.ts:311-316`).
- El plan está `pending`: se emite `approval.decision {decision:'skip', reason:'user-message'}` y `plan.cancelled`
  en el log del plan. El mensaje nuevo corre con `resume: plan.sessionId`, la misma sesión del CLI y sin contexto
  fresco, que es el "sin `agentStart`" de Lovable. Si el cuerpo no trae `mode`, sale en `plan`, porque la persona está
  iterando el plan. Su `parentId` de versión es el del plan, que no tiene versión. El prompt avisa: "El plan anterior
  no se aplicó; ajústalo con este mensaje".

**6. El turno de plan no crea versión.** Funciona como `asked` (#406): la entrada no tiene `commit` propio, `versions()`
la filtra y el picker no la ve. Si el CLI escribió fuera de `.wt/plans/`, cosa que el filtro de Approvals impide, el
transport lo descarta con `git checkout`/`clean` del árbol antes de cerrar. Si el turno de plan termina sin
`exit_plan_mode`, cae al caso `asked` cuando hubo `ask_user`. Si no lo hubo, es un error visible: "el plan no se envió".

**7. System prompt.** Con `mode:'plan'`, `agentSystemPrompt` reemplaza SECCIONES y RESUMEN FINAL por el bloque **MODO
PLAN: solo plan, no código**. El bloque dice: lee el workspace (`page-plan.md` primero en follow-up), escribe
`.wt/plans/<messageId>.md` con el formato del punto 2, llama a `exit_plan_mode` y termina; no escribas `src/` ni
`page-plan.md`; si falta un dato que v0 preguntaría, usa `ask_user` antes del plan. El bloque PLAN de ADR 0012
(`agent-prompt.ts:195`) se mantiene como **formato** de las entradas. La regla "escríbelo antes de la primera
sección" pasa a la fase build. El follow-up (`:170`) en modo plan lee el plan y no edita archivos.

## 7b. Cliente (builder)

Lo que el builder hace y QA verifica. La fuente de los textos es esta tabla.

**1. Errores al decidir (`POST /chats/:chat/approvals/:callId`) y qué hace la tarjeta.**

| respuesta | significa | tarjeta |
|---|---|---|
| 409 `workspace-busy` | otra corrida usa el workspace | "Hay otra construcción en curso. Reintenta de nuevo cuando termine." El plan sigue pendiente y se puede reintentar |
| 429 | tope de corridas | "Hay demasiadas construcciones en curso. Reintenta de nuevo en un momento." Se puede reintentar |
| 409 `plan-decided` | ya se decidió (otra pestaña) | muestra el mensaje y no invita a reintentar |
| 409 `plan-missing`, `plan-no-session`, `plan-no-original` | el plan no se puede decidir así | muestra el mensaje y no invita a reintentar |

Con 409 o 429, approve, edit y reject con feedback dejan el plan `pending` y el texto editado o el feedback se queda en
el editor (#568, #573).

**2. Decidir espera el cierre del turno de plan.** El `sessionId` se guarda en `keepPlan`, al cerrar el turno, y antes
de eso el servidor responde `plan-no-session`. La tarjeta deshabilita Aprobar, Editar y Rechazar hasta el
`message.end` del turno de plan.

**3. El stream sigue abierto con un plan pendiente, en los dos lados.**
- Servidor: `stream()` no cierra mientras `plan.status === 'pending'` (#570).
- Cliente: `streamRun` no termina la lectura mientras quede un `approval.request{kind:'plan'}` sin su
  `approval.decision`, aunque lleguen `message.end` y `settled` (`run-client.ts`, `pendingPlans`). La decisión, la
  cancelación por mensaje nuevo y la fase build llegan después al mismo log.

**4. Estado → texto de la tarjeta.**

| estado | texto |
|---|---|
| `pending` | "Plan listo para revisar" |
| aprobado | "Aprobado" |
| aprobado con edición (`edited`) | "Aprobado con tus cambios" |
| `rejected` | "Rechazado" |
| `cancelled{user-message}` | "Cancelado por mensaje nuevo" |
| `cancelled{stopped}` | "Detenido sin construir" |
| build aprobado sin cambios | "El plan se aplicó sin cambios en la página: no hay versión nueva" (tono neutro, sin "Ver cambios") |

## 8. Reparto por archivo

| dueño | archivos | qué |
|---|---|---|
| **Secondary** | `src/runtime/server.ts` | `mode` en `start()`, con validación y 400 por combinaciones; `index.plan`; decisión diferida en `approvalDecision`; fase build con `resume` en el mismo messageId; mensaje nuevo cancela el pendiente (§5); sin versión (§6); `plan.*` en el log; `POST /runs/:id/cancel` sobre un pendiente |
| **Secondary** | `src/runtime/approvals.ts`, `src/runtime/event-model.ts` | `PLAN_TOOLS`, `kind: 'plan'` sin auto ni siempre; `phase` por corrida y filtro de `Write`/`Edit` a `.wt/plans/<id>.md`; tipos `plan.*`, `reason` en `approval.decision`; fold en `MessageState.plan` |
| **orq** | `src/runtime/agent-prompt.ts`, `src/runtime/plan-exit.ts` (nuevo), `src/runtime/workspace-mcp.ts`, `src/runtime/agent-stream.ts`, `src/runtime/agent-composer.ts`, `src/runtime/agent-loop.ts` | bloque MODO PLAN y prompt de fase build; def y validación de `exit_plan_mode {planPath, summary}`; registro en `WORKSPACE_TOOL_DEFS`; `turn.planExit`; `allowedTools` de modo plan (`PLAN_CLI_TOOLS`); `agent.planExit` en la traza |
| **ec** | `src/runtime/plan-edit.ts` (nuevo), ruta `PUT /chats/:chat/plans/:messageId` en `transport.ts` (coordinada con Secondary) | fusión del texto editado con las líneas `usuario:`; el PUT escribe el borrador en `<id>.md` mientras el plan está `pending` (409 si no lo está; 400 `{error, code}` si no valida); `<id>.agent.md` no se toca |
| **UI** | `apps/builder/.../agent-run/tool-approval.tsx`, `run-state.ts`, `run-client.ts` | tarjeta `kind:'plan'` con el plan renderizado, Aprobar / Editar / Rechazar (con feedback); `decideApproval` acepta `edit` y `reject`; `toRunState` sin "Ver cambios" en un turno de plan; chip Plan en el composer → `mode:'plan'` |
| **QA** | `tests/` (transport, approvals, agent-prompt, agent-stream) y arnés | (a) en plan no se escribe nada fuera de `.wt/plans`; (b) no hay versión y el picker no cambia; (c) approve → fase build en el mismo messageId con `resume`, `page-plan.md` = Cambios del plan; (d) mensaje nuevo → `plan.cancelled{user-message}` + resume; (e) `auto` no autoaprueba; (f) reinicio con plan pendiente → la decisión sigue funcionando; corrida en vivo del brief de la marca piloto en plan + approve |

Fuera de alcance: planes multi-página, aprobar por sección, "siempre aprobar planes", y un plan de una variante.
