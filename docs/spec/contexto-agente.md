# Spec: contexto del agente, lo que sabe y lo que la persona ve (M2)

Estado: PROPUESTO (la aprobación la escribe Karen) | Dueña: Arq (contrato) | Fecha: 2026-11-04 | Base: main 77909a73
Huecos que cierra: H18 (plegado y ratio), H8 (memoria por marca), C4 (facts.disclosed por corrida), C6 (instructions
heredadas) y Q6 (viewport en el browser tool).

## Referencias

- **Lovable** (`re-sistema/lovable/vivo/agente/README.md`):
  - :84-93: el build follow-up no lee `mem://` ni `.lovable/rules/*` por tools. La memoria le llega inyectada
    (`user:knowledge_context` 15 975 tokens). El turno de chat sí lee `mem://hours.md`, y run3 escribe `mem://` con
    `lov-write`.
  - :51-56: `system:knowledge_directives` pasó de 12 962 a 27 797 tokens en un día, sin causa visible.
  - :47: `inputTokensByRolePart` desglosa cada llamada por parte del prompt.
- **Make** (`re-sistema/figma-make/huecos.md:16`, `inventario.md:175-177`): `usageInfo.contextUsageRatio` por turno, de
  0,055 a 0,341. La compresión (`chatCompression`) nunca se disparó en 7 turnos. El cliente la recibe y la descarta, sin
  pintarla (`make-chat/deob/3277:40269`).
- **v0** (`re-sistema/v0/inventario.md:64,68`): el historial de tools va en disco como `.md` legible por el modelo, y el
  skill del DS va por referencia (LoadSkill por id), no en el contexto. `previewViewport` viaja con cada mensaje.
- **Nosotros**:
  - `agent.trace.context {ratio, floorTokens, lastTokens, window}` (`agent-stream.ts:47-64`, solo traza).
  - `.wt/context/{conversation_history, tool_content/turno-anterior.md, task_output, preview_state}`
    (`follow-up-context.ts:42-76`, tope de 80 pasos × 4000 caracteres).
  - `runtime-context.ts` (H10).
  - `GET/PUT /brands/:id/instructions` (`server.ts:347-358`, ruta en `http-router.ts:78`, `brand-store.ts:85-104`).
  - `factsDisclosed` (`content-sensors.ts:183`), que solo corre en bench.
  - `instructions.json` (`shared.ts:371`, `run-cycle.ts:483-488`).

## 1. Memoria por marca (H8)

