# S4 Traza y edición del turno
Estado: APROBADA · Dueño: orqWebTransformer

## Objetivo
Registrar y mostrar por turno lo que muestra Make, con extract. Las filas son las de viabilidad/orq-make.md.

## Cambios
1. **Contexto por turno (O2-B / 14):** va en agent.trace.context; se registra, no se pinta.
   - Extract: make-chat deob :32541 (usageInfo), :40269 (el cliente lo descarta); v0-design-mode deob :56042 (workMetrics.linesRead).
   - contextWindow sale de result.modelUsage[*].contextWindow. Doc: https://code.claude.com/docs/en/agent-sdk/typescript, secciones SDKResultMessage y ModelUsage. cacheReadTokens sale de result.usage (por turno, solo el loop principal, según la misma doc). Con --resume, modelUsage acumula; contextWindow es constante y no le afecta.
2. **Diffstat por versión (2):** `transport.ts` versions() :1244-1250 y statsOf :1799-1810 devuelven stats para todas las versiones, no solo la head.
   - Extract: MAKE-CHAT:40021-40031.
   - Adaptación declarada: Make guarda diffSummary en el mensaje. Nosotros lo calculamos de forma determinista y cacheada por par base..commit, así que no se persiste en index.json.
3. **old/new del Edit (3):** el detail write de event-model.ts lleva `path`, `edits: { before: string; after: string }[]` (Edit, MultiEdit, replace_all) y `truncated`. Un Write de archivo entero lleva solo `after`. Tope de tamaño por par para no inflar el log ni page.json.
   - Extract: MAKE-CHAT:40042-40063, :40136-40141.
   - Adaptación declarada: Make lo pinta en vivo con deltas overwrite/append; nosotros, al cerrar el paso (step.end), sin partial messages.
4. **Bash como edición (6):** `mv` mueve lastWriteAt y entra en writes. Solo cuenta lo que el allowlist permite (agent-loop.ts:156: mv y mkdir).
   - Extract: FIGMA-APP:444176-444230 (treatBashAsEditing). Nuestro equivalente es el allowlist.
   - Ampliar el allowlist es de S5.
5. **Razonamiento como duración (7, CONDICIONAL):** entra solo si `thinking_duration_ms` está en la documentación del formato stream-json del CLI. Si no está, la duración sale del `at` del primer y del último delta con --include-partial-messages, citando la doc de esa opción. Sin cita no se implementa. Contrato: StepDetail `{ kind: 'thinking'; ms: number }`.
   Detalle: paso thinking con ms tomado de thinking_duration_ms, sin texto. El CLI emite thinking vacío con signature: lo observado en 56644d79 da 26 bloques.
   - Extract: V0:20725-20745; el string es `Thought ${v}` (V0:20739), que da "Thought Ns".
   - Reuso: apps/builder/src/lib/step-labels.ts:56.
   - Doc web del CLI stream-json: por citar.
6. **Contrato de fase para S3 16, 17 y 21:**
   - Campo `tool?: string` en step.start (Read, Write, Edit, Glob, Grep, Bash, typecheck, browser, ask_user, generate_image, edit_image), en event-model.ts:46. Extract: v0 textActive/textComplete por parte, V0:13738-13750 (fila 17). La fila 16 no lo usa: el builder ya sabe el tipo de pedido al lanzarlo.
   - El `label` de step.start incluye el path del archivo (para "Editando X…" mientras corre). Extract: V0:27594-27596, :901-917.
   - Lista documentada de stepIds de fase (b47a2f8). Son top-level, sin parentStepId; los pasos del agente cuelgan de agent:write (transport.ts:611).
     - transport: facts :901, connectors :929, brand :947, restore :995/:1066/:1299, registry-open :1318, parallel :1359, images :1409, registry :1414, install :1526, ds :1535, preview-live :1557, skill :1568, build :1605, commit :1610, preview :1618, repair :1635, render :1704, preview-check :1722.
     - dinámico: `transport:${edit.name}` :1175 (p. ej. transport:section-op).
     - agent: direction (agent-composer:213), trace :267, write :269, diff-check :300, images :308, summary (agent-stream:274), suggestions (suggest.ts:11).
     - dinámico: note-N (agent-stream:210).
   - El orden es fijo por flujo (T1, follow-up, patch, restore), medido en 56644d79 en orq-make §B. S3 arma una tabla por flujo; las fases que se saltan quedan "done" por índice, como LEDB:388-409.
   - Los ids son exactos, sin sufijo por archivo ni por sección. S4 lo confirma en el código al implementar.
   - S3 arma la tabla estática con estimateMs, como LEDB:321-349 y :388-409. S4 no emite ETAs.
7. **Para S5:**
   - ApprovalRequest.kind suma `'spend'` (event-model.ts:38-42, approvals.ts:43), con nota de créditos. Extract: MediaGenerationApprovalCard :186-196, registry :4855. Los eventos approval.request y approval.decision ya existen (:54-55).
   - Un case en stepOf (agent-stream.ts:66-82) para mcp__wt__generate_image y mcp__wt__edit_image ("Generando imagen" / "Editando imagen").
   - Sin evento ni StepDetail nuevo para las tools de imagen: el default de detailOf las cubre (agent-stream.ts:98).

## Archivos
- src/v0/agent-stream.ts
- src/v0/agent-composer.ts: AgentTrace.context.
- src/v0/event-model.ts
- apps/builder/src/lib/run-state.ts y run-client.ts: solo lib, tipos y mapeo io, sin componentes. S4 los commitea primero; S3 los consume sin editarlos.
- src/v0/transport.ts: versions y statsOf, en el turno que fija Orq. Va primero S4 y después S5.

## Fuera de alcance
- 13: título de versión por el agente.
- 9: cola de mensajes.

## Terminado
- Tests del área.
- Los 5 turnos de 56644d79 coinciden con ctx-per-turn.py.
- GET /runs/:id/versions trae stats en todas las versiones.
- page.json agent.trace.context existe en un follow-up del arnés, con ratio < 0,05.
- Arnés A6.
