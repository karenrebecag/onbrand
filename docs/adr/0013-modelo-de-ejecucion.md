# ADR 0013: modelo de ejecución. La corrida es durable, el preview es desechable

Estado: decidido en chat. D1-D5 y las reglas comunes están decididas; D6 queda abierta para otro ADR.
[KAREN:chat 2026-11-02]

Fecha: 2026-11-02. Redacta: Arq.

Dueñas:
- orq y ec: transport;
- UI: builder.

Base de código: `feat/ronda-extracts` @ 96784aa.

RE de origen, fuera del repo: `~/Desktop/web-transformer-sesiones/re-iteracion/`. Lo que cito de ahí:
- `re-ejecucion/{v0.md, lovable-stitch.md, nosotros.md, builder.md}`;
- `re-transport-robustez/{README.md, auditoria-propia.md}`.

El borrador con todas las opciones y sus trade-offs está en `re-ejecucion/adr-borrador.md`.

Abreviaturas de los extracts: `H` = `~/v0-fe-capture`; `O` = `H/v0-re/orq`; `I18n` = `re-iteracion/transport/deob/I18nStore.js` (Stitch).

## Contexto

El 2026-11-02 el timer de deadline de `browser.ts` llamó a `browser.process()`, que es API de puppeteer y Playwright no tiene. Eso
pasó dentro de un `setTimeout`, nadie lo atrapó, y el transport murió con todas sus corridas y variantes. Desde f691017 las tools
corren dentro del proceso del transport (robustez README, causa raíz). El fix puntual ya está (edc416c). Pero el RE mostró que la
causa de fondo es el modelo, no el bug, porque mezcla tres vidas en un proceso:

- **Verdad**, que ya es durable: git del ws, `index.json` y `logs/<id>.ndjson` append-only con `seq` (src/v0/events.ts:6, :44).
- **Estado de control**, que vive solo en memoria: `running`, `variantQueue`, `variantGroups`, `approvalRuns` y `live`
  (src/v0/transport.ts:600-638). Un reinicio lo pierde, y `recover` cierra con `error` sin emitir `settled`
  (src/v0/transport.ts:660-670).
- **Desechable**: el vite de cada ws en un pool de 4 con desalojo LRU (src/v0/preview.ts:97, :185-191). Al relanzarlo cambia de
  puerto, y el builder no se entera (`builder.md` §2).

Los referentes separan esas vidas:
- **v0** guarda la verdad en git y mensajes. La VM por chat es desechable: expira y se recrea desde el último commit
  (`H/HALLAZGOS-frontend-v0.md:52`), con snapshot estático mientras tanto (`:50`) y un latido de la pestaña cada ~5,5 s
  (`O/requests.ndjson`, `vm/status` de t=2,7 s a 1200 s).
- **Stitch** reengancha con `resumeToken` y backoff de 1 a 30 s sin tope (`I18n:13547-13551`, `:13881-13960`).

## Decisión

### Reglas comunes a toda corrida

1. **Arranque limpio.** Toda corrida con padre parte del árbol del commit del padre, sin archivos sin versionar. Hoy `run` solo
   restaura si HEAD ≠ padre (src/v0/transport.ts:1492-1494; `nosotros.md` §7.7), así que un follow-up hereda la suciedad
   de una corrida fallida y el restore la commitea.
2. **Un terminal único.** Toda corrida termina en `settled`, también la que cierra `recover`. Es el terminal del contrato de
   eventos (src/v0/event-model.ts:71). Hoy, sin él, el builder deja variantes con `settled=false` para siempre y el pan del grupo
   no ocurre (`builder.md` §1: apps/builder/src/lib/use-builder.ts:346-351, variant-layout.ts:145).
3. **Desenlace explícito** `ok | stopped | failed | asked`, en el índice y en `message.end`. Hoy un `result` de error del CLI se
   guarda como versión normal o como pregunta con el texto del error (`nosotros.md` §6, §7.8; src/v0/agent-composer.ts:287,
   src/v0/transport.ts:1849-1850).

### D1. Estado de corrida durable como eventos `run.*` en el log

