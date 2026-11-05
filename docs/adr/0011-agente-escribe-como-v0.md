# ADR 0011: el agente escribe la página como v0; el DS es gramática, no catálogo

Estado: APROBADO por Karen (2026-10-24, en su terminal) | Fecha: 2026-10-24 | Dueña: Arq (coordina), todas las capas
Decisión de Karen (2026-10-24): «exactamente igual a V0. Si nuestro enfoque está errado hay que cambiarlo».
Origen: R3 de orq (`~/Desktop/web-transformer-sesiones/brechas/orq.md` §4, `~/v0-fe-capture/calidad-re/j049-chat-state-decoded.json`, 386 parts) e
informe `~/Desktop/web-transformer-sesiones/reports/Generadores de UI con IA.md`.

## Contexto (RE, con evidencia)

Cómo genera v0 una página (j049, primer mensaje, en orden):
1. `task-skill-v1`: carga el skill del DS (Carbon).
2. Lee el starter: page, hero, globals.scss, header, layout. Lee la doc del DS y valida los nombres de iconos.
3. Genera la imagen de producto **antes** del código.
4. Escribe un archivo por sección en el orden del brief. El "plan" vive solo en su razonamiento
   (`task-thinking-v1`: "I'm planning a Carbon/IBM-style editorial design…"). No hay un paso de plan con salida
   estructurada.
5. Corrige lo que ve mientras escribe (testimonials ×2, iconos de logos), revisa tipos, toma una captura de la página
   completa con agent-browser, corrige (switcher de pricing), prueba el toggle y móvil a 375, y resume declarando lo
   inventado.
6. Todo sale en **una sola versión**.

La variedad sale de escribir cada bloque para el brief con una gramática común (Grid/Column/Tile + BEM sobre tokens):
- hero de j049 con media a ancho completo; hero de Lumbre con `<dl>` de 3 cifras y figura al lado;
- testimonials con iniciales en j049; con 5 estrellas y avatares generados en Lumbre.

Nosotros hacemos otra cosa: un plan estructurado (`page.sections[]`), un infer aislado por sección que elige un bloque
maduro y rellena props JSON, dos validadores, el runner que emite TSX y un repair como versión aparte. De ahí salen
las brechas medidas hoy:
- **misma forma para 3 negocios** (D4);
- **CTA ×7 y cita repetida**, porque cada sección no ve a las demás (D1);
- **demo del bloque que se cuela** (D2);
- **dos validadores** (D5);
- **verificación fuera del turno** (D3).

## Decisión

Igual que v0. Un solo agente con herramientas por mensaje escribe el código de la página sobre el DS:

| Paso de v0 | Nuestro equivalente | Estado hoy |
|---|---|---|
| Skill del DS | `build-ds-skill` (references, foundations, iconos, allowlist), publicado por pin | existe; pasa a ser LA entrada del agente |
| Starter | `templates/arc-scaffold`, versionado por pin (no copia del checkout, R6) | existe; falta versión |
| Docs del DS | `references/<cat>.md` + código de componentes del registry | existe |
| Imagen antes del código | image-step | existe |
| Escribe un archivo por sección | el agente escribe `src/sections/<rol>.tsx` importando átomos y componentes del DS | **nuevo**; sustituye props JSON + emisor |
| Corrige mientras escribe | edit sobre el archivo, en el mismo contexto | nuevo |
| Type-check | v0: `npx tsc --noEmit 2>&1 \| head -30` como bash, 6,3 s (j049). Nuestro: `tsc --noEmit` del workspace como herramienta; el scaffold ya trae typescript (`build: tsc -b && vite build`) | **no existe** (corrige Secondary, RE 3): el transport corre `bunx vite build` sin `tsc`, así que hoy no se revisan tipos; el render-gate mide el render de dist, no los tipos |
| Captura + corrección + móvil | v0: skill built-in `agent-browser` cargado a demanda (1 archivo), que maneja un CLI en un browser-sandbox aparte contra el **dev server** (`localhost:3000`): `open`, `set viewport 1440 900`, `wait --text`, `screenshot --full`, `errors` (excepciones no capturadas), y luego `find role tab click`, `get text` y `set viewport 375 800` + `screenshot`. La imagen vuelve al modelo: la salida de texto solo dice "Screenshot saved", y el razonamiento siguiente describe la columna desalineada. Lo decide el modelo: en run-plus no hubo captura. **Oscuro no aparece.** Nuestro: herramienta de browser sobre el preview vivo (dev), con la imagen en el resultado de la tool | **nuevo**; reemplaza preview-check fuera del turno. Detalle en `specs/refinamiento.md` |
| Resumen que declara lo inventado | texto final del mensaje | nuevo; reemplaza provenance por rutas |
| Una versión por mensaje | commit al final del turno | cambia: el repair deja de ser versión |
| Follow-up | el mismo agente edita los archivos de la página | cambia: edit-plan por secciones pasa a edición de archivos |

Los bloques de la librería (Arc, Relume) pasan a ser **referencias y molde**: código que el agente lee para aprender la
gramática, como el starter de v0 (RE de Relume en registry: "starter = molde, no librería"). Los átomos y componentes
del DS siguen siendo importables.

## Qué deja de existir o cambia (a confirmar con RE por capa)

