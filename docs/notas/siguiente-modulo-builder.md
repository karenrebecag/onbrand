# Siguiente módulo: builder (D4), orden propuesto

Arq, 2026-11-04, main al día. Una página, sin specs. Para cada unidad: qué es, con qué cita, qué refactor de C va
antes y si hace falta una decisión. Mapa = `re-iteracion/onbrand-mapa-replicacion.html` (citado por sección).

## Lo que ya no hace falta (el mapa está atrasado respecto de main)

El mapa marca como pendientes o parciales varias filas que ya están en main. No se rehacen; QA actualiza el mapa:

| fila del mapa | dónde está en main |
|---|---|
| §10 "Fotos de variante visibles" (FALLA, cache-bust) | `artboard-canvas.tsx:401-402` (postMessage de bust a cada marco) |
| §11 "Notificación nativa" (parcial, decide Karen) | `lib/use-done-notification`; el permiso sale de un gesto (`chat-panel.tsx:223,308`) |
| `viabilidad/ui.md` #2 tope de 2 animaciones, #4 z-index, #5 reveal de imagen | `wt-reveal-bridge.ts:13,116-119`, `:227`, `:71` |
| `viabilidad/ui.md` #8 cámara animada | `artboard-canvas.tsx:176-180` |
| §11 fila 19 (agentPendingEnter) y fila 20 (vista larga) | sin código: la 19 está cerrada; la 20 está montada en un memo muerto que no sale en prod (`re-fila-20/fila-20-long-loading-view.md`, DP :6378-6430). Se cierra |

Lo que entró hoy y condiciona el orden: #648 (`Off` en su propio átomo), #649 (un solo escritor de CanvasDoc,
`lib/canvas-writer.ts`), #650 (artboard-canvas extrae progreso y marco de variante), #666 (fuera el alto fijo), #661
(descarga del export) y #663 (sesión rechazada con copy propio).

## Orden

