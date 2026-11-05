# Índice del DS base

Qué hay y en qué archivo. Antes de usar un componente, lee su entrada en el archivo de su categoría.

| necesitas | componente | import | referencia |
|---|---|---|---|
| una sección de landing con rol conocido | bloque del rol | `@/components/blocks/<rol>` | `references/examples/<rol>.md` |
| contenedor, columnas, filas, texto, imagen | `Section`, `Stack`, `Grid`, `Cluster`, `Split`, `Text`, `Image` | `@/components/layout/layout` | `layout.md` |
| un botón o un enlace con forma de botón | `Button` | `@/components/ui/button` | `actions.md` |
| un enlace de texto | `Link` | `@/components/ui/link` | `actions.md` |
| un encabezado con nivel | `Heading` | `@/components/ui/heading` | `text.md` |
| una etiqueta de estado | `Badge` | `@/components/ui/badge` | `feedback.md` |
| un icono | `Icon` | `@/components/ui/icon` | `special.md` |
| una persona | `Avatar` | `@/components/ui/avatar` | `data.md` |
| un ítem repetido | `Card` | `@/components/ui/card` | `data.md` |
| preguntas o contenido desplegable | `Accordion` | `@/components/ui/accordion` | `disclosure.md` |
| un campo de formulario | `Input`, `Textarea` | `@/components/ui/input`, `@/components/ui/textarea` | `inputs.md` |

Bloques: `navbar`, `hero`, `features`, `logos`, `stats`, `steps`, `testimonials`, `pricing`, `faq`, `cta`, `footer`.

## Reglas universales

- Un componente de esta tabla no se reescribe a mano en una sección.
- Las props salen del código del componente: un nombre que no está en su interfaz no existe.
