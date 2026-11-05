# Selección por rectángulo y menú del lienzo (unidad 1 del módulo builder)

Estado: DECIDIDA [KAREN:chat 2026-11-04 "el resto, ocupate"; delegada a Orq] (Arq, 2026-11-04). Implementa: UI, en tres PRs (§4).
Base: `docs/notas/siguiente-modulo-builder.md` (unidad 1), rama local `feat/builder-canvas-selection` (`fa56ace0`
selección y menú; `d363172c` Ordenar como Format de Stitch, sin Agregar texto; 2026-10-30, sin push).
Extract: `re-iteracion/stitch-ui/static-rail-tools.md` §3d (DP = `deob/wakaru/DesignPage-DeNbrR8l.js`).

## 1. Qué se rescata y qué cambia

La rama funciona (captura `seleccion-menu/1-5`, `planes/ui.md:26-27`), pero no se puede rebasar tal cual:

- Suma unas 80 líneas a `artboard-canvas.tsx`, que mide 754 hoy, y lo pasaría de 800 (A1).
- El menú muestra ⌘V y ⇧⌘F, pero `useCanvasKeys` (`artboard-canvas.tsx:209-232`) no los ata: es un atajo que se
  anuncia y no existe.
- Es anterior a #649: sus escrituras ya pasan por `useCanvasNodes.change` → `canvas-writer`
  (`use-canvas-nodes.ts:90-112`), pero eso hay que verificarlo después del rebase y fijarlo con un test.

Se rescata el comportamiento, no el diff. `canvas-nodes.ts` (`rectFrom`, `nodesInRect`, `formatNodes`) y
`canvas-context-menu.tsx` entran casi sin cambios. Lo que la rama metía en `artboard-canvas.tsx` va a un módulo propio.

## 2. Comportamiento (fiel a Stitch §3d)

| gesto | qué pasa | cita |
|---|---|---|
| Arrastrar con la herramienta Seleccionar (botón izquierdo) sobre el fondo | Rectángulo de selección. Entra todo nodo que toque, aunque sea en parte | `selectionOnDrag`, `selectionMode=Partial` (DP l.58799) |
| El mismo arrastre con Shift o Meta | Suma a la selección que había al empezar | `multiSelectionKeyCode=[Shift, Meta]` (DP l.57929) |
| Botón del medio | Mueve la cámara con cualquier herramienta | `panOnDrag=[1]` (DP l.58799). Ya está (`artboard-canvas.tsx:597`); el rectángulo no lo toca |
| Clic derecho en el fondo | Menú del lienzo en el punto del clic | `onPaneContextMenu` → `Yj` (DP l.58627-58660, l.48775) |
| Clic derecho en una imagen | Si está en una selección múltiple, la conserva; si no, elige solo esa. El menú de nodo no se abre, porque no hay extract de sus comandos | `onNodeContextMenu` (DP l.58627-58660) |
| Menú del lienzo | En el orden de Stitch: Deshacer ⌘Z · Rehacer ⇧⌘Z / Pegar ⌘V / Ordenar ⇧⌘F / Agregar ▸ Subir archivo. Sin "Agregar texto", porque no hay nodo de texto (`textNode` apagado, DP l.48839, l.58854) ni Debug | DP l.48775 |
| Ordenar | Las imágenes van en filas debajo de los marcos (64 px entre nodos, 64 + 80 entre filas, filas de hasta 5000 px) y la cámara encuadra todo. Los marcos no se mueven: es una divergencia propia, porque en el builder los marcos son fijos | `SA`/`wA` (DP l.46139-46181, l.46238); `formatNodes` en la rama |
| Pegar | Pega las imágenes del portapapeles en el punto del menú, o en el del puntero con ⌘V. Si no hay imágenes, el toast lo dice; si el navegador no deja leer el portapapeles, también | DP l.58660 (`openFileDialogAt`), la misma colocación |

