# Programa robustez de ejecución

Rama `feat/robustez-ejecucion` (worktree `wt-robustez`, base main 40982a4). Orquesta y hace git: WebTransformerOrq.
Fuentes: `~/Desktop/web-transformer-sesiones/re-iteracion/` (`RI`):
- `re-ejecucion/adr-borrador.md` (ADR, se pasa a `docs/adr/` como 0013);
- `re-transport-robustez/auditoria-propia.md` (aud) y `README.md` (rob);
- `re-ejecucion/nosotros.md` (nos) y `builder.md` (bld);
- `re-contexto/sintesis.md` (sín).

Regla 8 del RULESET: todo cambio cita un extract o doc con file:line, o una línea de código propio. Una medición en vivo es solo observación.

## Decisiones

- [KAREN:chat 2026-11-02] "vamos con todas las recomendaciones. ok a todo. siempre fundamentando con extracts". D1 B, D2 A+C ahora y B con runner remoto, D3 A+B + url estable, D4 A ya, D5 a. D6 queda abierta. Contexto: C1 a, C2 a, C3 a, C5 a (archivar, delete aprobado), C7. C4 va con la ronda del gate de copys.
- [KAREN:chat 2026-11-02] "cuando no haya bloqueantes y todos los agentes estén listos, dale con la implementacion completa".

Fuera de esta ronda: D5 y D6 (son del deploy, que espera estas specs en main y pide OK por deploy), C4 (ronda del gate de copys) y accesibilidad (ronda aparte).

## Reglas del programa

- Git solo lo hace Orq. Cada dueño manda: rutas, mensaje de commit y los tests del área que corrió.
- Generaciones congeladas hasta que R1 y R2 estén commiteadas y verificadas. Después QA corre el banco; cada gasto lleva el OK de Karen en la sesión que gasta.
- Un test por comportamiento o bug. Nada de aserciones de reloj.
- `transport.ts` lo tocan varios dueños: cada uno toca solo las funciones de su spec, y Orq separa los hunks al commitear.

## Specs

| Spec | Dueño | Depende de | Verifica |
|---|---|---|---|
| R1 endurecer tools | karenrebecaog-3a (ec) | — | Arq (código), QA (banco) |
| R2 ciclo de vida único | ec | R1 | Arq, QA |
| R3 estado durable | ec | R2 | Arq, QA |
| R4 builder: reenganche | UIWebTransformer | R2 (contrato), R3 (grupo) | Secondary |
| R5 preview estable | WebTransformerSecondary | — (transport), R4 (marco) | Arq, QA |
| R6 contexto | orqWebTransformer | R2 | Secondary |
| ADR 0013 | ArqWebTransformer | — | Orq |

### R1. Endurecer las tools in-process (D4 A; aud orden 1-5)

