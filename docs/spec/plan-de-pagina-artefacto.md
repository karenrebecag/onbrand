# Spec: el plan de página como artefacto que el agente escribe y el follow-up edita (O3)

Estado: PROPUESTO (la aprobación la escribe Karen)
Dueña: orq (L5 plan / L4 contenido). Toca ADR 0011 → propuesta de ADR 0012 en `docs/adr/0012-plan-de-pagina-como-artefacto.md`.
Origen: RE ronda 2 (2026-10-27). Stitch expande el brief en `expanded-prompt.md` (5,2 KB, 6 secciones con copy
literal, conteos, métricas, precios y preguntas) ANTES de renderizar (`re-stitch/WebTransformerSecondary.md` §Pipeline
1 y §Auditoría fila 1). v0 planea en un `task-thinking-v1` de 44,9 s sin salida estructurada
(`re-v0/orqWebTransformer-2026-10-27.md`, fila Plan). Nuestro agente va del brief al TSX sin plan persistido; la
memoria "calidad vs v0" ya nombraba "sin plan de página" como núcleo de la brecha.

## 1. Objetivo

Que cada página tenga un plan legible y editable, escrito por el MISMO agente en el MISMO turno, antes de la primera
sección: `page-plan.md` en la raíz del workspace. El follow-up edita el plan primero y después los archivos. Métrica:
plan presente en el 100 % de las corridas; cada titular del plan aparece en el DOM; los conteos del plan (tarjetas,
pasos, planes, preguntas) coinciden con los del DOM; `edit.scope` sigue en 0 en el follow-up.

Qué NO es: no vuelve el infer aislado de plan (`page-plan.ts`, ADR 0008/0010) ni un `page.json` que otro paso consume.
El plan es texto del agente para el agente y para la persona; el código sigue saliendo del mismo contexto (ADR 0011).

## 2. Requisitos funcionales

- **RF1. Archivo.** `page-plan.md` en la raíz del workspace (junto a `index.html`, fuera de `src/` para que Vite no lo
  toque). Se escribe con Write después de `src/identity.css` (si hay IDENTIDAD) y antes de la primera sección.
