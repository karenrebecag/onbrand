# Inventario del vault (F0)

Generado: 2026-10-16T16:24:18.140Z
Fuente: `/Users/karenrebecaog/Desktop/SoftwareDevProjects/Knowledge/Frontend/Components` (READ-ONLY)

## Por carpeta

| Carpeta | Items | Ingest actual | Formatos |
|---|---|---|---|
| ui-react | 241 | sí | tsx+css-modules:241 |
| sections-react | 1524 | sí | tsx+tailwind:1524 |
| sections-webflow | 1757 | no | webflow:1757 |
| motion-gsap | 100 | no | md:100 |
| ui-squircle | 1146 | no | tsx+tailwind:1053, other:93 |
| buttons | 100 | no | html+css+js:100 |
| motion-html | 256 | no | html+css+js:229, other:26, html:1 |
| motion-webflow | 208 | no | webflow:208 |
| icons | 249 | no | svg:249 |

## Totales

> El total cuenta cada hoja del vault: `icons` como SVG individual y `motion-*` como item,
> no solo las carpetas React ingestables (ui-react 241 + sections-react 1524).

| Métrica | Valor |
|---|---|
| Items en el vault | 5581 |
| Indexados | 860 |
| — materializables bajo demanda (source:null) | 824 |
| — procesados en el scaffold (source en repo) | 36 |
| NO indexados | 4721 |

Desglose del gate sobre los `source:null` (el gate decide si entran al pool):

| Estado del gate | Valor |
|---|---|
| gate.ok (pool) | 774 |
| gate fallido | 50 |
| indexado sin gate | 0 |

Ortogonal: 34 entradas marcadas `verified` (render confirmado), repartidas entre las de arriba y las procesadas en scaffold.

## Qué falta para que cada carpeta sea subible

- **ui-react**: 223 no indexados.
- **sections-react**: 682 no indexados; 1316 con imports sin resolver (@kit//@/).
- **sections-webflow**: sin ingest (no entra al índice); 1757 no indexados; formato Webflow (no es React portado).
- **motion-gsap**: sin ingest (no entra al índice); 100 no indexados; solo documentación (.md).
- **ui-squircle**: sin ingest (no entra al índice); 1146 no indexados; 1053 con imports sin resolver (@kit//@/).
- **buttons**: sin ingest (no entra al índice); 100 no indexados; HTML/CSS/JS (no es componente React).
- **motion-html**: sin ingest (no entra al índice); 256 no indexados; HTML/CSS/JS (no es componente React).
- **motion-webflow**: sin ingest (no entra al índice); 208 no indexados; formato Webflow (no es React portado).
- **icons**: sin ingest (no entra al índice); 249 no indexados; SVG sueltos (no componentes).

## Señales de calidad

- Duplicados por contenido (sha256): 8
- Mismo slug en varias carpetas: 1725 (mismo componente en formatos distintos: react/webflow/motion). Colisiones DENTRO de una carpeta: 0.
- Componentes React sin export detectable: 1 (solo módulos .tsx; los snippets html/js no cuentan).
- Huérfanos del índice (path/sha no coincide con el vault): 0

## Estimado del volcado procesado

- ~19.61 MB de fuente React/squircle.
- Suma de bytes de fuente (tsx/ts/js/css) de items React/squircle. Para los TSX+Tailwind el porte a CSS modules cambia el tamaño; es una cota, no el tamaño final del volcado.
