# Arnés de la ronda de extracts (S0, casos A1-A6)

Dueño de los casos: QA. Dueño del código y de la corrida del T1: Orq. Los casos miden el T1 real; todo lo que reportan es **observación** (RULESET regla 8): cierra un ítem, pero no fundamenta código.

## Corrida
- **T1**: chat nuevo en :5298, Sonnet 5.5 high, con el brief de `re-iteracion/planes/qa-guion-perf.md` tal cual. Lo lanza Orq (gasto local); QA engancha antes del envío.
- **F1a-F1d**: sobre el mismo chat, en orden: titular, acento azul, mockup de WhatsApp en el hero y reorden de Casos por sectionOp (los mismos mensajes que en 56644d79).
- **Línea base**: T1 56644d79 (main 9b7121c). Todos los umbrales se comparan contra ella.

## Fuentes del dato
| Id | Fuente | Qué da | Quién |
|---|---|---|---|
| RL | `generated/dev/logs/<messageId>.ndjson` | eventos del turno con `seq` y `at` (escrituras, message.end, suggestions, settled) | transport |
| VL | `generated/<root>/logs/<ws>.vite.log` (S0 cambio 1) | stdout/stderr del vite del preview: `page reload`, `hmr update`, `Failed to resolve import`, `Pre-transform error` | v0serve |
| CC | listener CDP en el Chrome QA :9334, consola del builder y del iframe, con `Runtime.executionContextCreated` por frame | errores, `Invalid hook call`, cada contexto nuevo del iframe (= recarga) | QA |
| DS | muestreo CDP del DOM del iframe y del builder cada 250 ms durante el turno, guardado como ndjson con `at` | secciones montadas, cursor/rectángulo del puente, estados de carga | QA |
| SC | captura del builder cada 2 s mientras el turno corre, más una al cerrar | evidencia visual por caso | QA |

Las herramientas de CC, DS y SC son scripts de QA, de solo lectura sobre el Chrome :9334 y fuera de `src/`. Si Orq los quiere en `tests/` del arnés, se los paso.

Frames: el lienzo tiene dos iframes del preview, los dos visibles (`apps/builder/src/components/builder/artboard-canvas.tsx:20-23`):
- **Escritorio**, w=1280;
- **Móvil**, w=390.

DS los separa por `innerWidth`. En A1-A3 se miden y se reportan los dos: el criterio se cumple con **Escritorio**, y Móvil va como dato.

Reloj: todo en UTC. `t` = segundos desde el primer evento del RL.