- Eventos `run.queued`, `run.started`, `run.settled` (y los que hagan falta) en el ndjson de cada id.
- `recover` deriva el estado del último evento, en vez de cerrar todo lo que no tiene `message.end` (src/v0/transport.ts:660-670).
- La cola de variantes es "ids con `run.queued` y sin `run.started`". El grupo sale del índice (`variantOf`) más esos eventos.
- Con esto deja de perderse lo que hoy vive en memoria: cola, grupo y token de aprobación (src/v0/transport.ts:600-638;
  `nosotros.md` §7.1, §7.4).

Fundamento:
- el log ya es append-only con `seq` y el stream lee de ahí (src/v0/events.ts:6, :44);
- v0 guarda el mensaje como lista de parts con estado (`H/HALLAZGOS-frontend-v0.md:112-114`);
- Stitch guarda `pendingTurn` en la sesión (`I18n:15915-15920`).

Por qué no un almacén aparte: sería una dependencia nueva y un segundo sitio que se desincroniza del log.

### D2. Corrida viva cuando cae el transport: `stopped` + `settled` + "continuar"

- `recover` cierra la corrida viva como `stopped` y emite `settled`. El builder muestra que se interrumpió y ofrece **Continuar**.
- Continuar es un follow-up con `--resume <sessionId>` (el sessionId ya se guarda en `.wt`, src/v0/agent-composer.ts:280) sobre
  el árbol detenido.
- La reanudación automática queda para después, cuando el runner sea remoto (D6).

Restricciones:
- Patch y edición directa no tienen "lo que alcanzó a escribir el agente": `recover` los **descarta** en vez de `keepStopped`
  (`nosotros.md` §5b, §7.9; src/v0/transport.ts:666, :1015).
- Las variantes en cola sin log, que hoy `recover` salta y deja huérfanas (src/v0/transport.ts:661), se cierran desde los
  eventos de D1.

### D3. Preview: latido, `dist` por versión, recreación y url estable por ws

1. **Latido.**
   - El builder informa cada ~5 s los ws visibles y en foco.
   - `protect` los incluye (src/v0/preview.ts:110), y `evict` solo toca lo que nadie mira (:185-191).
   - Fundamento: el latido de v0, `vm/status?pageFocused&pageVisible&msSinceLastInteraction`, mediana 5573 ms y que no depende
     de la interacción (`O/requests.ndjson`; `re-ejecucion/v0.md` §1).
2. **`dist` por versión como snapshot estático.**
   - El `vite build` de `materialize` ya está activo por defecto (scripts/v0serve.ts:142; src/v0/transport.ts:1863).
   - Su `dist/` se guarda por commit y se sirve estático como marco de las versiones cerradas.
   - vite dev se levanta solo bajo demanda: corrida viva, edición directa o latido.
   - v0 sirve un snapshot HTML sin scripts que sube el navegador (`H/HALLAZGOS-frontend-v0.md:50`); el nuestro lleva JS y lo
     produce el servidor.
3. **Recreación desde el commit.** Un ws sin vite que vuelve a ser mirado se relanza desde su commit, como `run-pipeline` en v0
   (`H/HALLAZGOS-frontend-v0.md:52`; `O/net/087`).
4. **Url estable por ws, no por puerto.**
   - Hoy `freePort` toma el primer puerto libre (src/v0/preview.ts:174-182). Si el puerto viejo lo toma otro ws, el cliente de
     vite del iframe recarga contra él y el marco puede mostrar la página de otro chat. El builder no lo detecta porque filtra
     por origen (`builder.md` §2; vite/dist/client/client.mjs:1087-1088). Esto sale de leer el código; no se observó.
   - Con url estable, además el builder vuelve a pedir el estado del preview cuando el marco no reporta en `REPORT_WAIT_MS`.
   - Cómo se implementa la url estable (ruta proxy por ws o host `*.localhost` por ws) queda en la spec.

### D4. Endurecer las tools in-process; proceso hijo solo si no aguanta

Las tools siguen en el proceso del transport. Se corrigen en el orden 1-5 de `re-transport-robustez/auditoria-propia.md`:

1. Las promesas flotantes que hoy tumban el servidor por el handler de scripts/v0serve.ts:183:
   - `settle` (src/v0/transport.ts:724, llamado sin await en :899, :976, :981);
   - el `.then(ok)` de `launch` (:965-984);
   - verificar `runPatch` y `runDirectEdit`.