- **Archivo**: `<root>/brand-memory/<id>.md`, donde `<root>` es la raíz del transport (`opts.root`), **no**
  `brandsRoot`. `brandsRoot` apunta a los packs locales: en el perfil de la distro es la carpeta padre del repo (`config.ts:68`),
  y escribir ahí deja archivos fuera del almacenamiento del transport (hallazgo de #549, corregido 2026-11-04). Vive
  al lado de `brand-instructions/<id>.json`, en `BrandStore`. Las escrituras de `remember` y del PUT se serializan
  por marca (`withMemory(id, fn)`), porque variantes y chats paralelos de la misma marca leen y escriben el mismo
  archivo. Una línea por hecho:
  `- <hecho> · <messageId> · <AAAA-MM-DD>`.
- **Escribe el agente**: tool MCP `mcp__wt__remember {fact: string ≤ 200, replaces?: string}`. Solo existe en
  corridas con marca. Guarda lo que la persona dijo o confirmó sobre la marca (horario, tono pedido, "no usar
  testimonios"). Nunca guarda lo inventado, datos personales ni secretos; eso lo dice el prompt y lo valida el MCP
  (rechaza correos, teléfonos y tokens). Con `replaces` sustituye una línea, sin duplicados exactos. Tope: 40 líneas
  o 4 KiB. Si está lleno, la tool falla con "memoria llena: usa `replaces`". Cada escritura emite `memory.write {fact,
  replaced?}` en el log del mensaje.
- **Lee el agente**: inyectada, no por tools, igual que el build de Lovable. `agentSystemPrompt` añade el bloque
  `MEMORIA DE LA MARCA` después de las reglas de marca (`agent-prompt.ts:151`). Va marcado como contexto, no como regla:
  si choca con una regla, manda la regla. Así el coste es fijo y medible en `floorTokens`, sin un Read por turno.
- **La persona**: `GET/PUT /brands/:id/memory` (`{text}`, mismos topes; el PUT reemplaza el archivo). El panel de marca
  la muestra bajo "Instrucciones", con borrar por línea. La diferencia entre las dos piezas: las instrucciones las
  escribe la persona y obligan; la memoria la escribe el agente, la persona la corrige y solo informa.

## 2. Plegado del hilo y ratio pintado (H18)

- **Lo que ve el agente** no cambia: los ancestros entran como pedido + resumen y solo el turno anterior entra con sus
  pasos (`follow-up-context.ts:62-66`). Pasados `THREAD_KEEP` (4) turnos, los viejos se reducen a
  `conversation_history/summary.md` (infer barato, respaldo sin modelo: lista de pedidos) y solo los últimos entran
  íntegros (`thread-fold.ts`; Make guarda `{summary, startIndex}`, contexto-compresion-pipeline.md:11). El ratio sale por
  mensaje en `GET /chats/:id` como `context {ratio, lastTokens, floorTokens, window}`.
- **Evento**: al cerrar cada turno con agente, `context.usage {ratio, lastTokens, floorTokens, window}`, emitido desde
  `agent.trace.context`. Make lo emite y lo descarta; nosotros lo pintamos.
- **Builder**:
  - Turnos plegados: cada turno que no es el último se pliega a pedido + resumen + chips (archivos, versión, datos de
    ejemplo). Los pasos se ven al desplegar. El turno vivo y el último quedan abiertos.
  - Medidor: "Contexto NN %" en el pie del último turno, desde el `context.usage` más reciente.
  - Aviso: con `ratio ≥ 0,6` se suma "Hilo largo: un chat nuevo de esta marca empieza con su memoria y sus reglas".
    Es solo texto, sin acción automática.
- **Desglose** (opcional, traza): `context.parts {system, skill, context, tools}` en tokens estimados, como
  `inputTokensByRolePart`. Va solo a la traza, para medir la memoria y las reglas.

## 3. Datos de ejemplo por corrida (C4)

- La fuente es el plan, no el sensor: `planInvented(parsePagePlanMd(page-plan.md))` (`page-plan-md.ts`), que ya alimenta
  el punto 3 del resumen (ADR 0012 RF4). Al cerrar el turno, el transport emite
  `facts.invented {items: [{slug, text}]}` con **todo** lo inventado de la página en esa versión, no solo lo que
  cambió el turno. El fold reemplaza: la persona ve qué de la página entera es de ejemplo, y cuando no queda nada
  (`items: []`) el chip desaparece. Decidido el 2026-11-04 con #548, que mejora lo que decía este spec.
- **Chip** "Datos de ejemplo (N)" en el resultado del turno. Al abrirlo se ve la lista por sección, con "Reemplazar"
  que precarga el composer con "Pon el dato real de <texto> en <sección>: ". Sin items no hay chip.
- **Sensor**: `factsDisclosed` pasa a la traza de cada corrida que mide el DOM (preview-check), como
  `agent.trace.disclosed: ContentDefect[]`. No bloquea. QA lo cuenta; el builder no lo pinta.

## 4. C6: instructions heredadas. Decisión: se quedan, ya están cableadas

La nota de `re-contexto/nosotros.md §1.5` ("no llegan al agente") está desactualizada. Desde #428 (40982a49) el flujo
es completo:
1. `run-cycle.ts:483` lee `instructionsAt(parent commit)`.
2. `:488` aplica `input.instructions ?? inherited`.
3. `:534` lo pasa al request.
4. `agent-composer.ts:252` lo lleva a `agentSystemPrompt`.
5. `agent-prompt.ts:163-166` lo pinta en el bloque de reglas.

Quitarlo rompería las reglas por chat del menú "+" y la hidratación del builder (`run-reads.ts:145`, `run-client.ts:221-223`).
Regresión cubierta por `tests/instructions-inherit.test.ts` (#545): si un follow-up va sin `instructions`, el prompt lleva
las del padre; si va con `[]`, no lleva ninguna. Falta corregir la nota §1.5.

## 5. Viewport de la persona en el browser tool (Q6)

Hoy el viewport llega como texto (`preview_state/viewport.md`, "Verifica a ese ancho"), pero el browser tool solo
acepta 1440 o 375 (`workspace-tools.ts:49, 246-247`): el agente no puede cumplir lo que se le pide.

**Decisión (2026-11-04): vale el código de orq, y el spec se ajusta a él.**
- `WorkspaceToolContext.viewport {width, height}` llega desde `input.viewport` en todo turno, no solo por `historyOf`.
- `parseBrowseInput(input, persona)` acepta tres valores: 1440, 375 o el ancho exacto de la persona. Si el input no
  trae `viewport`, mide al ancho de la persona. El alto de la persona va a `segmentsOf` y a `newPage`.
- No hace falta la palabra `persona`: omitir el viewport ya expresa la intención y no suma un literal mágico al
  esquema.
- El tope 320-2560 tampoco va aquí: `parseViewport` ya acota el ancho al entrar por `POST /runs` (`MAX_VIEWPORT_PX`).
  Duplicarlo en el tool sería una segunda regla que puede divergir de la primera.
- Pendiente menor: con un ancho fuera de la tabla, `MAX_SEGMENTS` y `VISION_SCALE` caen en su `??` por defecto. QA
  mide cuántos tokens de visión gasta un ancho de 1280 antes de decidir si hace falta el ancho estándar más cercano.

## 6. Reparto por archivo (estado real, 2026-11-05, main cfa81648)

Todo lo de M2 y de plan mode que este reparto asignaba está en main. Queda como registro de quién tocó qué y dónde vive
hoy; los PR son los que lo cerraron.

| # | tarea | archivos hoy | estado |
|---|---|---|---|
| 1 | Fold `context.usage`, `facts.invented`, `memory.write`; turnos plegados, medidor, chip Datos de ejemplo, editor de memoria | `apps/builder/.../agent-run/*`, `run-state.ts`, `run-client.ts`, panel de marca | HECHO (#539) |
| 2 | Reglas de la memoria (`validateMemoryEdit`, `addFact`, `piiIn`, `memoryFacts`; única fuente de la tool y del PUT) | `src/runtime/memory-edit.ts` | HECHO |
| 3 | Q6: viewport de la persona en el browser tool, en el preview-check y en la fase build del plan | `workspace-tools.ts`, `browser.ts`, `preview-check.ts`, `run-cycle.ts` | HECHO (#540 y siguientes; fase build del plan #616) |
| 4 | Tool `remember {fact, replaces?}`, solo con marca y fuera de la fase plan; emite `memory.write` | `memory-tool.ts`, `agent-mcp.ts` | HECHO (#549, #556) |
| 5 | `BrandStore.memory/writeMemory`, `GET/PUT /brands/:id/memory`, bloque MEMORIA DE LA MARCA en el prompt; escritura atómica y serializada por marca | `brand-store.ts`, `brand-runs.ts`, `agent-prompt.ts` | HECHO (#549, #556; atómica #572, #578) |
| 6 | `context.usage` al cerrar el turno, desde `agent.trace.context` | `run-close.ts` (`materialize`, `keepPlan`, `keepStopped` con pregunta), `run-checks.ts` (`emitContextUsage`) | HECHO en versión, asked y plan (#549, #556). En `stopped` y `failed` sin página del composer no se mide (ADR 0014, 6.7); el ratio por mensaje sale en `GET /chats/:id` (#602) |
| 7 | `facts.invented` entero por versión, desde `planInvented(page-plan.md)` | `run-close.ts` (`materialize`) | HECHO (#548); `facts.disclosed` por corrida y chip (#622) |
| 8 | Cableado del viewport: `input.viewport` → contexto del MCP y del preview-check | `run-cycle.ts`, `agent-mcp.ts` (`workspaceToolContext`), `preview-dist.ts` | HECHO |
| 9 | Tests de M2 | `tests/agent-context.test.ts` | en verde (12 pass) |
| 10 | Plan mode: decisión por `ws + callId`, decidir después de resume, `keepStopped` → `cancelled{stopped}`, aviso `usuario:` en el prompt de build | `agent-mcp.ts`, `plan-exit.ts`, `agent-prompt.ts` | HECHO (cobertura #574; códigos de 409 #580; `:chat` validado #596) |
| 11 | Plan mode: un plan no cuenta como versión hasta que su build commitea | `run-reads.ts` (`versions`), `run-close.ts` (`planOnly`, `inheritedCommit`) | HECHO (#545, #554) |
| 12 | Plan mode: `GET /chats/:chat/plans/:id` (borrador incluido) y Aprobar deshabilitado hasta el fin del turno | `run-client.ts`, `tool-approval.tsx`, `agent-mcp.ts` | HECHO (#573) |
| 13 | C6: test de regresión (heredadas vs `[]`) | `tests/instructions-inherit.test.ts` | HECHO (#545). Falta la nota `re-contexto/nosotros.md §1.5` (Arq) |

Después del reparto entraron, sobre la misma base: rechazar un plan con nota (#601), zona horaria por request (#598),
plegado del hilo con tope (H18, #602) y texto fijo (`pinned.lost`, #615).

Compresión del hilo: ya no está fuera de alcance, ver §2 (`thread-fold.ts`, #602). Siguen fuera de alcance: memoria por
chat o por persona, y sincronizar la memoria con Knowledge o el CMS.

## 7. Estado real (2026-11-05, main cfa81648)

**Hecho (en main):**
- Memoria de marca: `<root>/brand-memory/<id>.md`, GET/PUT con `validateMemoryEdit`, escrituras serializadas por marca
  (`withMemory`) e inyección en el bloque MEMORIA DE LA MARCA (#549, #556).
- Tool `remember`: solo con marca y fuera de la fase plan (#549, #556).
- `context.usage` en los cierres con agente: versión, asked y plan (#549, #556).
- `facts.invented` entero por versión (#548) y `facts.disclosed` por corrida (#622).
- Q6 completo: viewport de la persona en el browser tool, en el preview-check y en la fase build del plan (#540 y
  siguientes, #616).
- UI de M2: fold, medidor, chip de datos de ejemplo y editor de memoria (#539).
- Plan mode:
  - un plan no es versión hasta que su build commitea; `planOnly(e, parentCommit)` y recover con `inheritedCommit`
    (#545, #554);
  - GET del plan y botón Aprobar (#573);
  - un plan pendiente sigue decidible tras reiniciar, o se cancela si no hay sesión (#548, #552);
  - `done` = el último `message.start` tiene su `message.end` (#554);
  - el plan entra al índice antes de anunciarse (#555);
  - rechazar con nota abre un turno en plan (#601);
  - un settle viejo no cierra un plan que volvió a correr: token de corrida por `launch` (#570, #627).
- Hilo largo: plegado con tope y ratio por mensaje en `GET /chats/:id` (#602); texto dictado fijo con el sensor
  `pinned.lost` (#615); zona horaria por request (#598).
- ADR 0014: partición en colaboradores (pasos 1-11, regla 3 por `updateEntry`) y Enmienda 1, opción A, decidida por
  Karen (#595): `run-checks.ts` y `run-close.ts` (#612), `run-cycle.ts` (#620), token de corrida (#627). Cifras hoy:
  `transport.ts` 593, `run-cycle.ts` 721, `run-close.ts` 336, `run-checks.ts` 161.

**En curso:**
- ec: `run-close.ts`, la recuperación (`recover`) cuando el proceso murió entre el índice y el `message.end`, y el
  enganche de `pinnedLost` y de `facts.disclosed` en la verificación.

**Pendiente de decisión:**
- El ADR 0014 sigue `PROPUESTO` en `docs/adr/README.md`; pasarlo a `APROBADO` es de Karen.
- Un mensaje sin versión da 409.
