# Cierre del módulo: lo que queda sin Karen (2026-11-04)

Arq, sobre main 22f13e60. Fuente: `re-iteracion/onbrand-mapa-replicacion.html` (59 filas en part o todo) y el volcado de QA.
Antes de repartir, cada fila se comprobó en main: el mapa está atrasado (su columna dice "hoy (dc5de86d)"), y varias
filas ya están cerradas (QA las cerró en el mapa y corrigió las líneas, 2026-11-04). Esas van en §1 para que QA las cierre en el mapa, no para trabajarlas.

## 1. Ya en main: QA las cierra en el mapa (sin código)

| fila del mapa | evidencia en main |
|---|---|
| edge.csp / H4 "CSP en preview-serve.ts" | `preview-serve.ts:249,262,295` manda `content-security-policy`; enforce del builder en `vercel.json:17` (#651) |
| H14 Rail: Marco y Favorito | herramienta `mark` en el rail (`canvas-chrome.tsx:128,136`), `Favorites` (`:9,118`) |
| C3 / §3 pin del DS + "Actualizar DS" | `run-reads.ts:169-172` (pin vs latest), `VersionsMenu onUpdateDs` (`App.tsx:110`), `updateDs` en `chat-panel.tsx:196` |
| C6 instrucciones heredadas ("[] borra") | `run-reads.ts:165-168`: el builder hidrata las reglas de la versión HEAD |
| C4 / §3 facts.disclosed por corrida | evento `facts.invented` (`event-model.ts:84`), `realDataSuggestion` por turno (`agent-composer.ts:336,343`) |
| C7 / ec #3 data-alt y slots con tool | `slotsOn` y `data-alt` ya no aparecen en `src/` (grep 0) |
| auth.proyecto-scope, H3 fases 1-4, transport.ts 3484 líneas | identidad fases 0-4 + marcas (#706); transport.ts partido en `src/runtime/*` |
| variantes-ui "fotos sin cache-bust" | `artboard-canvas.tsx:375-376` (UI, verificado por QA) |
| Arnés "tarjeta V1 fondo gris" | `builder.module.css:279-284`; captura `arnes/rb-qa2/v1-38d35ade.png` |
| H6 rechazo con feedback | `run-client.ts:298,404`; `run-state.ts:161,179`; `agent-run-types.ts:78,88` |
| Cursor y contorno en wt-reveal-bridge | `wt-reveal-bridge.ts:288-289,456`; `:14-33,159-202,242-268,508-516`; `:119`; `:294-295,318-320,387,433`; `:227` |
| ds-skill en follow-up | lo cubre C3 (arriba) |
| H8 zona horaria por request | `run-client.ts:129-142` |
| D6 (dec) | ADR 0016 |
| A1 montar en orden (dec) | el mapa ya lo da por cerrado por evidencia |

## 2. Trabajo sin Karen, en orden

Todas las filas tienen extract o son bugs propios con reproducción. Primero QA reproduce; las que no se reproducen se cierran.

| # | fila | qué falta exactamente | extract | dueño | tamaño | refactor C antes |
|---|---|---|---|---|---|---|
| 1 | §2 Effort no viaja en Continuar tras kill -9 **(SE REPRODUCE: test.failing #737; el arreglo va en la rama de la fila 4 de ec)** | QA reproduce (kill -9 a mitad de turno con effort ≠ default, después Continuar). Si se reproduce: el resume lee el effort del MessageEntry y no el default | bug propio, `arnes/robustez.md` Caso 1 | QA → ec | S | `run-cycle.ts` 700: no sumar; el arreglo va en el módulo de resume |
| 2 | ~~§2 Variantes en cola al caer el transport~~ **NO SE REPRODUCE, cerrada** (`transport-lifecycle.test.ts:198-240` + corrida del grupo completo) | QA: kill -9 a mitad de un grupo de 3; verificar que la cola se reanuda y que ninguna variante queda huérfana | `re-ejecucion/lovable-stitch.md` §4 (cola server) | QA → ec si falla | S | — |
| 3 | ~~§3 O3 plan vivo / textos dictados~~ **NO SE REPRODUCE, cerrada** (tc en vivo sobre un clon de c6f85e4d: el titular dictado queda literal, `agent:pinned` dice "Texto fijo intacto (2)") | QA repite el caso tc sobre main. Si pisa un `usuario:`, el arreglo va por `preserve.pinned` (#370) | Stitch page-plan por pantalla (`I18nStore:16436-16459`); `verificacion.md` §3b | QA → orq | S (QA), M si falla | — |
| 4 | §18 Fallback sin imagen (cupo o Gateway sin credencial) | si el paso de imagen falla, el agente no referencia una ruta que no existe: el slot queda marcado y `src` no se escribe roto | bug propio, `arnes/526043c3` A7 | ec | S | — |
| 5 | §8 Q3 pulsar controles nuevos del turno | regla en el prompt de verificación: el agente pulsa con el browser lo que agregó en el turno y reporta el error | Lovable, `verificacion.md` §4b | orq | S | `agent-prompt.ts` 321: sin acción |
| 6 | §3 Viewport del usuario como viewport de verificación **(hecho, #739; #742 trajo además `previewCheckWidths` en render-review, sin anchos repetidos, y el HACK de NEW_CONTROLS_RULE con su disparador)** | el viewport ya viaja en plan (`agent-mcp.ts:51-64`). Falta que el browser tool de verificación lo use en cada turno, no el fijo 1440/375 | v0 `previewViewport` (`RI/v0.md:166-172`); Lovable `current_viewport` | orq | M | `run-cycle.ts`: no sumar |
| 7 | B H18 medidor de contexto en el panel | `contextUsageOf` existe (`run-state.ts:359`) y ningún componente lo pinta. Mostrar el ratio en agent-panel. La compresión del hilo con un modelo barato es gasto y queda fuera (§3) | Make `contextUsageRatio` (`datos/contexto-compresion-pipeline.md`) | UI | S | `agent-panel.tsx` 336: sin acción |
| 8 | §3 Tool-history legible | hoy solo el turno anterior (`agent-prompt.ts:304`). Exponer el stream completo como `tool_content/` paginado, con el mismo tope de chars por archivo | v0 `tool_content/tool-history/*.md` (RS:13-16; `deob/v0-design-mode/deobfuscated.js:26708`) | orq | M | — |
| 9 | §8 preserve.text / files / visual / pinned **(consenso 6/6, 2026-11-04: files, text y pinned se quedan, con respaldo en el diff contra el padre de Make Review y de v0 git_diff_stats; visual quedó revertido en #761 porque no tiene extract, encontró 0 defectos reales y su control positivo no disparó; se quitan las capturas por sección porque solo las leía la comparación)** | QA fundamenta cada sensor con un caso real o lo revierte (regla de la síntesis: sin respaldo, revert). Versiones sin preview-check: comparar contra el último ancestro con capturas | `qa.md` §5 (RULESET), Make Review = preserve.files parcial | QA → Secondary | M | — |
| 10 | ~~B H16 aprobación por alcance del argumento~~ | fuera por consenso 2026-11-04: hoy no hay conector de escritura (`connector-mcp.ts` es de solo lectura, `readOnlyHint`, :4, :23-24). Queda cerrado con el disparador de Karen: "se reabre cuando un conector escriba" | — | — | — | — |
| 11 | B H12 snapshot del DOM por versión | serializar el DOM desde el browser que ya abre el render-gate o el preview-check y guardarlo junto a la versión | v0 `snapshot-form` (`__v0_devtools`); el serializer de v0 no se puede extraer (2026-11-04) | orq | L | — |
| 12 | §17 De-brand del contenido demo **(hecho, #745: solo la empresa embebida, es decir "Sobre Atom", el copyright y "novedades". Por diseño quedan "Atom Pulse" como producto, `data-atom-button` (contrato wa-sdk) y los colores themed: es el pendiente mayor, y necesita su propio extract antes de tocarse)** | "Sobre Atom", © Atom en `fixtures/relume-themed/src/App.tsx` y `fixtures/briefs/pulse-*.copy.json`, más los tests que lo citan. Camino fundado: los defaults de `@relume_io/relume-tailwind` (`token-map.relume.ts`), nunca neutros inventados | `PENDIENTES.md`; `porter-residuo-inventario` | Secondary | M | — |
| 13 | §17 share-access, lightbox-gallery (uikit-provider → arc-provider) | portar con el estilo de #515 (breadcrumb), sin escribir el vault (escribir el vault es de Karen) | paridad Arc | Secondary | M | — |
| 13b | §17 `tools/porter/legacy-transform.ts` (0 importadores) | sigue en main y `tools/porter/deps-root.ts:77` lo cita (QA). Confirmar que ningún script lo llama por string; si nadie lo llama, borrar el archivo y la frase del comentario | `porter-residuo-inventario` (el único muerto con fundamento) | Secondary | S | — |
| 14 | §19 CHANGELOG/README y PENDIENTES.md **(hecho: #738 cubre #630-#734 y PENDIENTES; #492-#529 entran en este PR)** | CHANGELOG [Unreleased] con #492-#529 y lo de hoy; README "Repo layout" (`fixtures/`); PENDIENTES.md archivado (es pre-ADR 0011) | — (docs) | Arq | S | — |

Paralelo: 1-4 (QA) en cuanto haya QA libre; 5-8 orq y UI; 12, 13 y 13b Secondary; 14 Arq. 11 al final: es el único L.

**Regla vigente (consenso 2026-11-04, fila 9):** los sensores `preserve.*` miden el diff contra el padre y lo REPORTAN, pero no
disparan el auto-repair. Esto sigue al extract, que respalda medir y mostrar el cambio, no repararlo. El auto-repair solo cuenta
los defectos de runtime (`RUNTIME_KINDS`, #594). Un sensor de preservación que quiera reparar necesita su propio extract.

## 3. Fuera: dependen de Karen, del deploy o de un disparador que no se cumplió

- Gasto o proveedor: transcribe (STT), image-edit (créditos), compresión del hilo con un modelo, billing.
- Deploy o H11: runtime.sandbox, preview por origen en Sandbox, storage durable, dominio, CDN, H21, meta en staging, HMR y sugerencias en staging (§14).
- Decisiones de Karen sin delegar: ¿se retira el runner? (bloquea C5 y el porter), sensor tokens.local, 124 Pro al vault, ampliación de ADR 0006 (feature-bento), colector OTLP en deploy, publish hosted y fase 5. Lista con recomendación en `decisiones-pendientes-2026-11-04.md`.
- Sin disparador: H17 (tool_search, "solo urge con varios conectores"), sensor nav.anchors ("si aparece una regresión").
- Sin extract: agente.model-routing (ruteo por intención; el mapa no cita referente).
- Filas de índice de extracts (§C del mapa): son inventario, no trabajo.
- H9 "Figma y handoffs": atado a H1 (publicar a un destino), que es de Karen.
- H7d y H7e: sin extract.
- §19 "README no enlaza docs/research": `docs/research/` no existe en main. Lo que decidió el brief de publish está en `docs/notas/decisiones-publish-2026-11-04.md` y README "Status" ya lo refleja (#656). QA la cierra.

## 4. Estado al cierre

Conteo final del mapa (QA, 2026-11-04): ok 203, part 16, todo 10, dec 11, no 19. Quedan 26 filas abiertas, y ninguna
tiene código posible sin Karen.

- **(A) 18 de gasto, deploy o decisión. Dueña: Karen.** Orden y recomendación en `decisiones-pendientes-2026-11-04.md` §2.
  - transcribe;
  - image-edit;
  - runtime.sandbox;
  - preview por origen;
  - storage durable;
  - deploy.dominio;
  - edge.cdn;
  - H21;
  - billing.creditos;
  - H1 falsos HMR en Sandbox;
  - H2 429 en staging;
  - Meta en staging;
  - Identidad/CSP y Bearer de fase 5;
  - H9;
  - H16;
  - feature-bento (ADR 0006);
  - C5 archivar props/JSON.
- **(B) 3 sin disparador.** Se abren cuando su disparador se cumpla:
  - H17 `tool_search`: lo lleva Orq cuando haya varios conectores;
  - sensor `nav.anchors`: lo lleva QA cuando aparezca una regresión;
  - `agente.model-routing`: lo lleva Orq, y antes necesita un extract que lo respalde.
- **(C) 5 de inventario de extracts (§C del mapa), pasadas a "no" (inventario).** No tienen dueño, porque son índice y no trabajo:
  - `re-v0/`;
  - `re-lovable/ re-stitch/ ...`;
  - `research_notes/ reports/`;
  - `specs/ status/`;
  - `relume-extract/ relume-llm-infer/`.

Pendiente mayor fuera de las 26: **"Atom Pulse" como producto y los colores themed del fixture**. #745 los dejó a propósito
(fila 12 de §2). Antes de tocarlos hace falta un extract propio.