1. `settle` y el handler de éxito de `launch` no pueden rechazar sin catch (aud #1 `transport.ts:724-731`, #2 `:967-978`). Verificar #3 (`runPatch`/`runDirectEdit`) línea a línea y aplicarle lo mismo.
2. `AbortSignal` de la corrida de punta a punta: `toolChain`/`runWorkspaceTool` (aud #5), `generateImage`/edit con `abortSignal` (aud #6; `ai` `index.d.ts:7031`), `infer.ts` `execFile` con `signal` + `timeout` (aud #8), visión (aud #4). Al cancelar, las tools encoladas no arrancan.
3. `sh` (bun install, vite build) asíncrono con timeout (aud #9). Mientras corre, el event loop sigue libre.
4. git/lint/identidad del typecheck y render-gate a async (aud #10, #11). Va después de 1-3; si no entra en esta spec, queda como ítem propio.
5. Registro de hijos vivos y escalado SIGTERM→SIGKILL antes de `exit` en shutdown (aud #12, #13). El patrón de referencia es `preview-check.ts:29-41` (aud #15).
6. El watchdog en modo HTTP aborta la tool por su signal en vez de `killWorkspaceMcp` (aud #7). La ruta stdio muerta (aud #18) se borra solo si nada la importa.

Aceptación: un test por ítem (throw en settle no tumba el proceso; Stop corta la imagen y el execFile; sh no bloquea un stream concurrente; shutdown no deja hijos vivos).

### R2. Un ciclo de vida para toda corrida (ADR §2; D2 A)

1. Arranque limpio: toda corrida con padre parte del árbol del commit del padre, sin archivos sin versionar (nos §7.7).
2. Terminal único: toda corrida termina en `settled`, también las que cierra `recover()` (bld §1; contrato `event-model.ts:71`).
3. Desenlace `ok | stopped | failed | asked` en el índice y en `message.end`. Un `result` de error del CLI ya no se guarda como versión normal ni como pregunta (nos §7.8).
4. Restore atómico: marcar antes de `restoreTree` y después de `commitAll` (nos §7.3).
5. `recover` descarta un patch o una edición directa a medio aplicar en vez de `keepStopped` (nos §7.9).
6. Una corrida viva al caer el transport se cierra como `stopped` + `settled`, con una marca `interrupted` y el `sessionId` para continuar. "Continuar" es un follow-up con `--resume <sessionId>` sobre el árbol detenido (ADR §2 opción A).

### R3. Estado de corrida durable (D1 B; ADR §1)

1. Eventos `run.queued` y `run.started` en el ndjson de cada id. El `run.settled` del ADR es el `settled` que ya existe (event-model.ts:71) más el `outcome` de `message.end` (R2.3): no se agrega un segundo terminal, que duplicaría la regla común 2 (Arq, verificación de 27c976b).
2. `recover()` deriva el estado del último evento. La cola de variantes son los ids con `run.queued` y sin `run.started`, y se reanuda con `maxRunning`.
3. El grupo de variantes sale del índice (`variantOf` + `run.queued`): `cancel` por grupo funciona después de reiniciar (ADR §5; Stitch `listSessions` + `pendingTurn`, rob P8).
4. `GET /chats/:id` devuelve las variantes del chat. Hoy el filtro `e.ws === chatId` las pierde al recargar (`transport.ts:1406-1420`).

### R4. Builder: reenganche y desenlaces (ADR §5)

1. Backoff 1, 2, 4, 8, 16, 30 s sin tope, con el contador reiniciado cuando avanza el cursor, y un estado visible "reconectando" que no es error (Stitch `Um`/`Wm`, `I18nStore.js:13547-13551`; hoy `run-client.ts:257`).
2. Defensa: si el stream cierra después de `message.end` sin `settled`, cuenta como cierre (`follow` y `followVariant`; bld §1). `ran.current` se baja ahí.
3. Corrida `interrupted`: la tarjeta muestra "Se interrumpió" con la acción "Continuar" (R2.6).
4. Variantes rehidratadas desde `GET /chats/:id` (R3.4).
5. Revocar "always" desde el menú de la tarjeta de aprobación: "Preguntar cada vez" (Lovable `app-lazy-surfaces` deob :1453-1463, :1835-1871).
6. La parte de marco de R5: re-pedir el preview cuando el marco no reporta en `REPORT_WAIT_MS` y remontar si cambió (bld §2), y mandar el latido de R5.2.

### R5. Preview estable (D3 A+B; ADR §3)

1. Url estable por ws: ruta del transport `/preview/<ws>/` como proxy a vite, con websocket de HMR. El iframe ya no apunta a un puerto (bld §2: mezcla de páginas por puerto reusado).
2. Latido: el builder manda los ws visibles cada ~5 s (v0 `vm/status?pageFocused&pageVisible`, `HALLAZGOS-frontend-v0.md:13`); `protect` los incluye y `evict` solo toca los que nadie mira (hoy `preview.ts:97` MAX_LIVE 4, protect solo de corridas en `transport.ts:646`).
3. `dist/` por versión: el `vite build` de `materialize` (`v0serve.ts:142`, `transport.ts:1854`) se guarda por commit y se sirve estático en la misma url cuando no hay vite vivo. Vite se levanta bajo demanda: corrida viva, edición directa o latido.
4. Recreación desde el commit cuando el vite murió: `ensure` en la url estable.

### R6. Contexto del follow-up (sín §2, §3)

1. C1: los defectos del preview-check del padre y el viewport que la persona mira van a `.wt/context/` en cada follow-up (Lovable `runtime_errors`/viewport por `/chat`, ls §1, §3).
2. C2: si el `vite build` de `materialize` falla, una reanudación con el error (como `resumePrompt`) antes de cerrar con `failed` (v0 corre el build en el loop, v0 §3).
3. C3: el pin sigue fijo; se suma la acción "actualizar DS": una corrida tipo restore que vuelve a montar el DS del `latest` en un commit propio (Stitch, ls §1). Transport aquí; el botón lo pone UI en R4.
4. C5: archivar el camino props/JSON (`verify`, `slot-policy`, `layout-check`, `href-check`, render-gate, `repairsOf`, `facts-coherence` en runtime). `slot-policy` y `verify` quedan como insumo de `build-ds-skill` y de los sensores del banco. Se borra solo lo que nada importa después del corte.
5. C7: slots de imagen solo cuando no hay tool de imagen (`slotsOn`, sín §3.2). Un cambio de una línea, con su test.

## Estado

- R1 cerrada: R1.1 12c5b61, R1.2 6e3d175 + 1849fe5, R1.3 3086526 + e0cb602, R1.5 f104707 y R1.6 56ff49c, todas verificadas por Arq salvo R1.6, que está en curso.
- R1.4 medida, no implementada. Las partes síncronas del typecheck cuestan ~55 ms por llamada sobre un clon del ws 8f185369 del banco (filesSinceBase 38,3 ms, undefinedTokenReport 14,9 ms, dsLintWorkspace 0,5 ms; media de 5). La spec la condiciona a latencia observada en el banco. El render-gate se va con R6 C5. Disparador: si QA ve cortes de más de ~1 s en streams paralelos o en el /mcp, filesSinceBase pasa a git asíncrono primero (es el 70 % del costo).
- R4.5 cerrada: 271009d + e0b342e + 0e329f4.
- [KAREN:chat 2026-11-02] Origen de preview por chat (`<chat>.localhost:<puerto>`) en esta ronda, como Lovable y v0 (re-transport-robustez/zap-api-origen.md). El HMR por host quedó probado en vivo (re-transport-robustez/host-por-ws-experimento.md). Lo hace Secondary (R5.5) y lo verifica Arq. R6 lo verifica Arq, ya no Secondary.
- [KAREN:chat 2026-11-02] "vamos , tienes mi ok ." para los casos 4 y 6 del banco (generan variantes). Antes, "reparte. arregla las primeras dos y tú encárgate de la 3": variante fallida (UI, 9573945) y logo 404 (orqWT); la 3 (variantes casi iguales) resultó correcta: el panel pidió solo Texto (variants-prompt.ts, DesignPage :34449-34476).
- Próxima ronda: reintentar una variante sola desde el chat (Stitch lo ofrece por chat, DesignPage :5545-5549; hoy el transport no relanza una variante).
- [KAREN:chat 2026-11-02] "no migramos. Pero es importante para mí que generemos un nuevo qa": los ws ya creados conservan su vite.config sin cors:false (H1, 2e483f7 cubre solo los nuevos); QA rehace el banco en una raíz limpia (generated/robustez-2) con foto y variantes por defecto.
- R5 cerrada: 4440399, 4b245b5, d83ddd8, ea0e8a7 y 5f34da2, verificadas por Arq; el security-reviewer bloqueó 4b245b5 y lo cerró ea0e8a7.
- Para la ronda de deploy (Arq): con el origen por chat, en local el ws sale del Host `<ws>.localhost`. En Vercel Sandbox hay un chat por VM y el dominio es por puerto, sin wildcard (`sandbox.domain(port)`), así que el listener de previews de cada Sandbox sirve un solo ws fijado por config y no lo deriva del Host. Un dominio propio con wildcard delante solo hace falta si el preview se sirve fuera del Sandbox.
- Tope de imagen con --product-image-only: b982009 lo guardaba en .wt y el agente podía borrarlo (Arq, bloqueante). d04a933 + 974d8dd lo pasan al transport por mensaje (llamadas, un reintento, llamadas en vuelo), verificadas por Arq. Es por turno, no por página.
- Próxima ronda: tope propio para edit_image por mensaje (Arq, mismo patrón cappedImage); calidad del prompt de variantes (QA rb-qa2: V2 quitó secciones que el brief pide, V1 cambió la foto por un mockup).