2. Un `AbortSignal` de la corrida que llegue hasta las tools: `generateImage` sin `abortSignal` (src/v0/image-step.ts:27),
   `execFile` sin timeout ni signal (src/v0/infer.ts:14) y la visión (src/v0/vision.ts:62).
3. `sh` (`bun install`, `vite build`) deja de ser `spawnSync` sin timeout (src/v0/transport.ts:509-514).
4. git, lint y gate síncronos, a async si el bench muestra latencia en streams paralelos (auditoría #10, #11).
5. Registro de hijos vivos y escalado a SIGKILL en el shutdown (auditoría #12).

Por qué in-process (f691017, dato de orq):
- el MCP stdio heredaba el env del CLI, y `agentEnv` le quita `AI_GATEWAY_*`/`VERCEL_*` a propósito (src/v0/agent-loop.ts:95, :98);
- poner la key en `--mcp-config` se ve en `ps`;
- las tools pasaron a ser integraciones del backend, con las credenciales del orquestador, como en Lovable
  (`re-iteracion/transport/lovable/deob/registry-CmMIU-Jy/deobfuscated.js:4835-4866`).

Si lo endurecido no aguanta el bench, el proceso hijo lo lanza **el transport**, no el CLI, con la key por env.

Patrón a seguir para browse y visión, sin copiar su vía de red:
- v0 corre `agent-browser` en un sandbox aparte por llamada, y su fallo es un resultado de subtask que el agente rodea
  (`O/stream-detalle.txt:64-90`).
- Cómo ese sandbox llega al dev server no se observó; esa vía la elegimos nosotros.

### D5. En el deploy, el git va como bundle por commit en Blob privado

- El FS del Vercel Sandbox es desechable.
- Su snapshot no sirve como verdad: caduca a los 30 días por defecto y solo se guardan los últimos 1-10 (`snapshotExpiration`,
  `keepLastSnapshots`; https://vercel.com/docs/sandbox/sdk-reference).
- v0 también guarda el git fuera de la VM (`v0-git-s3-storage`; `H/HALLAZGOS-versionado-v0.md:4-10`).
- Blob es el almacén que ya usa el registry (src/v0/registry-blob.ts:1-6).

### D6. Dónde corre el loop del agente en el deploy: abierta

Las dos opciones del borrador siguen en pie:
- CLI dentro del Sandbox;
- loop en el orquestador por AI Gateway, con las tools contra el Sandbox.

Se decide en otro ADR. Condiciona cuándo se activa la reanudación automática de D2.

## Alternativas descartadas

- **Estado en `index.json`** (D1): más escrituras de un archivo que se reescribe entero en cada `save()` (src/v0/transport.ts:672).
  Empeora el riesgo de disco lleno (auditoría #1).
- **Almacén aparte, SQLite o Redis** (D1): dependencia nueva y doble fuente.
- **Reanudar sola en `recover`** (D2, por ahora): un crash causado por la propia tool se repetiría en bucle.
- **Pantalla como artefacto, sin dev server, como Stitch** (D3): no sirve con un agente que escribe React y lo verifica en vivo
  (`re-ejecucion/lovable-stitch.md` §8a).
- **Snapshot del Sandbox como verdad** (D5): caduca.

## Consecuencias

- Spec de robustez (orq y ec): D4 1-5, las reglas comunes, `recover` con `settled` y desenlace, y D2.
- El cliente reintenta con backoff 1, 2, 4, 8, 16, 30 s sin tope, y el contador se reinicia al avanzar el cursor. Hoy hace 4
  reintentos y a los ~7,5 s cierra en error (apps/builder/src/lib/run-client.ts:264; Stitch `I18n:13547-13551`).
- Spec de estado durable (orq): eventos `run.*`, `recover` derivado, cola y grupo desde el log.
- Spec de preview (ec y UI): latido, `dist` por versión, recreación y url estable.
- El deploy en Vercel (`re-ejecucion/adr-borrador.md` §6) espera a que esas tres specs estén en main, y a D6.
- ADR 0011 sigue vigente. Su tabla gana dos filas:
  - "Ejecución: VM por chat (v0) / runner por ws";
  - "Preview dormido: snapshot sin scripts (v0) / `dist` por versión".

## Huecos que este ADR no cierra

- v0: qué pasa si la VM expira a mitad de un turno. Capturarlo gasta créditos.
- Topes de VMs y de concurrencia en los referentes.
- Máximo de `timeout` del Sandbox en el plan de atomchatio: las docs remiten al plan.
- La mezcla de páginas por puerto reusado (D3.4) sale de leer el código, sin observarla.

## Ubicación actual (main bc66355d)

El texto de arriba cita `src/v0/transport.ts`, que #642 y la Enmienda 1 partieron en `src/runtime/`. El archivo
ya no existe; esta tabla traduce cada cita a su línea vigente, verificada contra el código. No reescribe la
decisión: solo reubica las referencias. (`scripts/v0serve.ts`, citado junto a dos de ellas, es hoy `scripts/serve.ts`.)

| Cita vieja (`src/v0/transport.ts`) | Qué señalaba | Ubicación actual |
| --- | --- | --- |
| `:600-638` (§Contexto, D1) | estado de control en memoria: `running`, `variantQueue`, `variantGroups`, `approvalRuns`, `live` | `src/runtime/server.ts:100` (`running`), `:119` (`live`), `:114` (`variants`); `src/runtime/variants.ts:46` (cola), `:47` (grupos); `src/runtime/agent-mcp.ts:64` (`approvalRuns`) |
| `:660-670` (§Contexto, D1) | `recover` cerraba con `error` sin emitir `settled`; ahora deriva el estado del último evento | `src/runtime/run-close.ts:72` (`recover`); hoy emite `settled` en cada rama (`:90`, `:96`, `:113`) |
| `:666` (D2) | `recover` descarta patch/edición directa a medio aplicar | `src/runtime/run-close.ts:100-104` (rama `entry.kind`: `restoreTree` `:103`, `end('error', failed)` `:104`) |
| `:1015` (D2) | la otra mitad: la edición directa se marca `kind` para que `recover` la descarte | `src/runtime/edit-runs.ts:305` (marca `kind`), `:154` (orden `kind` antes de `restoreTree`) |
| `:661` (D2) | variantes en cola sin log que `recover` saltaba | `src/runtime/run-close.ts:76` (`failVariant` si no hay log), `:83` (re-encola el `run.queued`) |
| `:1492-1494` (regla común 1) | `run` restauraba solo si HEAD ≠ padre | `src/runtime/git-workspace.ts:56` (`restoreTree`); llamadas en `src/runtime/run-cycle.ts:498`, `:501` |
| `:1849-1850` (regla común 3) | un `result` de error del CLI se guardaba como versión/pregunta; ahora el desenlace es explícito | `src/runtime/run-close.ts:131` (`finishReason` por `outcome`), `:141-156` (`end` persiste `ok\|stopped\|failed\|asked`) |
| `:1863` (D3.2) | el `vite build` de `materialize` ya está activo por defecto | `src/runtime/agent-composer.ts:257` (`build` es `RequiredCheck` por defecto sin navegador); `scripts/serve.ts` `--no-build` (build on salvo opt-out); build servible `src/runtime/preview-dist.ts:254` |
| `:724` (D4.1) | `settle` | `src/runtime/run-cycle.ts:205` (`async settle`) |
| `:899`, `:976`, `:981` (D4.1) | `settle` llamado sin `await` | `src/runtime/run-cycle.ts:405` (`void this.settle`), `src/runtime/edit-runs.ts:174` (`void this.deps.settle`); la promesa flotante se cerró haciendo `settle` síncrona antes del primer `await` (`:206`) y sin rechazar |
| `:509-514` (D4.3) | `sh` (`bun install`, `vite build`) era `spawnSync` sin timeout | `src/runtime/shared.ts:417` (`async function sh(…, signal?: AbortSignal)`); el install lo llama `src/runtime/run-checks.ts:94` (`:92` arma los args) |
| `:672` (Alternativas, D1) | `save()` reescribe `index.json` entero | `src/runtime/server.ts:280` (`save` → `writeFileSync` `:281`) |
