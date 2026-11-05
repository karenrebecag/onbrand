# Ledger de HACK (B5), QA 2026-11-04 sobre main 1431c53f; re-anclado por Arq sobre ee3b8ed7 (barrido de orq sobre 17cc0fe5)

Alcance pedido: `grep -rnE '(#|//) ?HACK:' src apps/builder/src scripts`, 30 marcas. Los 30 nombran su disparador:
ninguno es deuda muda. La guarda `tests/estandares-hack-ledger.test.ts` mide lo mismo sobre un alcance mayor (con
`tools` y `tests`) y está en verde. "Vigente" quiere decir que el disparador todavía no se cumple. Solo el 18 está cumplido
(Arq, plan-mode.md:53-59).

| # | archivo:línea | atajo y tope | disparador | estado |
|---|---|---|---|---|
| 1 | src/color-contrast.ts:20 | fuera de gamut se recorta por canal | un oklch fuera de sRGB cuyo contraste difiera del navegador | vigente |
| 2 | src/runtime/publish.ts:79 | tope de 2 MiB para escanear texto | un dist real con JS > 2 MiB, o antes del primer publish hosted a dominio público | vigente; atado a publish hosted |
| 3 | src/runtime/direct-edit.ts:159 | aceptar con errores previos pasa por nuevo, viejo, nuevo | QA ve ese parpadeo en una página real | vigente: no se vio en la QA en vivo de hoy (página sin errores previos) |
| 4 | src/runtime/plan-edit.ts:71 | diff O(n·m), tope 64 KiB | sube el tope | vigente |
| 5 | src/runtime/infer.ts:16 | techo fijo para `claude -p` | un llamador mide turnos más largos | vigente |
| 6 | src/runtime/brand-runs.ts:115 | quedan archivos del pin viejo | un DS retira componentes que un chat importa | vigente |
| 8 | src/runtime/memory-edit.ts:34 | heurística de teléfono por dígitos | una marca registra cifras con puntos o se rechaza un hecho legítimo | vigente |
| 9 | src/runtime/shared.ts:421 | techo fijo de install y build | el banco mide installs o builds que lo rocen | vigente |
| 10 | src/runtime/canvas-store.ts:24 | tope fijo, sin GC de huérfanos | hay un GC por chat que no compite con subidas | vigente |
| 11 | src/runtime/preview-dist.ts:235 | tope de versiones con dist por mtime | el banco mide dists grandes | vigente |
| 12 | src/runtime/preview-dist.ts:237 | puede borrar el dest de otro export | se exportan varias versiones a la vez | vigente: hoy solo la HEAD es exportable |
| 13 | src/runtime/api-handlers.ts:72 | el corte del cliente no aborta el stream en Bun 1.3.14 | el gasto del enhancer cuenta o Bun expone el cierre | vigente |
| 14 | src/runtime/api-handlers.ts:155 | un upload no tiene dueño, el id es la capability | créditos o chats compartidos | vigente |
| 15 | src/runtime/run-cycle.ts:202 | un auto-repair por versión | la tasa de arreglos rojos tras el primero lo pide | vigente |
| 16 | src/runtime/preview-token.ts:19 | el token de preview no se revoca | créditos o chats compartidos | vigente |
| 17 | src/runtime/text-edit.ts:42 | un atributo de texto se guarda sin tsc | un bloque tipa title o label como unión de literales | vigente |
| 19 | src/page-sensors.ts:230 | alineación inferida de las formas | el catálogo declara la alineación | vigente |
| 20 | src/page-sensors.ts:449 | items = clave de objeto repetida | el catálogo declara la prop de items | vigente |
| 21 | src/page-sensors.ts:474 | solo grid o flex-wrap | una sección vertical sale con un conteo distinto | vigente |
| 22 | src/page-sensors.ts:527 | forma = fila más ancha | una forma de dos columnas se desvía sin grilla | vigente |
| 23 | src/config.ts:69 | la distro compone por la sesión local | Karen pasa el default a gateway | vigente; decisión de Karen |
| 24 | src/wa-sdk.ts:18 | pin a mano del SDK | existe el deploy de páginas (publish hosted) | vigente; atado a publish hosted |
| 26 | apps/builder/src/lib/step-labels.ts:1 | tabla de labels inglés → español | los dueños emiten los labels en español | vigente |
| 27 | apps/builder/src/lib/provenance.ts:70 | singular por sufijo inglés | aparecen props irregulares | vigente |
| 28 | scripts/tailwind-to-modules.ts:16 | Tailwind del fixture relume-themed | el fixture desaparece | vigente |
| 29 | scripts/page-sensors.browser.js:104 | width por clase = auto | aparece un bloque de tarjetas en flex-wrap | vigente |
| 30 | scripts/page-sensors.browser.js:271 | mockup = chat de 3 burbujas | un generador usa otra forma como visual principal | vigente |
| 31 | src/runtime/tool-history.ts:12 | el historial más viejo que MAX_PAGES (600 pasos) se descarta | un chat real pasa de 600 pasos y el agente pide lo omitido | vigente |
| 32 | src/runtime/verify-prompt.ts:5 | el agente pulsa en el turno lo que el preview-check ya pulsa al guardar | QA mide turnos más largos sin errores nuevos; entonces se recorta a controles con código nuevo | vigente |
| 33 | src/orchestrator/chat-index.ts:217 | tope no atómico: lee y reserva en dos pasos | el exceso medido supera el 10 % del tope | vigente; sin cablear |
| 34 | src/orchestrator/spend-queue.ts:28 | cola de gasto en memoria de la instancia | se miden pérdidas reales de addSpend | vigente; sin cablear |
| 35 | src/orchestrator/gateway-proxy.ts:17 | `run` se verifica y no se usa: tope solo por dueño, sin ventana | Karen fija tope por corrida o ventana | vigente; decisión de Karen |
| 36 | src/orchestrator/gateway-proxy.ts:172 | la reserva no cubre server tools, cache_creation ni contexto 1M | el ajuste real supera la reserva de forma medida | vigente; sin cablear |
| 37 | tests/workspace-tools-signal.test.ts:20 | cuarentena: flaky de reloj (poll de SIGTERM) | clock o espera determinista del hijo | cuarentena |
| 38 | tests/preview-robustez.test.ts:55 | cuarentena: flaky de reloj (setTimeout + desalojo) | timers falsos | cuarentena |
| 39 | tests/form-distance.test.ts:32 | cuarentena: flaky de carga (navegador del probe > 30 s) | el probe baja de 30 s en la suite completa | cuarentena |
| 40 | src/dom-snapshot.ts:39 | el DOM por versión se escribe y nadie lo lee | sin lector al 2026-12-02: se quita saveDom, su llamada y el archivo | vigente |

