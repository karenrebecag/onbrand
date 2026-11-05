# ADR 0014: Transport conserva el ciclo de corrida y delega en colaboradores con deps explícitas

Estado: DECIDIDA [KAREN:chat 2026-11-04 "el resto, ocupate"; hecha en main #612-#636] | Fecha: 2026-11-04 | Dueña: orq (partición), Arq (revisión mecánica)

## Contexto

`src/v0/transport.ts` tiene 3227 líneas en main 77909a73; tenía 3484 en dc5de86d. En un solo archivo conviven la API
HTTP, el ciclo de corrida, el MCP del agente, las aprobaciones, el preview, el dist, las marcas, las variantes, las
ediciones y las lecturas del hilo. La regla del repo es de 800 líneas como máximo. La auditoría F3
(`re-sistema/onbrand/f3-audit.tsv:48`, `TRANSVERSAL:mantenibilidad-transport`) lo marca como riesgo de
correctness y de robustez: un cambio en cualquier capa toca el mismo archivo. Los referentes separan servicios:
v0 con `api.*` frente a `runtime.*`, y Lovable con `api.go-api`. Ya hay tres colaboradores con el patrón:
`api-handlers.ts` (`ApiHandlerDeps`), `brand-store.ts` (`BrandStoreDeps`) y `direct-edit.ts`.

## Decisión

`Transport` conserva el **ciclo de corrida**: `start`, `run`, `materialize`, `launch`, `release`, `settle` y
`recover`, junto con el estado que lo coordina (`index`, `running`, `live`, `cancels`). Todo lo demás pasa a
colaboradores. Cada uno es una clase o un conjunto de funciones que recibe un `XDeps` explícito en el constructor,
con callbacks y datos y nunca `this`. Lo que vive en cada módulo es indicativo; cada dueño lo confirma al mover:

| módulo | dueño | qué vive |
|---|---|---|
| `agent-mcp.ts` | Secondary | `openApprovals` y `approvalRuns`, `POST /approval-requests`, `/connector-mcp/:slug`, el `/mcp/:id` del workspace (`tools/call`, gasto, `exit_plan_mode`), la decisión de aprobación y el pendiente de plan |
| `brand-runs.ts` | orq | resolución de la marca de la corrida (pack, hechos, styleSet, hash, instrucciones), direcciones recordadas y `brandList` |
| `variants.ts` | orq | grupos de variantes: cola, lanzamiento, cancelación y `variantRun` |
| `edit-runs.ts` | ec | patch-ai (`elements`), restore, ediciones directas, repair y AutoFix |
| `run-reads.ts` | QA | `thread`, `versions`, `statsOf`, `agentAt`, `instructionsAt`, `requestField` y las lecturas `GET` de una corrida |
| `preview-dist.ts` | orq-lead | url estable, proxy de previews, latido, `distFor` y el caché `distRootCache`, build del dist |
| `http-router.ts` (paso 10) | QA | `handle()` (tabla de rutas: `parts[...]`, método, `decodeURIComponent`, el chequeo de origen y `guardWrite`, que solo llaman a deps) y `listen()`. NO viven aquí los parsers del cuerpo que leen estado de Transport (`start`, `parsePlanMode`, `steerLive`), que entran por deps como handlers. Las funciones puras de `POST /runs` (`parseBrand`, `parseThinking`, `parseTools`, `parseConnectors`, `parseSelectedSections`, `parsePermissionMode`, … ~150 líneas a nivel de módulo) van a `run-input.ts`, sin estado, como hoja |

**Reglas de la partición:**
1. El movimiento es mecánico: el cuerpo de cada método queda igual, salvo `this.x` → `deps.x` o `this.campo` →
   `this.campo` del colaborador. Los arreglos van en otro PR.
2. Ningún colaborador importa `transport.ts`. Los tipos compartidos (`MessageEntry`, `RunInput`, `LiveTurn`…) salen a
   un módulo de tipos sin lógica que todos importan. `Transport` importa a sus colaboradores; ellos no importan
   `Transport` ni se importan entre sí, salvo `http.ts` y los tipos. Excepción explícita: un **colaborador hoja**, sin
   estado del transport y dueño de su lógica, puede importarlo el colaborador que la usa (`direct-edit.ts` desde
   `edit-runs.ts`). Una hoja no importa a ningún colaborador ni a `transport.ts`. Segunda excepción: `http-router.ts`
   compone las rutas y puede importar los **tipos** de los colaboradores (`import type`), nunca valores.
   Tal como quedó tras la Enmienda 1 (2026-11-04):
   - Cualquier colaborador puede importar **tipos** de otro (`import type`). No crean dependencia en runtime, y
     `run-cycle` los usa para tipar sus callbacks (`Parameters<RunClose['end']>`).
   - `run-checks.ts` es hoja: comprobaciones sin estado propio, que leen el índice por `deps.index()`. Lo importan
     `run-close` y `run-cycle`.
     - `INSTALLED_MARK` vive en `transport-shared.ts` (#632), y `preview-dist.ts` lo re-exporta, así que run-checks
       no importa a ningún colaborador.
   - `run-input.ts` también es hoja.
   - Ningún valor viaja entre `run-cycle` y `run-close`: el cierre llega por callback con enlace tardío (6.9).
3. Los colaboradores no mutan el índice: `deps.index()` lo lee y `deps.updateEntry(id, patch)` lo escribe, y el
   guardado en disco queda en `Transport`. Así la persistencia tiene un solo dueño.
4. Cada archivo resultante tiene ≤ 800 líneas, `transport.ts` incluido.
5. `updateEntry` reemplaza el objeto de la entrada (`index[id] = {...old, ...patch}`), no lo muta. Después de llamarlo,
   se relee `deps.index()[id]` (o `this.index[id]`); nunca se reusa una referencia `entry` tomada antes. Una mutación
   o lectura sobre la referencia vieja se pierde en silencio o da datos viejos. Hoy no hay ningún caso (revisado en
   `keepStopped` con #555), pero es la trampa más probable al mover el ciclo (Enmienda 1).

## Alternativas

- **Dejarlo como está.** Cada módulo nuevo (M1, M2) agranda el mismo archivo y vuelve a chocar entre sesiones.
  Descartada por la auditoría y por la regla de 800 líneas.
- **Servicios separados (procesos), como v0 o Lovable.** Es el destino de ADR 0013 (la corrida durable), pero hoy
  obligaría a meter IPC y cambiaría el despliegue. Descartada por ahora: los colaboradores in-process son el paso
  previo, y sus `deps` son la frontera que un servicio respetaría después.
- **Mixins o herencia de `Transport`.** El estado seguiría compartido de forma implícita y cada clase volvería a
  depender de todas. Descartada.

## Consecuencias

- **Dónde se cablea M2** (`docs/spec/contexto-agente.md`):
  - Memoria por marca: `brand-store.ts` (archivo, topes) y `brand-runs.ts` (inyección en la marca de la corrida).
    La tool `remember` va en `agent-mcp.ts` y su validación en `memory-tool.ts`.
  - `facts.invented` y `context.usage`: `materialize` en `transport.ts`, al cerrar el turno, porque ahí ya están
    `page.agent` y el plan.
  - Viewport `persona`: `agent-mcp.ts` lo pasa al contexto del MCP `wt` en todo turno, y `preview-dist.ts` lo usa
    para el alto y el tema del browser tool.
  - Lecturas (`thread` con memoria, `context.usage` en el fold): `run-reads.ts`.
- **Revisión**: Arq revisa cada módulo en el worktree de su dueño con dos pruebas. La primera, diff de cuerpos = 0
  salvo `this`→`deps`. La segunda, `grep "from './transport'"` vacío en los colaboradores, sin ciclos. QA corre los
  tests del transport sin cambios: un test que haya que tocar señala un movimiento que no fue mecánico.
- Los tests existentes de `Transport` siguen pasando por la API pública. Los colaboradores ganan tests propios con
  `deps` falsas solo cuando cambie su lógica.

## Medida tras el paso 9 (0b893c6b, 1611 líneas)

Paso 10 (router + `run-input.ts`) saca ~250 líneas: `handle` 72, `listen` 29 y parsers puros ~150. `transport.ts` queda
en ~1360 líneas, todavía por encima de 800. Lo que falta para llegar es el ciclo mismo: `run` 194, `materialize` 102,
`start` 75, `keepStopped`/`keepPlan`/`settle`/`recover` ~130. También quedan los `start*` que siguen en Transport
aunque su corrida ya se movió (`startVariants` 33, `startUpdateDs` 32, `startApplyBrand` 26 → a `variants.ts` y
`brand-runs.ts`, ~90 líneas, mecánico).

Si después del paso 11 (`start*` a sus colaboradores, ~1270 líneas) sigue por encima de 800, la única salida es sacar
`run`/`materialize` a `run-cycle.ts`. Eso contradice la Decisión de este ADR (el ciclo vive en Transport) y requiere
enmendarla: el ciclo pasaría a vivir en `run-cycle.ts`, y Transport quedaría como composición más estado (`index`,
`running`, `live`, `cancels`). La enmienda la aprueba Karen.


## Enmienda 1: el ciclo de corrida sale de Transport

Estado: HECHA (2026-11-04), opción A [KAREN:chat 2026-11-04 "vamos con a"] | Fecha: 2026-11-04 | Autora: Arq | Medida sobre main fa83d9fe
PRs: #612 (PR 1), #620 (PR 2), #627 (runId, condición 5), #632 (recover, cierre), #624 (tests 6.6/6.8), #626 (regla 2).

Reparto tras la decisión: PR 1 (run-checks + run-close) Secondary, PR 2 (run-cycle) orq, PR de runId orq, revisión mecánica Arq.
Mientras PR 1 y PR 2 estén abiertos aplica la condición 3: nadie toca run/materialize/settle/start/keep*.

### Medida

| punto | `transport.ts` |
|---|---|
| antes de partir (dc5de86d) | 3484 |
| tras el paso 9 (#538) | 1611 |
| tras los pasos 10-11 y M2 (main fa83d9fe) | 1414 |

Lo que queda es el ciclo de corrida (~722 líneas de métodos) y la composición. Ningún paso mecánico más baja de 800
sin tocar el ciclo.

### Opción A: enmendar la Decisión (recomendada)

La Decisión pasa de "Transport conserva el ciclo" a "Transport conserva el **estado** del ciclo (`index`, `running`,
`live`, `cancels`, `finished`, `late`, `lateChecks`, `stopReasons`) y su persistencia (`save`, `updateEntry`); el ciclo
es un colaborador más". Las reglas 1-5 siguen igual.

| archivo | qué vive | tamaño |
|---|---|---|
| `run-checks.ts` (hoja) | `checkPreview`, `checkRender`, `installDeps`; helpers puros `mergeResumed`, `requestRecord`, `withFallback` | ~75 |
| `run-close.ts` | `materialize`, `keepStopped`, `keepPlan`, `end`, `recover`, `inheritedCommit`, `emitContextUsage`, `startLate` | ~300 |
| `run-cycle.ts` | `start`, `parsePlanMode`, `steerLive`, `cancel`, `launch`, `claim`, `release`, `supersede`, `background`, `settle`, `autoRepairAfter`, `resumePlanBuild`, `assertCanBuildPlan`, `run`, `agentWorkspace`, `agentSkill`, `historyOf`; `briefKey` | ~540 |
| `transport.ts` | estado, persistencia, constructor y cableado, lecturas (`agentAt`, `pinOf`, `brandOf`, `requestField`, `allowAt`, `withRegistry`, `connectApps`), parsers de modelo, adjuntos e imagen, `putPlan`, `handleBrand*`, `sectionSuggestions`, `shutdown`, `handle`/`listen` | ~690 |

Deps: el estado se pasa por referencia (Maps y Sets que nunca se reasignan) y lo reasignable por getter (`closing()`,
`directions()`, `maxRunning()`). `run-cycle` recibe `materialize`, `keepPlan`, `keepStopped`, `end` y `startLate` como
callbacks; ni `run-cycle` ni `run-close` se importan entre sí.

**No es mecánico puro:** hay 15 escrituras directas al índice (12 en el cierre y 3 en el ciclo) que pasan a
`updateEntry`, con la regla 5 (releer después de cada una). El PR trae una tabla "línea original → updateEntry" y Arq
la revisa escritura por escritura.

**Orden y condiciones:**
1. Antes, mergear lo que toca estos métodos: la carrera `settle`/`finished` (orq), sin auto-repair en el build de un
   plan (ec) y `RUNTIME_KINDS` única (Secondary).
2. PR 1: `run-checks.ts` + `run-close.ts` (dueño Secondary). PR 2: `run-cycle.ts` (dueño orq), sobre el PR 1 ya
   mergeado. Arq revisa los dos.
3. Mientras estén abiertos, nadie toca `run`, `materialize`, `settle`, `start` ni `keep*`.
4. Este movimiento no parte `run` (194 líneas) ni `materialize` (107). Llevarlos por debajo de 50 líneas es otro PR,
   no mecánico.
5. **HECHA (PR de runId).** Después del PR 2, en un PR corto y no mecánico: un **token de corrida** (`runId`) que genera `launch`, que `settle`
   recibe y que marca `finished`/`settled` solo si sigue siendo el vigente del mensaje. Reemplaza la guarda
   `if (this.cancels.has(messageId)) return` de #570, que depende de que `cancels` viva durante toda la corrida, cuando
   solo vive durante el compose. Hoy no se alcanza: un turno de plan no registra `late`, así que su `settle` termina
   antes de que la persona pueda aprobar. Se rompe en cuanto un turno de plan registre pasos tardíos o el build se
   reanude fuera del compose. Una guarda por `running` del workspace tampoco sirve: con un follow-up de OTRO mensaje en
   el mismo ws, el `settle` del anterior no cerraría nunca.
   **Cómo** (diseño de orq, revisado por Arq el 2026-11-04; va en `run-cycle.ts` después del PR 2):
   - El token nace en `launch`, en su primera línea: `runSeq.set(id, ++this.runCounter)`. `runCounter` es un contador
     **global y monótono** que no vuelve a empezar. `resumePlanBuild` ya pasa por `launch`.
     - Por qué global y no por id: con un contador por id que arranca de nuevo al borrarse, un `settle` viejo que capturó
       `1` coincidiría con una tercera corrida del mismo id que vuelve a recibir `1`.
   - `settle` captura `const mine = runSeq.get(id)` en su primera línea, de forma síncrona y antes de cualquier
     `await`. Todos sus llamadores lo invocan síncrono: `release`, `variants`, `edit-runs`.
   - El orden dentro de `settle` es:
     1. `await pending`;
     2. borrar su propio `late` si sigue siendo el suyo (como #570);
     3. `if (runSeq.get(id) !== mine) return;`, antes del `try/finally`, para que `finished.add`, `settled` y
        `autoRepairAfter` no corran para el cierre viejo.
   - En el `finally`: `if (runSeq.get(id) === mine) runSeq.delete(id)`. Solo ahí, no en `release`.
   - Las corridas sin `launch` (`edit-runs`, `brand-runs`) dan `undefined === undefined`: igual que hoy.
   - No cambian `late`, `finished.delete` de `resumePlanBuild` ni la semántica de `cancels`, que deja de ser señal de
     re-corrida en `settle` (`variants` lo sigue usando como "ya cerró").
   - Tests:
     - activar el `todo` de `close-index-table` (late inyectado + compuerta fuera del compose: build, commit, preview);
     - `plan-mode` en verde sin cambios;
     - dos `launch` del mismo id con el `settle` del primero esperando;
     - comprobar que los tests nuevos salen ROJOS sin el cambio.
   - Cerrada en #627: `settle` usa `runSeq` (`run-cycle.ts`), y la guarda `cancels.has` de #570 desapareció con su
     marca.
6. **Tests (QA, 2026-11-04).** Los dos PRs pasan en CI, sin cambios en los tests, porque un test que hay que tocar
   señala un movimiento que no fue mecánico:
   - **Ambos PRs:** `adr-0014-index-owner`, `v0-transport`, `transport-lifecycle`, `transport-robustez`, `plan-mode`,
     `plan-mode-decision`, `plan-mode-autorepair`, `builder-stream-settled`, `plan-resumed-fold`,
     `instructions-inherit`, `v0-events`, `close-index-table` (6.1-6.3; lleva el `todo` del `runId`).
   - **PR 1 además:** `v0-late-steps`, `preview-heartbeat`, `v0-live-preview`, `runtime-repair`,
     `brand-memory-hardening`, `agent-context`, `agent-composer`, `v0-turn-usage`, `telemetry-otel`,
     `v0-sandbox-deploy`.
   - **PR 2 además:** `v0-approvals`, `agent-mcp-plan-order`, `approvals-always`, `transport-remount-app`, `v0-runner`,
     `agent-stream`, `v0-replace-image`, `v0-section-suggestions`, `v0-workspace-tools`, `brand-load`,
     `transcribe`.

   **Línea base** (orq, main #588): los 33 archivos de las listas de arriba dan 379 pass, 0 fail, 1 skip
   (`plan-mode-decision`, GET con `:chat` ajeno) y 0 todo, en dos corridas idénticas (~48 s en serie;
   `v0-transport` con 101 tests y 21 s es el lento). `close-index-table` se suma aparte: 4 pass y 1 todo. Para
   reproducirla hace falta `templates/arc-scaffold/node_modules` instalado, como en CI; sin él salen 6 rojos falsos.
   Cada PR se compara contra esta línea base: los mismos números o mejores, con el `todo` en verde solo en el PR del
   `runId`.

   Huecos sin test. Los de 6.1 y 6.2 bloquean: entran en main antes del PR 1, en verde sobre el código actual.
   - 6.1. Tabla de `index.json` por desenlace de cierre (versión, asked, plan, stopped, failed, interrumpido): la entrada
     completa, no solo un campo. Es la red de las 15 conversiones a `updateEntry`.
   - 6.2. Dos escrituras seguidas al índice en el mismo cierre (regla 5): la segunda ve la primera.
   - 6.3. Un `settle` tardío de una corrida vieja no cierra la corrida nueva del mismo mensaje. Hoy solo se puede
     escribir para el caso que sí se alcanza (cierre que espera `late` mientras el mensaje vuelve a correr dentro del
     compose). El caso fuera del compose queda como `test.todo` hasta el PR del `runId` (condición 5), que lo pone en
     verde. Un test rojo hoy bloquearía dos PRs mecánicos por un caso que no se alcanza.
   - 6.4-6.8 entran con el PR que mueve su código: `installDeps` (PR 1, `run-checks`), `steerLive` durante el build de
     un plan (PR 2), `supersede` sin dejar `lateChecks` huérfano (PR 2), `context.usage` en failed/stopped/asked
     (PR 1), y `shutdown` con `late` en vuelo o un plan pendiente (PR 2).
   - 6.7, no aplica: `context.usage` en los cierres `stopped` y `failed` no se puede medir, porque esos cierres pasan
     por `keepStopped`, que no recibe `RunnerPage` (el composer no devolvió página). Lo emiten versión, asked y plan.
     6.4 lo cubren install-deps-coverage y brand-memory-hardening.
   - 6.6 y 6.8, hechos en #624:
     - 6.6: supersede no deja huérfano un `lateChecks`.
     - 6.8: shutdown con `late` en vuelo o con un plan pendiente.
   - 6.5 ya existía (plan-mode-autorepair:171).
   - La ventana de caída entre el índice y el `message.end` la cubre run-close-crash-window (#632) con dos casos:
     un cierre ya escrito se reemite sin recalcular, y el build de un plan caído no reusa el `asked` del plan.
     Pendiente para QA (no bloquea): comprobar que `reemitEnd` emite el `snapshot` con sus archivos cuando la versión
     tiene commit propio.
   - 6.9. **Lo que un test toca por cast se queda en Transport**, como campo o como método que delega, en los dos PRs.
     Así "sin cambios en los tests" sigue valiendo. Los casos de hoy en main:
     - `late` (`plan-mode.test.ts:77, :410`) sigue siendo un `Map` de Transport y llega a `RunClose`/`RunCycle` por
       referencia, que ya era el plan.
     - `save` e `index` (`transport-robustez.test.ts:75`) ya se quedan en Transport.
     - `end` (`v0-transport.test.ts:2098-2101`) lo parchea el test sobre la instancia, y el cierre `restore` de
       `updateDs` le llega por el callback de `brand-runs`. Transport conserva un `end(...a)` que delega en
       `RunClose.end`, y todos los callbacks de colaboradores se cablean como `(...a) => this.end(...a)` (enlace tardío)
       y no como `this.close.end`. Si no, el parche del test deja de interceptar y el test pasa sin probar nada.
     - Antes de cada PR, el autor busca en `tests/` los casts sobre Transport
       (`git grep -nE "as unknown as \{" -- tests`) y comprueba que cada miembro tocado siga existiendo en Transport.
7. **Invariante del cierre: "sin escrituras" se mide contra el commit padre de la versión, nunca contra HEAD.** Un
   follow-up sobre una versión que no es HEAD (restore, picker) arranca con el árbol del padre. `isClean` (contra HEAD)
   puede dar sucio sin que el agente escribiera nada, y entonces se crea una versión idéntica al padre (hallazgo de QA,
   2026-11-04, en `keepStopped` y `runtimeRepair`). Regla: el cierre que decide si hay versión usa
   `changedSince(dir, parentCommit)` (con `.wt` excluido, como en #554). `isClean` solo sirve para "¿hay que descartar
   antes de restaurar?". El arreglo va antes del PR 1 (orq). El PR 1 lo hereda tal cual y la tabla de 6.1 tiene que
   cubrir el caso de follow-up sobre una versión que no es HEAD.

### Cómo quedó (main c07d204a)

| archivo | líneas |
|---|---|
| `transport.ts` | 593 |
| `run-cycle.ts` | 721 |
| `run-close.ts` | 376 |
| `run-checks.ts` (hoja) | 160 |

Los cuatro quedan por debajo de 800 (regla 4). `transport.ts` conserva el estado del ciclo, la persistencia y los
delegados que los tests tocan por cast (6.9).

Lo que no fue mecánico, aparte de las 15 escrituras a `updateEntry`, entró en PRs propios:
- `end` escribe el índice antes del `message.end` (#612).
- `runId` en `settle` (#627).
- `recover`, que reemite un cierre ya escrito si `endedAt > at` del último `message.start`, estricto (#632).

`run` y `materialize` siguen enteros (condición 4).

### Opción B: aceptar `transport.ts` > 800

Queda en ~1414 líneas, con una excepción escrita a la regla de 800: "el ciclo de corrida es una unidad; partirlo cuesta
más de lo que aclara".
- Coste: cada módulo que toque el ciclo vuelve a compartir archivo. Plan mode tocó `start`, `run`, `materialize`,
  `keepStopped` y `cancel`; M2 tocó `materialize`, `keepPlan` y `keepStopped`. Es el riesgo que marcó F3
  (`f3-audit.tsv:48`).
- Además, la regla de 800 pierde fuerza en todo el repo si su mayor archivo es la excepción.

### Recomendación

A, con las condiciones 1-4. El ciclo es justo donde más chocan los dueños de cada módulo; B deja a la mitad el
problema que motivó este ADR. Cuando Karen decida, solo cambia la línea de Estado: con A pasa a APROBADA y arranca el
PR 1; con B pasa a RECHAZADA y se escribe la excepción en la regla 4.
