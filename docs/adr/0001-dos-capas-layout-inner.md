# ADR 0001: Dos capas, layout (Relume) + inner (Arc)

Estado: Aceptada (firmada por Karen 2026-10-15) | Fecha: 2026-10-15
Origen: brief `docs/research/catalogo-blob-router-agentico.md` (D4, APROBADO) y spec
`docs/spec/catalogo-blob-router.md` (RF12, RF13, DA1).

## Contexto

El brief `runner-e2e-arquitectura` (APROBADO) fija que cada adaptador declara UN solo scaffold y
que el core consume `Candidate` verificado sin reglas de librería. Karen fijó después un modelo de
composición de DOS capas: una cáscara de sección de Relume (`sections-react`, el "layout") cuyo
interior lo llena un bloque o componente de Arc (`ui-react`, el "inner"). Eso cruza dos registries
y dos scaffolds, una estructura que el runner aprobado no contempla; por eso este ADR.

Precedente: Puck 0.19 modela el anidamiento con `SlotField` (`type: "slot"`, `allow`/`disallow`) y
guarda los hijos dentro de los props del padre, no en un árbol aparte.

## Decisión

1. Una entrada del catálogo puede ser `kind: "layout"` con `slots: { inner: { allow: Role[], max: 1 } }`.
   Compite en el pool de su rol como cualquier candidato (tiene superficie y geometría propias).
2. Si el finding elige un layout para un strip, `composeLayers` resuelve `inner` corriendo el router
   y `selectPage` sobre el pool Arc acotado a `allow`, y guarda el resultado en los props del layout
   (`props.inner = { slug, props }`), patrón Puck. `selectPage`/`composePage` no cambian de firma.
3. Stack de estilos (DA1, Karen 2026-10-15): la cáscara Relume se vendoriza al scaffold Arc como
   **CSS modules con tokens Arc**, nunca añadiendo Tailwind al scaffold ni un tercer scaffold. Un
   **transformer script Tailwind -> CSS modules** (F4a) porta el grueso automáticamente: resuelve cada
   clase utilitaria a sus declaraciones CSS desde el config resuelto de Tailwind, agrupa en una
   clase del `.module.css`, reescribe `className` -> `styles.x`, y traduce variantes `hover:`/`md:`/
   `dark:` a selectores y `@media`. Queda a revisión humana acotada: valores arbitrarios, el mapeo de
   colores Tailwind -> tokens semánticos Arc (`--surface`, `--foreground`...), y los imports
   `@kit/ui`, que son componentes (se mapean a componentes Arc o se portan), no utilidades.
4. Fuente (Karen, 2026-10-15): el catálogo son las **versiones procesadas del knowledge local** de
   Karen (`~/Desktop/SoftwareDevProjects/Knowledge/Frontend/Components`), agnósticas y portadas a CSS
   modules. Es la librería propia del equipo, servida por un endpoint privado.

## Consecuencias

- Positivas: se reutiliza la cáscara (ritmo, espaciado, contenedor) de Relume con el contenido vivo
  de Arc; el anidamiento es un dato más del finding, explicable y testeable; un solo scaffold
  generado.
- Costos: un transformer que mantener; cada layout elegible pasa por revisión humana antes de
  `verified:true`; dos orígenes de source en el índice (campo `library`).
- Límites: F4a/F4b de la spec no arrancan hasta que este ADR esté APROBADO por Karen.

## Alternativas descartadas

- Un solo registry que mezcle layout y contenido en un item: pierde la reutilización de la cáscara.
- Componer solo con Arc: descarta el modelo que Karen fijó.
- Tailwind v4 en el scaffold Arc: dos sistemas de estilo en una página y una dep + config raíz.
- Tercer scaffold para páginas de dos capas: triplica el mantenimiento del emit.
