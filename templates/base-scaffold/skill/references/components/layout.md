# Layout

Primitivas de `@/components/layout/layout`. Solo posición y espacio por token: el estilo visual de la sección es tuyo,
en su `.module.css`.

Código: `src/components/layout/layout.tsx`

| primitiva | para qué | props |
|---|---|---|
| `Section` | contenedor de cada sección (ancla, rol, ancho y superficie del contrato) | `id`, `role`, `slug`, `width?: prose\|narrow\|content\|wide\|full`, `surface?: base\|muted\|raised\|inverse`, `padding?: none\|sm\|md\|lg`, `backdrop?`, `bare?` |
| `Stack` | columna con espacio | `gap?`, `align?` |
| `Grid` | grilla por columnas | `cols: n \| { base, md?, lg? }`, `gap?`, `align?` |
| `Cluster` | fila que envuelve | `gap?`, `justify?: start\|center\|end\|between`, `align?` |
| `Split` | dos columnas desde 1024 px | `ratio?: 1:1\|1:2\|2:1`, `gap?`, `align?` |
| `Text` | texto con rol tipográfico | `role: display\|title\|subtitle\|body\|caption`, `align?: start\|center` |
| `Image` | imagen con marco por token | `src`, `alt`, `data-alt?`, `width?`, `height?` |

Espacios (`gap`): `none`, `xs`, `sm`, `md`, `lg`, `xl`, `2xl`. Alineación: `start`, `center`, `end`, `stretch`.

- `surface="inverse"` es la zona oscura (cierre o una sección de contraste): resuelve los tokens oscuros dentro.
- `surface="muted"` y `"raised"` son la banda del contrato: separan la sección del fondo sin un color propio.
- La grilla no tiene modo carrusel: en móvil apila según `cols.base`.