Pestaña visible: antes del envío, la pestaña del builder en :9334 va al frente (`Page.bringToFront`). DS registra `document.hidden` del builder. Con la página oculta, Chrome agrupa los timers del iframe a 1 por minuto (intensive throttling, https://developer.chrome.com/blog/timer-throttling-in-chrome-88) y el `setInterval` del puente deja de correr a su ritmo (T1 48de1230: dibujos a las :34.55 de cada minuto con `TICK_MS=50`). Una muestra con `hidden: true` deja A3 y A4 NO CONCLUYENTE.

## Casos

### A1. La primera sección es visible antes de message.end
- **Mide**: DS en el iframe. Una sección visible = un hijo de `#root` (o de `#root main`) con `getBoundingClientRect().height > 0` y texto o imagen. `t_first` = primera muestra con ≥1 sección cuyo archivo `src/sections/NN-*.tsx` ya está escrito según RL.
- **Umbral**: pasa si cada sección está montada en el DOM antes de que RL registre la escritura del archivo de sección siguiente, y las secciones aparecen en el orden en que se escribieron. Una por archivo: vite manda un update por cada archivo creado (`node.js:25505`), y S1 garantiza que App no importa nada inexistente. No hay constante de tiempo. La carga inicial de una página que ya existe no cuenta.
- **Línea base 56644d79**: falla. Las 10 secciones entran juntas a t≈245 s (`viabilidad/qa.md`).
- **Fuentes**: DS + RL; SC como evidencia.

### A2. Full-reloads del iframe: a lo sumo 1 (index.html) y 0 desde la primera sección
- **Mide**: contextos nuevos de cada frame del preview en CC, con su `at`, cruzados con las líneas `page reload <archivo>` de VL (vite 8.3.4 `node.js:25629-25636` registra `page reload` y manda `full-reload` ante un cambio de `.html` del cliente).
- **Ventanas**:
  - W0, de la primera escritura en el workspace a la primera escritura de `src/sections/`. S1 escribe `index.html` primero, y un `.html` siempre fuerza full-reload (`node.js:25576-25583`, `:25629`).
  - W1, de la primera escritura de `src/sections/` a `message.end`.
  - Cada follow-up con sectionOp `remove` o `duplicate`, del envío a `settled`.
- **Umbral**:
  - W0: ≤1 recarga y, si la hay, VL la atribuye a `index.html`.
  - W1: 0.
  - sectionOp remove/duplicate: 0.
  - La carga inicial del preview (antes de la primera escritura) no cuenta.
  - En **restore** y **descartar** se acepta el remonte (ahí se mantiene la key): se reporta, pero no falla.
  - En el T1, `index.html` se escribe **una sola vez**, después de `identity.css` y `page-plan.md`. Si RL muestra más de una escritura de `index.html` en el T1, falla.
  - Un follow-up que cambia `title`, `lang` o fuentes en `index.html` recarga una vez: es esperado y no cuenta como regresión, siempre que VL atribuya esa recarga a `index.html`.
  - Si CC y VL no coinciden en una ventana, el caso queda NO CONCLUYENTE y se reporta la diferencia.
- **Línea base 56644d79**: falla, 18 recargas, 1:1 con los archivos nuevos (1 por `index.html` y 17 en W1).
- **Fuentes**: CC + VL + RL.

### A3. Cursor y rectángulo del puente en cada elemento nuevo
- **Mide**: DS en el iframe, con un `MutationObserver` de solo lectura inyectado por CDP en cada contexto, que cuenta:
  - `.wt-anim-draw-overlay` agregados, con el elemento objetivo, su rect y su `at`;
  - posiciones distintas de `#wt-agent-cursor` con `opacity` 1 y z-index 9999 (overlay a 998).
- **Umbral**: pasa si:
  - cada elemento de primer nivel que agrega el montaje de una sección pasa por la cola y se dibuja (processFadeIn, R l.1001-1017: la cola se vacía);
  - el cursor es visible en cada lote (R l.240-248, l.478-481);
  - ningún elemento tiene más de 2 animaciones (R l.458-462);
  - al desarmar el puente quedan 0 elementos pendientes en la cola: dibujados = encolados (S2, handleStreamEnd).
  No hay conteo mínimo ni constante de tiempo.
- **Línea base 56644d79**: falla, 0 (el puente arranca tarde; `re-generacion-gap.md` §2.3).
- **Fuentes**: DS + SC (una captura por lote).

### A4. Cada estado de carga de S3 aparece y desaparece en su momento
- **Contrato que pido a UI** (S3): el nodo raíz de cada estado lleva `data-wt-loading="<fila>"` mientras está visible (fila = número de `viabilidad/ui.md`). Sin ese atributo, el estado se mide por selector a mano y queda NO CONCLUYENTE si el selector cambia.
- **Mide**: DS en el builder. Por fila se registra la ventana `[aparece, desaparece]` y se cruza con su disparador en RL.

| Fila | Disparador (RL) | Pasa si |
|---|---|---|
| 13 puntos de pensando | `message.start` → `message.end` | visible todo el turno, como la pastilla de Stitch (`ie = re && !b && !r`, DP:49116-49117; `re` = sesión RUNNING, DP:48997-49003) |
| 10 tips | turno corriendo | cambia cada 12 s ±1 s; orden distinto en dos corridas; desaparece en settled |
| 22 skeleton | antes del primer render del preview | desaparece ≤500 ms después de que A1 detecta la primera sección |
| 23 barra de progreso del preview | carga del preview | 0 → 100 y se oculta |
| 18 título con shimmer | turno activo | shimmer solo mientras corre; estático en settled |
| 19 agentPendingEnter | mensaje enviado → primer evento | solo en esa ventana |
| 24 auto-follow del chat | eventos nuevos | el scroll del chat sigue al último evento salvo que el usuario haya subido |
| 6 draw overlay | lo mide A3 | — |
| 9 toast 10 s | settled | aparece en settled; "View" solo si el frame está fuera de vista (DS mide la intersección del frame); se va a los 10 s ±1 s |
| 25 notificación del navegador | settled | solo con `document.hidden` y permiso. Se fuerza con otra pestaña activa vía CDP; con la pestaña visible, 0 notificaciones |
| 8 cámara (ola 3) | pantalla nueva | animación de 600 ms ±100, zoom ≤1 |
| 20 vista larga de carga (ola 3) | según DP:6380-6430 | aparece y se va con su disparador |
| 16/17/21 mapa de tools y ETA (ola 3) | eventos de S4 | cada tool pasa de pendiente a hecho en el orden del RL |
| 5 reveal de imagen (ola 3) | slot de imagen resuelto | la imagen entra con su reveal, no de golpe |

- **Umbral**: pasa cada fila de la ola que se cierra; las filas de olas futuras no se miden.
- **Fuentes**: DS + RL + SC (captura de cada estado visible).

#### Procedimiento A4
Precondición: pestaña visible (ver arriba). DS muestrea el builder cada 250 ms y registra, por cada nodo `[data-wt-loading]`, la fila y el detalle que su criterio necesita: texto en 10 y 18; ancho de `.previewProgressBar` y `data-done` en 23. Esa es la resolución: una ventana se reporta como `[primera muestra con la fila, primera muestra sin ella]`, ±250 ms. Excepción, fila 23: dura menos que una muestra, así que DS además instala en el builder un MutationObserver sobre el nodo de la fila (alta, baja, `style.width` y `data-done` de la barra) y registra cada cambio con su hora (`ev: bar23`). Pasa si antes de la baja hay un registro con 100 % o `data-done`; si se da de baja sin completar, FALLA.

Por fila (ola 1 y 2):
- **13** (`agent-panel.tsx`, `AgentPill`, `data-wt-loading` mientras `thinking`): ventana contra RL, de `message.start` a `message.end`. Pasa si aparece dentro de 250 ms del envío y se va dentro de 250 ms de `message.end`. En Stitch solo la apagan una aclaración abierta o un steer que reemplaza el turno (DP:49116-49117), y ninguno de los dos ocurre dentro de nuestro turno.
- **18** (`agent-panel.tsx`, línea de estado con shimmer): existe solo con el turno corriendo, sin `updates` y sin `body`. Pasa si su ventana está dentro de [envío, primer `step.start` o `text.delta`] y en la muestra de `settled` no hay ningún 18. Cada cambio de texto se reporta con su `at`: es el `statusLine` que cambia.
- **10** (`chat-panel.tsx`, `RotatingTip`, `TIP_MS = 12_000`): cada cambio de texto es un cambio de tip. Pasa si cada intervalo entre cambios es 12 s ±1 s, ningún tip repite el anterior (`nextTip`) y en `settled` no hay ningún 10. El orden distinto entre dos corridas se compara con la secuencia de textos del T1 anterior; con una sola corrida es NO CONCLUYENTE para esa parte.
- **22** (`artboard-canvas.tsx`, skeleton del frame sin url): cruce con A1. Pasa si la última muestra con 22 es ≤500 ms antes de la primera muestra de A1 con ≥1 sección en el mismo frame. Con 250 ms de resolución, una diferencia de 500-750 ms se reporta como NO CONCLUYENTE y no como falla.
- **23** (`artboard-canvas.tsx`, `PreviewProgress`): pasa si, por cada carga del preview (cada contexto nuevo de CC), el ancho sube de forma monótona, llega a `100%` con `data-done` y el nodo desaparece. El nodo se desmonta `PROGRESS_EXIT_MS` después de `data-done`. Un ancho que baja sin una carga nueva en medio falla.
- **24** (`agent-panel.tsx`, `useAutoFollow`, `data-wt-loading` mientras `working`): DS registra la ventana. El seguimiento lo mide SC: en cada captura con 24, el último evento del chat está visible. Si el usuario hizo scroll, se reporta aparte (en el arnés nadie hace scroll).
- **19**: cerrada sin código (`bb0125d`); no se mide.
- **9** y **25**: sin `data-wt-loading` todavía; NO CONCLUYENTE hasta que UI los marque.

Ola 3 (8, 20, 16/17/21, 5): se agregan aquí cuando UI ponga su `data-wt-loading`, con el mismo formato: archivo y componente, qué detalle registra DS y contra qué evento del RL se cruza. Hasta entonces no se miden.

### A5. 0 errores de hooks y 0 pill de error al final
- **Mide**:
  - en CC, todo el turno: `Invalid hook call` y `TypeError … reading 'useState'`;
  - en VL: re-optimización de deps (`new dependencies optimized` / `optimized dependencies changed`);
  - en DS del builder, al llegar `settled`: presencia de la pill de errores del preview, con la regla de #413 (no cuentan los errores anteriores al último update de HMR).
- **Umbral**: pasa con 0 errores de hooks durante todo el turno, 0 re-optimizaciones con la página cargada y 0 pill al final. Los errores transitorios de HMR a mitad de escritura (`X is not defined`, 500 de un módulo) se reportan pero no fallan el caso si no queda pill.
- **Línea base 56644d79**: pasa (#424).
- **Fuentes**: CC + VL + DS.

### A6. Los follow-ups F1a-F1d siguen pasando
| Paso | Pasa si | Fuente |
|---|---|---|
| F1a titular | toca solo `02-hero.tsx`; texto exacto | RL (escrituras) + DS (texto del h1) |
| F1b acento azul | `--accent` #2563eb en `identity.css`; WhatsApp sigue verde | RL + DS (computed style) |
| F1c mockup WhatsApp | foto del hero conservada; `[data-skin="whatsapp"]` dentro del hero; fondo #efeae2, burbujas #d9fdd3 y blanco; sin desborde a 375; **#2563eb sigue** | DS a 1440 y 375 + SC |
| F1d reorden por sectionOp | cambia solo el orden en App.tsx y page-plan.md; sin renombrar archivos; sin modelo | RL + diff del workspace |
| Todos | message.end → suggestions → settled como último evento (#394); sectionOp y AutoFix pueden cerrar sin suggestions | RL |

- **Umbral**: pasan las 5 filas. Además, A2 y A5 se aplican también a cada follow-up.
- **Línea base 56644d79**: pasa (`viabilidad/qa.md` y el reporte QA del 2026-11-02).

#### A6 ampliado (S4 y S5): follow-ups G1-G3 y criterio por campo

# A6 con el trace de S4: follow-ups y criterio (para integrar en arnes.md; sin commit)

## 1. Follow-ups sobre el T1 de las 13:12

Los F1a-F1d no cambian (mismos mensajes que en 56644d79, `planes/qa-guion-perf.md` fila F1a-F1d). Se suman tres, después de F1d, en el mismo chat y en este orden. F1d es un sectionOp sin modelo: no deja trace, así que G1-G3 no dependen de él.

| Id | Mensaje (tal cual) | Qué ejercita |
|---|---|---|
| G1 | `Cambia el titular del hero por: "Atiende, vende y cobra por WhatsApp"` y `el texto del botón principal por "Hablar con ventas"` en el mismo mensaje | agent.trace.context en un follow-up; dos `edits[]` (o dos pasos Edit) en `02-hero.tsx` |
| G2 | `Cambia la foto del hero: que sea un equipo de ventas mirando el celular, con luz cálida` | aprobación `spend` (kind spend) fuera del T1; `edit_image` o `generate_image` |
| G3 | `Aprueba` / `Permite siempre` en la tarjeta de G2 (acción de QA, no mensaje) | `approval.decision` allow o always, y que un segundo cambio de foto no vuelva a pedir si fue "siempre" |

Precondiciones (si falla una, el caso queda NO CONCLUYENTE, no FALLA):
- El T1 de las 13:12 se lanzó con `imageGeneration` (modelo de imagen elegido) y permiso en modo con aprobación. Sin eso el agente no tiene `generate_image` (`imageTool = gen && imageGeneration && approval`, agent-composer.ts).
- `edit_image` existe solo con `WT_IMAGE_PROVIDER=gateway` y sigue pendiente saber si `bfl/flux-3-image-klein` declara `supportsFileInputs === true`. Con provider cli o sin soporte, el agente usa `generate_image` o recibe el error de texto de edit_image: cualquiera de las dos dispara la tarjeta spend. El criterio de G2 acepta las dos tools.
- G2 gasta créditos de imagen: lo corre Orq con su OK local. No lo lanza QA.
- G2 necesita que el hero tenga una foto (F1c conserva la del hero). Si el T1 no generó foto, G2 hace que el agente genere una nueva.

## 2. Criterio de A6 para el trace (texto para arnes.md, después de la tabla de F1a-F1d)

| Paso | Pasa si | Campo del RL (`logs/<messageId>.ndjson`) contra qué |
|---|---|---|
| Contexto de cada follow-up con modelo (F1a, F1b, F1c, G1, G2) | `agent.trace.context` existe; `ratio` < 0,05; `floorTokens` entre 15 000 y 25 000 (base 56644d79: 18 768-19 013; con el DS precargado, ~41 000 en el T1) | `.wt/page.json` del commit del follow-up (`agent.trace.context.{ratio, floorTokens, lastTokens, window}`) contra `python3 -I ctx-per-turn.py <ws>/.wt/agent-stream.ndjson`: first = floorTokens, last = lastTokens, ratio = last/1 000 000 con 3 decimales. Debe coincidir exacto |
| T1 | `agent.trace.context` existe; `ratio` entre 0,05 y 0,2 (referencia 0,114) | igual que arriba, solo informativo: el umbral de 0,05 es de follow-ups |
| F1d (sectionOp) | `agent.trace.context` ausente | page.json: sectionOp no llama al modelo; que exista sería un falso positivo |
| `tool` en cada paso del agente | todo `step.start` con `parentStepId === "agent:write"` trae `tool` no vacío; los Read/Write/Edit/Glob/Grep/Bash llevan ese nombre y los MCP el nombre sin `mcp__wt__` | RL `step.start.tool` contra el `name` del `tool_use` en `agent-stream.ndjson` (mismo orden, mismo `id`) |
| `edits[]` | todo `step.end` de un Edit trae `detail.kind="write"`, `detail.op="update"` y `detail.edits` con `before` y `after` no vacíos; un Write trae solo `after`; `truncated` solo si algún lado pasó de 4000 caracteres | RL `step.end.detail.edits` contra `input.old_string/new_string` del `tool_use` en `agent-stream.ndjson`, y `before` contra el texto del archivo en el commit padre (`git show <padre>:<ruta>`): el `before` debe estar contenido |
| F1a titular (G1 igual) | además: el `after` del Edit del h1 contiene el titular exacto | RL `edits[].after` + DS (texto del h1) |
| Aprobación spend (G2) | existe `approval.request` con `kind: "spend"` y `toolName` `mcp__wt__edit_image` o `mcp__wt__generate_image`, antes del `step.end` de esa tool; si hay `approval.decision` es `allow` y llega entre el request y el `step.end`; el paso lleva `tool` = `edit_image` o `generate_image`; `step.end.detail.kind` = `tool` | RL (`seq` de request < decision < step.end). El `toolName` del request debe coincidir con el `name` del `tool_use` en `agent-stream.ndjson` |
| G3 | tras elegir "siempre", un segundo pedido de foto en el mismo chat no genera `approval.request` y su tool corre | RL del segundo pedido sin `approval.request` |
| Salida de la tool de imagen (G2) | `step.end` con status ok y texto con `src="/images/…"`; ningún bloque de imagen en el log (solo texto) | RL `step.end.detail.output`; que el archivo exista en `public/images/` del commit |
| Todos | message.end → suggestions → settled como último evento (#394) | RL (ya en A6) |

- **Línea base**: contexto y `tool`/`edits[]` no existen en 56644d79 (sin S4); la comparación del contexto es contra `ctx-per-turn.py` sobre el stream crudo del mismo turno, no contra otro commit. Las filas de F1a-F1d (texto, archivos, estilos) conservan su línea base.
- **NO CONCLUYENTE**: workspace sin `.wt/agent-stream.ndjson` (el cruce no se puede hacer); bench sin 126bbbe (no hay trace); G2/G3 sin imageGeneration o sin provider gateway cuando se exigía edit_image.
- **Fuentes del dato**: RL + `.wt/page.json` + `.wt/agent-stream.ndjson` + commit del workspace. Las dos últimas no estaban en la tabla de Fuentes: agregar `PJ` (page.json) y `AS` (agent-stream.ndjson), de solo lectura.
- **Fundamento**: A6 y su trace son de S4 (126bbbe; extracts en la spec): contexto MAKE-CHAT:32541 y :40269, V0:56042; edits MAKE-CHAT:40042-40063; tool V0:13738-13750. Son observación (regla 8), no fundamentan código.

### A7. Imagen generada por el agente (S5)
Se mide en un T1 donde el agente llama a `generate_image` (S0).
- **Mide**:
  - en RL, el step de `generate_image` con su `at` y su `detail.input` (`prompt`, `target_path`). En un T1, que no haya `approval.request` para esa tool (preaprobada, S5 reglas 1 y 10). En un follow-up, `approval.request` con `kind: 'spend'` y su `approval.decision` antes del step, salvo que el chat ya tenga un "siempre";
  - en DS, el `src` de la `<img>` del slot o del hero en cada frame: cuándo pasa de pendiente o placeholder a la imagen final, con `naturalWidth > 0`;
  - en CC, contextos nuevos del frame entre la escritura del archivo de imagen y su aparición.
- **Umbral**: pasa si
  - la imagen queda en el hero;
  - el step de `generate_image` en RL lleva `prompt` y `target_path` (T1: sin `approval.request`; follow-up: request spend + decision allow, o "siempre" vigente). Fuente: en Lovable `approvedDisplay` es de la tarjeta que sí se mostró (registry :4836-4866) y el T1 con imagen no deja registro de aprobación (ZAP 1854, 0 apariciones de "approv"); nuestro rastro es el step de la tool (approvals.ts :83-92, agent-stream.ts :182);
  - la imagen de un slot o de `generate_image` **se ve en el preview sin recargar**: 0 contextos nuevos del frame en esa ventana y `naturalWidth > 0` en DS. El shim de Image difiere el `src` y el puente lo aplica con `wt:images-ready` (S2, vr-runtime :583-590, :3129-3131).
- **Línea base 56644d79**: no aplica (sin `generate_image` en ese T1).
- **Fuentes**: RL + DS + CC; SC con la imagen visible.

### A8. Variantes en paralelo (S5, variantes como Stitch)
Se mide en un turno de variantes con `variantCount` = N ≥ 2 sobre una pantalla fuente.
- **Extract**: `re-iteracion/re-variantes/README.md` §5 (ZAP 26790, N=2): una sola sesión; N `edit_html_full_regen` en curso a la vez desde el primer snapshot; N pantallas placeholder en el componente `design` antes de cualquier HTML; el HTML de las N crece alternado; el orden de llegada al lienzo es el de creación, y el de fin es otro (V2 antes que V1). Lienzo: §4, SideBySide a 64 px a la derecha de la fuente (I18nStore :22402-22502). ZAP guarda una sola hora por cuerpo, así que **el extract da orden, no tiempos**: este caso no tiene umbrales de tiempo.
- **Mide**:
  - RL: un solo turno con `variantCount`; por variante, su prompt, su primera escritura, su última escritura y su fin;
  - DS en el builder: los marcos de variante en el lienzo (placeholder o con preview), su orden y su posición respecto de la fuente;
  - CC: contextos nuevos de cada frame de variante, con su `at`;
  - SC: una captura con los N placeholders y otra al terminar.
- **Umbral**: pasa si se cumplen las 5:
  - (a) los N placeholders están en el lienzo antes de la primera escritura de cualquier variante en RL;
  - (b) concurrencia: con N ≥ 2, la primera escritura de cada variante k > 1 ocurre antes del fin de la variante k-1. Si una variante empieza después de que terminó la anterior, es serie y falla;
  - (c) el orden en el lienzo es el de creación (V1, V2, …) y no cambia aunque terminen en otro orden;
  - (d) 0 recargas cruzadas: ningún contexto nuevo en el frame de una variante coincide con una escritura de otra variante. Cada frame, además, cumple A2 contra sus propias escrituras;
  - (e) los N marcos quedan en una fila a la derecha de la fuente, separados por 64 px en coordenadas del lienzo, y al terminar la cámara llega a ellos.
- **Hueco declarado (sin extract)**: si una variante falla o se cancela, no se sabe si las otras siguen; en ZAP 26790 terminaron las dos. Una falla parcial se reporta con lo que pasó en las otras, sin veredicto, hasta tener un extract.
- **Línea base**: no aplica (no hay variantes en paralelo implementadas).
- **Fuentes**: RL + DS + CC + SC.

## Fundamento de los umbrales
Cada umbral sale de un mecanismo con extract o de un contrato de una spec. No hay constantes de tiempo inventadas.

Rutas y versiones de las citas:
- **vite:** el que corre el preview, templates/arc-scaffold/node_modules/vite **8.3.4**, fijado en templates/arc-scaffold/bun.lock:343, archivo dist/node/chunks/node.js. El builder usa 8.3.5; esas líneas no aplican al preview. Cada cita lleva su símbolo para que siga valiendo si el lock cambia de versión:
  - :25505 = rama `type === "create"` que suma `_hasResolveFailedErrorModules`;
  - :26631 = `_hasResolveFailedErrorModules.add`;
  - :25628-25629 = `isClientHtmlChange` y `needFullReload`;
  - :25662 = `propagateUpdate`;
  - :35777-35782 = `logOptimizeDepsIncludeSuggestion`.
- **R:** stitch-ui/bundles-2026-11-02/UgcTrustBanner-ClT5SnxT/renderer/webcrack/deobfuscated.js, que no es el U de UgcTrustBanner-ClT5SnxT/webcrack/:
  - :1001 = `handleStreamEnd`;
  - :194-198 y :458 = `elementAnimationCounts`;
  - :211, :257, :344 = `moveCursor`.
- **LEDB:** lovable-details/deob/editor-body-shared-S4BNvRla.deob.js.
- **DP:6438:** stitch-ui/deob-2026-11-02/webcrack/DesignPage-s8oa9o80/deobfuscated.js ("Estimated time").
- A1: vite 8.3.4, un update por archivo creado (`node.js:25505`), más S1.
- A2: vite 8.3.4, `.html` y propagación sin frontera llevan a full-reload (`:25576-25583`, `:25604-25636`, `:25662-25700`).
- A3: renderer de Stitch, R l.240-248, 458-462, 478-481, 1001-1017.
- A4: las filas de S3, cada una con su extract.
- A5: #413 (regla de errores anteriores a un update) y #424 (vite `node.js:35777-35782`).
- A6: comportamiento funcional de main 4abe005; es una regresión, no una medida de tiempo.
- A7: S5.

**Tiempos:** el tiempo hasta la versión del T1 y de cada follow-up se registra en cada corrida como **observación**. No hay guard de tiempo que haga fallar un caso. Ninguna referencia tiene un presupuesto de tiempo en su código: las estimaciones de Lovable (LEDB:321-349) y de Stitch (DP:6438, "Estimated time") son texto de UI, no un gate. La guía de web.dev sobre presupuestos (https://web.dev/articles/performance-budgets-101) tampoco fija un presupuesto relativo a una línea base.

## Reporte por corrida
`re-iteracion/arnes/<chatId>.md`, con:
- una tabla A1-A6: PASA / FALLA / NO CONCLUYENTE, el valor medido contra el umbral y la fuente con su archivo;
- las capturas en `re-iteracion/arnes/<chatId>/`.

Un caso NO CONCLUYENTE no cierra el ítem.

## Lo que necesito de otros
- **Orq (S0)**: VL antes del próximo T1, y avisarme el chatId antes de enviar el brief, para enganchar CC/DS desde la carga.
- **UI (S3)**: el atributo `data-wt-loading="<fila>"` de A4.
