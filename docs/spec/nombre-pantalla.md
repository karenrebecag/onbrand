# Nombre de la pantalla encima del marco (unidad 2 del módulo builder, G6b)

Estado: DECIDIDA [KAREN:chat 2026-11-04 "el resto, ocupate"; delegada a Orq; opción (a) fiel a Stitch] (Arq, 2026-11-04). Implementa: UI, tras seleccion-lienzo.
toca el mismo archivo.
Base: `docs/notas/siguiente-modulo-builder.md` (unidad 2), `re-iteracion/planes/ui.md:53-55` (G6b).
Extract: `re-iteracion/stitch-ui/deob/wakaru/DesignPage-DeNbrR8l.js` (DP).

## 1. Qué hace Stitch y qué hacemos hoy

- **Stitch:** encima de cada nodo de pantalla pinta `label || !Qe && 'Screen'` (DP l.32512; `Qe` = prototipo, que
  tiene su propia rama `Prototype : …`, l.32505-32511). El label del dato del nodo es `i?.label || o.title || 'Screen'`
  (DP l.10017): primero el nombre que le dio la persona, después el título de la pantalla y, si no hay ninguno,
  `Screen`. Las dimensiones van aparte, en el badge de tamaño de la selección (`stitch-ui.md` §2 #1).
- **Nosotros:** la etiqueta ya existe y ya está fuera del mundo escalado (`artboard-canvas.tsx:688-694`,
  `.artboardLabel` en `builder.module.css:17`, con elipsis). Pero los marcos de la página dicen el **dispositivo**
  (`Escritorio` / `Móvil`, `artboard-canvas.tsx:36-37`), no el nombre de la pantalla. Las variantes ya muestran su
  título (`variantLabel`, :286). Los nodos de imagen ya tienen su nombre encima (`.imageNodeLabel`,
  `canvas-image-nodes.tsx`). El tamaño ya va en el badge de la selección (:706).

El hueco son solo los dos marcos de la página.

## 2. Comportamiento

| marco | etiqueta | fuente |
|---|---|---|
| Página, durante la generación sin la primera sección | `Generando pantalla` (sin cambio) | `artboard-canvas.tsx:694` |
| Página | el título de la pantalla: `pageTitleFromFiles(files)`, y si no hay, la primera línea del primer prompt; sin ninguno, `Nueva página`. Es la misma cadena que la barra superior (`App.tsx:67`), así el lienzo y el top bar no dicen dos nombres distintos | equivalente a `o.title \|\| 'Screen'` (DP l.10017) |
| Variante | su título (sin cambio) | `variantLabel` (:286) |
| Imagen | su nombre (sin cambio) | `canvas-image-nodes.tsx` |

**Dispositivo (decisión, §4).** Hay dos marcos de la misma pantalla. Stitch tiene un nodo por pantalla, y su tamaño va
en el badge de la selección.

## 3. Cambio

- `ArtboardCanvas` recibe `title: string` (prop, A3); `App.tsx` pasa el `title` que ya calcula en :67. No se calcula
  dos veces ni se lee `files` dentro del lienzo.
- `Frame.label` sigue nombrando el dispositivo. Hoy lo usan la etiqueta (`artboard-canvas.tsx:694`) y el `title` del
  iframe (`Preview ${f.label.toLowerCase()}`, :661). La etiqueta visible pasa a salir de `title`.
- El `title` del iframe pasa a `<título>, <dispositivo>` (por ejemplo `Landing Nimbus, móvil`), así un lector de
  pantalla distingue los dos marcos aunque la etiqueta visible sea la misma.
- Sin estado nuevo, sin escritura y sin tocar `use-builder.ts` (693).

Límites (A1): `artboard-canvas.tsx` suma ≤ 5 líneas sobre lo que deje `seleccion-lienzo.md` (≤ 740). `App.tsx`, 1
línea.

Verificar al implementar: que un chat del agente (ADR 0011) traiga `page.title` en `page.json`. Si no lo trae, la
etiqueta cae al prompt, que es largo; con la elipsis de `.artboardLabel` igual se lee, pero es peor que un título.

## 4. Decisión (Orq, por delegación)

- **(a) Fiel a Stitch:** los dos marcos dicen el título. El dispositivo se lee en el ancho y en el badge al
  seleccionar. Es lo que dice el extract (B6).
- **(b) Título · dispositivo:** `Landing Nimbus · Móvil`. Distingue los dos marcos sin seleccionar, pero el sufijo no
  tiene extract.

Recomiendo **(a)**. El `title` del iframe de §3 cubre la accesibilidad; si QA ve confusión con los dos marcos iguales, se
pasa a (b) con un cambio de una línea.

## 5. Tests

1. La etiqueta de un marco de página es `title`; la de una variante es su título; con `busy` y sin la primera sección,
   `Generando pantalla`. Es un test de render del componente con props, sin snapshot.
2. El `title` del iframe lleva el título y el dispositivo.
3. La cadena de `title` en `App.tsx`: `page.title` → prompt → `Nueva página` (si no tiene test, uno sobre
   `pageTitleFromFiles` y el fallback).

UI: captura antes y después del lienzo con los dos marcos y una variante.

## 6. Fuera de alcance

- Renombrar la pantalla desde el lienzo (`i?.label` de Stitch, el nombre que da la persona): no hay extract del editor
  del label ni un campo donde guardarlo.
- La colocación de los nodos (en Stitch la decide el server, `planes/ui.md:55`).
- La rama `Prototype` de Stitch: no tenemos prototipos.