**Deshacer en este menú** es el de la página: restaura la versión del padre (decisión 5a de la nota, ya cableado como
`history`, `App.tsx:47`). Mover, ordenar o borrar imágenes **no** deja un paso que deshacer. Stitch sí lo deja
(`takeSnapshot` en `onSelectionDragStart`, DP l.58620), pero ahí el undo vive en memoria y se pierde al recargar
(`stitch-ui.md` §2 #13). Esto se anota como divergencia; no es objeto de esta spec.

## 3. Módulo y contrato

`apps/builder/src/components/builder/canvas-selection.tsx` (nuevo) y `apps/builder/src/lib/use-canvas-keys.ts`
(nuevo: `useCanvasKeys` sale de `artboard-canvas.tsx:205-232` tal cual, en un PR mecánico, B1).

```ts
// canvas-selection.tsx
interface CanvasSelectionDeps {
  readonly viewport: RefObject<HTMLElement>        // para pasar de px de pantalla a px locales
  readonly toWorld: (p: Point) => Point            // de la cámara de artboard-canvas, por getter
  readonly tool: () => CanvasTool                  // getter: la herramienta cambia sin remontar
  readonly frames: () => readonly Frame[]          // para el origen de Ordenar
  readonly fit: (id?: string, extra?: readonly Rect[]) => void
  readonly images: Pick<CanvasNodes, 'nodes' | 'selected' | 'ready' | 'selectMany' | 'clearSelection' | 'format' | 'notify' | 'upload'>
  readonly history: History
}
// Devuelve los handlers que artboard-canvas monta en el fondo, y el nodo a pintar (rectángulo + menú).
export function useCanvasSelection(deps: CanvasSelectionDeps): {
  onPanePointerDown, onPanePointerMove, onPaneContextMenu, endGesture, paste, format, layer: ReactNode
}
```

- **Estado propio y local:** el rectángulo en curso (`{ pointerId, start, base }` en un ref, y la banda en state solo
  para pintarla) y el punto del menú. Nada de esto se persiste ni va a `use-builder.ts` (693, C: quien lo toque no
  suma).
- **Qué escribe:** nada directo. La selección pasa por `images.selectMany` (estado de `useCanvasNodes`), y
  Ordenar, Pegar y Subir pasan por `images.format`/`images.upload`, que escriben por `change` → `canvas-writer`
  (A9, #649). La capa no importa `run-client` ni `canvas-writer`.
- **Eventos que emite:** ninguno al runtime. Al builder solo le llega lo que `useCanvasNodes` ya guarda.
- **A3:** deps explícitas, `Readonly`, y la cámara y la herramienta por getter, sin capturar la referencia (A2, la
  trampa de #555). **A4:** `canvas-selection` importa tipos de `artboard-canvas` (`import type`) y valores solo de
  `lib/`; `artboard-canvas` importa el hook. No hay ciclo de valores.
- **Atajos:** `use-canvas-keys.ts` suma ⌘V → `paste` en el último punto del puntero y ⇧⌘F → `format`. Los dos se
  ignoran mientras se escribe (`typing(e.target)`), como los demás.

## 4. Límites (A1)

| archivo | hoy | después | regla |
|---|---|---|---|
| `artboard-canvas.tsx` | 754 | ≤ 740: pierde `useCanvasKeys` (~28) y gana el montaje del hook (~15) | ≤ 800, sin sumar neto |
| `canvas-selection.tsx` | — | ≤ 200 | 200-400 |
| `use-canvas-keys.ts` | — | ≤ 80 | |
| `canvas-context-menu.tsx` | — (rama 66) | ≤ 100 | |
| `canvas-nodes.ts` | 74 | ≤ 120 (+`rectFrom`, `nodesInRect`, `formatNodes`) | |
| `use-canvas-nodes.ts` | 169 | ≤ 190 (+`selectMany`, `format`, `notify`) | |

Orden de PRs: (1) mecánico, `useCanvasKeys` a su archivo con diff de cuerpo = 0; (2) la capa y el menú con sus
tests; (3) los atajos ⌘V y ⇧⌘F.

## 5. Tests (uno por comportamiento, `tests/builder-canvas-*.test.ts`)

1. `nodesInRect`: un toque parcial entra; uno pegado al borde (sin solapar) no; el rectángulo funciona en cualquier
   dirección del arrastre (`rectFrom`).
2. `selectMany` con base: Shift conserva lo de antes; sin Shift, lo reemplaza.
3. `formatNodes`: filas por y con tolerancia de 50; salto de fila al pasar 5000; 64 entre nodos y 144 entre filas;
   no muta la entrada (inmutabilidad).
4. Ordenar escribe una sola vez por `canvas-writer`, con el rev leído (fake writer: un `write`, sin PUT directo).
5. Clic derecho sobre una imagen de una selección múltiple la conserva; sobre otra, elige solo esa.
6. Pegar sin imágenes → toast `No hay imágenes en el portapapeles`; con `clipboard.read` rechazado → `El navegador no
   dejó leer el portapapeles`. No hay escritura en ninguno de los dos casos.
7. Atajos: ⌘V y ⇧⌘F llaman a `paste` y `format`; con el foco en un input, no.
8. Guarda estática (B3): `canvas-selection.tsx` no importa `run-client` ni `canvas-writer`.

UI: captura antes y después de rectángulo, menú, Ordenar y Pegar (sin tests de snapshot).

## 6. Fuera de alcance

- Menú de nodo y de selección de Stitch (grupos CLIPBOARD, ALIGN, ARRANGE…): no hay extract de sus comandos.
- Nodos de texto ("Agregar texto", G5).
- Undo de las operaciones sobre imágenes (§2, divergencia anotada).
- Mover los marcos con Ordenar.