Total: 37 marcas vivas, todas con disparador: 27 del barrido original (salen #18 y #25 en #756, y #7 en #759), 6 nuevas, 3 cuarentenas y `src/dom-snapshot.ts:39` (#753, en línea propia desde #761).

## Cerradas hoy

| # | marca | cierre |
|---|---|---|
| 18 | agent-mcp.ts:409, 409/429 como approve | #756: el marcador se va; queda el porqué citando plan-mode.md "Rechazar con feedback", paso 2 |
| 25 | brand-sensors.ts:34, wordmark por proporción ≥ 2,5 | #756: el sensor lee `logoKind` del pack. Seguimiento abierto: sin el campo, el contrato dice `mark` (brand-pack.ts:74) y el sensor infiere por proporción |
| 7 | run-checks.ts:91, el dev server no se reinicia tras reinstall | se reprodujo (#758) y lo cerró #759: `wt-deps-restart-plugin.ts` en el config del runtime (llega a chats viejos, A11) reinicia el vite vivo cuando cambia `node_modules/.wt-installed`; #758 pasa a test |

Fuera del alcance pedido y también con disparador: `tools/porter/deps-root.ts:7`
y las dos cuarentenas de `tests/` (`preview-robustez.test.ts`, `workspace-tools-signal.test.ts`), más la de
`form-distance.test.ts` (#703).
