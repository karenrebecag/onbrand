# ADR 0012: el plan de página vuelve, como texto que el agente escribe en su turno

Estado: APROBADO (Karen, 2026-10-27) | Fecha: 2026-10-27 | Dueña: orq (L5/L4), QA (sensores), Front (panel)
Spec: `docs/spec/plan-de-pagina-artefacto.md`. Ajusta ADR 0011 (contexto, punto 4) y cierra lo que ADR 0008/0010
dejaron: el plan como dato existe, pero ya no es un infer aparte ni un JSON que consume otro paso.

## Contexto

ADR 0011 copió a v0: "el plan vive solo en su razonamiento (`task-thinking-v1`); no hay un paso de plan con salida
estructurada". El RE de la ronda 2 (2026-10-27, misma página de la marca piloto en Lovable, Stitch y v0) mostró que:

- Stitch expande el brief en un plan de página persistido (`expanded-prompt.md`, 5,2 KB, 6 secciones con copy
  literal, conteos, métricas, precios, preguntas y el mockup del hero) ANTES de renderizar, y el render lo obedece.
  Es la mayor diferencia con nuestra salida (`re-stitch/WebTransformerSecondary.md` §Auditoría y §Síntesis 1).
- v0 Mini planea 44,9 s en thinking sin salida; su V1 niega tener reglas de sección y se contradice con su propio
  stream (`re-v0/orqWebTransformer-2026-10-27.md`). No es editable ni medible.
- Nuestra demo cc7b8016 (ADR 0011 en main) no deja plan: el follow-up edita archivos a ciegas y el resumen "Datos de
  ejemplo" depende de la memoria del agente al final del turno.

## Decisión

El agente escribe `page-plan.md` (formato fijo, por sección: titular, apoyo, cta, conteo, focal, superficie,
inventado) después de la identidad y antes de la primera sección, en el mismo turno y el mismo contexto. El código
obedece al plan; el follow-up edita el plan antes que los archivos; el resumen y las sugerencias salen del plan. QA
mide la fidelidad plan→DOM (`plan.copy`, `plan.count`, `plan.surface`).

## Alternativas

1. **Plan en el razonamiento (v0, ADR 0011 hoy).** Cero coste, pero no editable, no medible, y el follow-up no sabe qué
   decidió el turno anterior. Descartada por el RE.
2. **Infer de plan aparte con `page.json` (ADR 0008/0010).** Ya lo tuvimos: cada sección se escribía sin ver a las
   demás (D1) y el emisor rellenaba props. Descartada por ADR 0011.
3. **Texto del agente en su turno (Stitch).** Un Write más, legible para la persona, editable por el mismo agente,
   medible por QA sin parser complejo. Elegida.

## Consecuencias

- `agentSystemPrompt` gana el bloque PLAN y el follow-up empieza por el plan (orq). Un test de orden.
- QA suma 4 sensores y un parser compartido de `page-plan.md` (una función).
- Front muestra el plan; editarlo desde la UI es otra spec.
- Tiempo por turno: +10 a +20 s estimados; se mide contra la demo cc7b8016.
- ADR 0011 queda vigente en todo lo demás; su tabla gana una fila "Plan de página: v0 en thinking / nosotros
  `page-plan.md`".