- **RF2. Formato fijo**, parseable por línea, en el idioma de la página. Cabecera con el negocio, la acción principal
  (CTA + destino) y el idioma. Después, una entrada por sección en el orden de la página:

  ```md
  ## 03-features · #funciones
  - titular: Cero leads perdidos por responder tarde
  - apoyo: Responde en segundos, de madrugada y en fin de semana.
  - cta: ninguno
  - conteo: 4 tarjetas
  - focal: iconos por tarjeta
  - detalle: chip con el dato al pie de cada tarjeta
  - superficie: muted
  - inventado: 380 % de tasa de contacto; HubSpot y Zoho como integraciones
  ```

  Campos: `titular`, `apoyo`, `cta` (texto + destino o `ninguno`), `conteo` (número + sustantivo o `ninguno`), `focal`
  (mockup, figura, métricas, iconos, imagen; `ninguno` solo en navbar, footer y FAQ), `detalle` (el soporte junto al
  foco: micro-texto bajo el CTA, badge de estado en el mockup, nombre·cargo·empresa del testimonio, prueba social con
  dato; nunca encima del titular, que es eyebrow y sigue prohibido; Arq, B1 replanteado), `superficie` (base | muted |
  raised | inverse), `inventado` (lista o `nada`). El encabezado lleva `NN-<rol>` (el slug de `Section`) y el ancla.
  `focal: imagen` o un mockup con foto implica un slot `<Image src="/images/<slug>-<n>.jpg" alt data-alt>` que el paso
  de imagen rellena al cerrar el turno (#244).
- **RF3. El código obedece al plan.** Titular, apoyo, CTA, conteo y superficie de cada sección son los del plan. Si el
  agente cambia de idea mientras escribe, edita el plan primero (Edit) y luego la sección.
- **RF4. Resumen.** El punto 3 del RESUMEN FINAL ("Datos de ejemplo") se compone desde los campos `inventado:` del
  plan; el punto 1 ("Secciones que armaste") cita el plan en vez de repetirlo.
- **RF5. Follow-up.** El mensaje de seguimiento empieza leyendo `page-plan.md`; edita las entradas de las secciones que
  el mensaje pide (y solo esas), después los archivos. Una sección nueva es una entrada nueva en el plan, un archivo
  y una línea en `App.tsx`; `mv` renumera (O1).
- **RF6. Sugerencias.** El resumen cierra con 2 o 3 "Siguientes pasos" derivados del plan (Stitch: 3 chips). Texto,
  sin UI nueva.

## 3. Reparto por capa

- **orq (este spec):** bloque PLAN en `agentSystemPrompt` entre IDENTIDAD y SECCIONES; modo follow-up lee y edita el
  plan primero; RESUMEN FINAL puntos 1, 3 y 5 (sugerencias). Test: el prompt contiene el formato y el orden
  (`page-plan.md` antes de `src/sections/`).
- **QA:** sensores `plan.exists` (archivo presente y parseable), `plan.copy` (cada `titular:` aparece como texto en el
  DOM de su sección), `plan.count` (el `conteo:` coincide con los hijos repetidos del primer grid de la sección),
  `plan.surface` (`superficie:` == `data-wt-surface` o base), `plan.detail` (el texto de `detalle:` aparece en el DOM
  de la sección). Parser compartido: `src/page-plan-md.ts` (`parsePagePlanMd`, `planCount`, `planInvented`,
  `planDefects`), ya en este PR; el composer lo expone como `agent.plan` en `page.json`.
- **Front:** el builder muestra `page-plan.md` como panel de solo lectura en esta ronda; editarlo en el builder es un
  follow-up ("cambia el titular de 03-features a …") y queda para otra spec.
- **Secondary:** nada en el runner. `page-plan.md` viaja con el workspace como cualquier archivo.
- **Arq:** el skill no cambia. Si el skill fija reglas de conteo (columnas por número de items, ADR 0009), el plan es
  donde el agente las aplica primero.

## 4. Medición

| | Stitch | v0 Mini | nosotros hoy | meta |
|---|---|---|---|---|
| plan persistido | `expanded-prompt.md` 5,2 KB, 6 secciones | no (thinking 44,9 s) | no | `page-plan.md` 100 % |
| copy del plan en el DOM | sí (render obedece) | n/a | n/a | `plan.copy` 0 defectos |
| follow-up sobre el plan | sí (edita el plan) | no | edita archivos | plan editado antes que archivos |
| coste de tiempo | dentro de 137 s totales | 0 | 0 | +10 a +20 s por turno (un Write de ~3 KB) |

Corrida de control: mismo brief de la marca piloto (`scratchpad/pilot-brief.txt`) en el builder, comparada con la demo cc7b8016
(202 s, 47 turnos) y el follow-up 47ed319f (edit.scope PASA).

## 5. Riesgos

- El agente escribe el plan y luego lo ignora: `plan.copy` y `plan.count` lo detectan; el prompt exige editar el plan
  antes que la sección.
- Más tiempo y tokens por turno (un archivo más y una lectura en follow-up). Si pasa de +20 s, se acorta el formato
  (sin `apoyo`), no se quita el plan.
- Datos inventados sin declarar (Stitch: "4.9/5 en G2", "450+ PYMEs" sin marcar): el campo `inventado:` es obligatorio
  por sección; `nada` también es una respuesta.
- Choque con `page-plan.ts` (infer de plan del camino anterior): no se toca; el nombre del archivo `page-plan.md` es
  del workspace, no del motor.

## 6. Fuera de alcance

Edición del plan desde la UI del builder; sugerencias como chips clicables; regenerar una sección desde su entrada del
plan; plan multi-página.