| # | unidad | cita | refactor de C antes | decisión |
|---|---|---|---|---|
| 1 | **Selección por rectángulo + menú del lienzo.** Rescatar `feat/builder-canvas-selection` (local, sin push, 2026-10-30): `fa56ace0` + `d363172c`, que cierra G5 (sin "Agregar texto", porque no hay extract del handler) y G6 ("Ordenar" como Format de Stitch) | mapa §5, fila "Selección rectángulo"; `planes/ui.md:12,26-27,49-52`; Stitch SRT §3d (DP l.58620, 58799, 48775) | La rama suma unas 80 líneas a `artboard-canvas.tsx` (754 hoy), así que pasaría de 800 (A1). Primero se extrae la capa de selección (rect y menú) a su propio componente. El estado de selección no va a `use-builder.ts` (693). La escritura de nodos pasa por `canvas-writer` (#649, A9) | ninguna: G5/G6 ya están resueltos en la rama siguiendo B6 |
| 2 | **Nombre de la pantalla encima del marco** (G6b) | `planes/ui.md:53-55`; DP wakaru l.32512 (pintado) y l.10017 (label por defecto) | Va después de la extracción de 1, porque toca el mismo archivo | ninguna. La colocación no tiene extract y queda la nuestra (fija encima del marco) |
| 3 | **Edición directa, abiertos menores:** la 1ª edición con vite recién arrancado recarga entera; `freshTscError` mudo (y descarta+reaplica si tsc falla); quitar una sección deja 2×404 en la consola del iframe; `replaceImage` sin medir | mapa §5, fila "Edición directa llega por HMR", columna "Qué sigue" (QA 2026-11-04 sobre dc5de86d) | Primero QA reproduce cada uno, porque hoy están "leídos, no reproducidos". Lo que salga del runtime va a ec, y en UI solo el copy del error de tsc. `run-client.ts` (693) no suma: un estado nuevo va en `run-state` | ninguna |
| 4 | **Chips de follow-up al cerrar un grupo de variantes.** Stitch los numera sobre el prompt al terminar Variations. Hoy `suggest` corre por mensaje (#394), no por grupo | `stitch-ui.md` §5 (D nuevo, `d-11-variants-final.png`); mapa §9 no lo cubre; `src/runtime/variants.ts` no llama a suggest | Ninguno en el builder (`next-steps.tsx` es chico). En el runtime, el disparo va en el cierre del grupo, con su id de generación (A7) | **gasto:** una llamada de haiku más por grupo. OK de Karen u Orq por delegación |
| 5 | **Deshacer.** Hoy deshacer = restaurar la versión del padre (QA paso 8, 1 s). El undo de Stitch son 100 snapshots en memoria que se pierden al recargar | mapa §5, fila "Undo por operación inversa"; `stitch-ui.md` §2 #13 y §3.3 | Ninguno si se elige (a) | **Karen:** (a) un atajo ⌘Z/botón que restaura el padre: persistente, S, sin código nuevo en el runtime; o (b) operación inversa por edición directa: M, y duplica lo que ya hace el restore. Recomiendo (a) |
| 6 | **Cierre del mapa** (la tabla de arriba) | este documento | — | ninguna; QA, sin código |

## Estado al cierre (QA, 2026-11-04, main 1431c53f)

| # | estado | evidencia |
|---|---|---|
| 1 | Hecha | Capa propia fuera de `artboard-canvas`: `canvas-selection.tsx` y `canvas-context-menu.tsx` (#691); atajos en `lib/use-canvas-keys.ts` (#677, #697) |
| 2 | Hecha | Nombre de la pantalla encima del marco (#700) |
| 3 | Reproducida en vivo con el builder sobre un clon del chat real de wt-ui (11 secciones, main b015eb84) | (a) 1ª edición con vite recién arrancado: no reproduce, 2/2 por HMR con estado. (b) Paso mudo: sí, replaceImage y sectionOp pasan 13,3-13,7 s sin ningún evento; el tsc del ws tarda 13,4 s y `stepAsync` emite `step.start` al terminar (`shared.ts:436-442`). Test `tests/step-async-start.test.ts` (failing, ec). El descarta+reaplica con tsc roto no se pudo forzar: borrar una img importada da 409 antes de llegar a tsc. (c) Duplicar o quitar una sección en una página de varias renombra las de abajo (`03-features.tsx` → `04-features.tsx`): el iframe se recarga entero y llegan al builder como `wt:runtime-error` errores "[vite] Failed to reload …" que no existen. Test `tests/section-op-sin-renombrar.test.ts` (failing, ec). (d) replaceImage medido: 13,5-13,7 s por el tsc, entra por HMR con estado, con y sin builder. Nada de esto va a UI salvo el copy del paso cuando ec lo emita |
| 4 | Pendiente | Espera el OK de gasto |
| 5 | Hecha por (a) | ⌘Z / ⇧⌘Z restauran el padre y el hijo (`use-canvas-keys.ts:20`; `App.tsx:47-49` llama a `builder.restore`) |
| 6 | Hecha | Mapa actualizado con citas de main (backups `.bak-2026-11-04-qa` y `-qa2` junto al HTML) |

Paralelo, sin bloquear: 6 en cualquier momento. 1 y 2 en serie (el mismo archivo). 3 empieza con QA mientras corre 1.
4 espera el OK de gasto; 5, la elección de Karen.

## Fuera de este módulo

- `viabilidad/ui.md` #7, el stream hook con throttle de 300 ms (L): depende de las causas §2 de `re-generacion-gap.md`, que
  no son de UI.
- #21, los pasos con ETA de Lovable: cerrado por la decisión de Orq del 2026-11-02 (tiempo transcurrido, mapa §11).
- Las tarjetas de identidad (login y 401) ya entraron con #663. Las fases 2-5 de identidad siguen su spec.