- La selección de bloque maduro por rol como camino principal (pool, shortlist y renderGate por item como condición
  de entrada). El gate pasa a medir componentes del DS, no secciones.
- El árbol JSON de sección, `check_layout` y `pageErrors` como validadores. La validación pasa a type-check, build y
  sensores sobre el DOM (D5 desaparece).
- El builder edita por `ValuePatch` sobre props. Hay que decidir el equivalente: edición de archivo, Design Mode como v0.
- Los sensores que leen `page.json` (plan-sensors, edit.scope por sección) se re-anclan al DOM y a los archivos.
- Contrato de bloque ADR 0009: deja de ser un pase sobre ports y pasa a ser **reglas del skill** (alineación, columnas
  por número de items, tema por ancestro, motion 0), que el agente aplica al escribir y QA mide en el DOM.

## Riesgos (con número)

- **Tiempo:** v0 tarda 320 s en la base; nosotros 105-112 s. Un solo agente que escribe, compila y mira capturas va a
  tardar más. La verificación de v0 en j049 suma unos 20 s: tsc 6,3 s, captura completa 9,2 s, corrección 2-4 s y
  prueba móvil 2,9 s. Hoy nuestro render-gate tarda 3-7 s y el repair como versión aparte 31-50 s (QA final4/final5).
- **Gasto:** un contexto largo con capturas cuesta más tokens que N infers cortos. En `cli` corre sobre la sesión de
  Karen; en deploy va por el gateway, que es gasto y decide Karen.
- **Calidad sin red:** hoy el bloque maduro garantiza un piso. Escrito a mano, el piso es el skill más la verificación;
  hacen falta los sensores de QA (spec de observabilidad) antes de comparar.
- **Lo que perdemos:** la edición determinista por prop y la provenance por ruta. v0 tampoco las tiene.

## RE pendiente antes de aprobar

1. Herramientas exactas del agente de v0 y sus argumentos (read/write/edit/grep/type-check/browser) en el estado
   decodificado. Dueña: orq.
2. ¿Qué trae el skill de Carbon de v0 (reglas, ejemplos, tamaño) contra nuestro `build-ds-skill`? Dueña: Arq.
3. ¿Qué hace agent-browser y cómo vuelve la captura al modelo? Dueña: Secondary (R8 ya tiene parte).
4. ¿Cómo edita v0 un follow-up (archivos tocados por mensaje)? Dueña: orq, con la captura existente.
5. Piloto: la misma página de la marca piloto escrita por el agente sobre el skill actual, medida con los sensores de hoy más una
   captura, contra v0 atomchat. Sin créditos de v0; gasto de infer solo en `cli`.

## Plan por capa (las specs de la ronda 2 se re-escriben contra este ADR)

- **orq (L4/L5):** el agente de un contexto: prompt, herramientas, orden del brief, declaración de lo inventado,
  follow-up como edición.
- **Secondary (L6/L0):** herramientas de type-check y browser dentro del turno, una versión por mensaje, scaffold
  versionado por pin, registry como skill más referencias.
- **Front (L2/L3/L7):** marca y tema en el skill y el starter, motion 0, el builder sobre archivos.
- **Arq (L1):** skill del DS con la gramática (reglas del ADR 0009 como reglas de escritura) y bloques como referencias.
- **QA:** sensores sobre DOM y capturas (repetición, CTA, demo, lang por fragmento, variedad entre briefs, móvil).

## Enmienda 1: el agente importa los bloques de sección (PROPUESTO, Arq, 2026-10-28)

**Contexto.** El ADR trata los bloques como referencias para leer. En gen4 (fac2bce5), el agente escribió las 9 secciones desde cero: importó layout ×7, relume/action ×4, iconos ×2 y arc/accordion ×1, y ningún bloque. El índice del skill solo listaba átomos y decía "lo que no está en esta tabla no existe", así que para el agente los 15 bloques de landing de Arc no existían. El costo: cada sección se reescribe con el prior del modelo, y la calidad de los bloques del DS no llega a la página.

**Decisión propuesta.**
- Un bloque de sección con props de contenido (título, apoyo, items, CTA) se **importa** y recibe el contenido del brief por props; el agente no escribe esa sección desde cero.
- El texto de la demo del bloque queda solo como valor por defecto. Un bloque sin props de contenido (propless) no entra al índice hasta que las tenga.
- El índice del skill suma "Secciones de landing" con una fila por bloque: `Rol | import exacto | props de contenido | cuándo`. El formato es genérico por fuente (`@/components/<fuente>/...`): lo comparten Arc, Morphin y Bencho.
- El bloque se monta en `<Section id role slug bare>`: el contrato de página (ancla, `data-wt-role`/`slug`, tema) sin otro contenedor.
- En la dirección, la columna Bloque manda sobre la forma. Relume queda como guía de layout para los roles sin bloque.
- Lo que el ADR mantiene: el agente compone la página, decide orden, copy y direccionalidad, y escribe las secciones que no tienen bloque.

**Consecuencias.**
- La variedad entre corridas depende más de las variantes de cada bloque y del catálogo de direcciones.
- `plan.direction` (QA) no puede exigir el Read del ref en una sección con bloque.
- La calidad visual de esas secciones pasa a ser la del bloque: un bloque roto se ve en todas las páginas.

**Estado:** APROBADO por Karen (2026-10-27, en su terminal).
