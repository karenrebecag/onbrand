# Ingeniería inversa de v0 — misión (2026-10-22)

Objetivo (Karen): replicar EXACTO el modelo de v0 con nuestras piezas, recrear las que falten.
Mismo pipeline, mismo comportamiento, mismos resultados. Editor de v0 abierto para dudas (todo público).

## El pipeline de v0 (lo capturado, ground truth)

Entrada: un prompt (+ opcional un DS-skill adjunto como pill).

Endpoints reales (DevTools MCP, Chrome real, 2026-10-22):
- `POST /chat/api/chat` — el stream del AGENTE (LLM). Es el loop.
- `POST /chat/api/chat/leaf`, `/send-site` — nodos de continuación + push del preview.
- `GET /chat/api/vm/status`, `/snapshots` — la VM sandbox donde corre el app (`*.vusercontent.net` / `*.v0.build`).
- `GET /api/v2/internal/design-system-skills` — lista de DS-skills del scope.
- NO hay endpoint de selección, ni inferencias de estructura, ni match de catálogo. v0 NO selecciona.

Traza del agente (labels observados, en orden), con un DS adjunto (Carbon):
1. `Loaded <ds> design system` — carga el skill.
2. `Set up environment` — prepara el sandbox.
3. `Read starter` (×5) — lee el CÓDIGO de los componentes del DS (el referenceWorkspace/starter).
4. `Explore • N Files` — explora archivos.
5. `Thought for Ns` — planifica.
6. `Checked icon names` (×N) — verifica que los nombres de iconos/props existan.
7. `Wrote header` → `Wrote hero` → `Wrote logos` → `Wrote features` → `Wrote how it works` →
   `Wrote stats` → `Wrote testimonials` → `Writing pricing`… — escribe SECCIÓN POR SECCIÓN.
8. `Fixed testimonials layout`, `Fixing logo icons` — auto-corrige tras renderizar.

Salida: un app Next.js real en el sandbox, compuesto con los componentes del DS. Sin DS adjunto,
compone con su vocabulario base (shadcn/ui + Tailwind) y escribe componentes a medida.

## Formato del DS-skill de v0 (schema verificado, v0.app/docs/design-systems-2)

Carpeta-skill:
```
<skill>/ SKILL.md · logo.png · assets/starter/ · references/ · v0.json
```
- `v0.json` (version 1): `referenceWorkspace.sources` = hasta 3 repos GitHub READ-ONLY montados
  (el código real de los componentes); `starter.source` ∈ {skill-directory, empty, v0-default}.
- `SKILL.md` frontmatter: `metadata.v0.kind: design-system` + `v0.design-system.appearance`
  (bg/fg light/dark, SOLO swatch de UI, no cambia tokens). Cuerpo = convenciones/do's&don'ts/voz.
- `assets/starter/` = app base de la que arranca cada generación.
- `references/` = foundations, components, examples (docs destiladas).

## Nuestras piezas vs lo que v0 necesita

TENEMOS:
- 191 componentes Arc (144 `component` tipo átomo/molécula + 47 `block`) con manifests (props, whenToUse)
  = equivalente a @carbon/react. Es el vocabulario para componer. (loadCatalog, src/catalog)
- 844 layouts/bloques Relume (scaffolds agnósticos) = andamiaje.
- Transporte LLM sin key: `claude -p --model <m> --append-system-prompt` (claude-code-transport).
- Validadores: render-gate (residuo), token-invariant (solo tokens DS), slot-policy, a11y.
- emit/brand (aplica identity.css), el scaffold Vite generado.
- Fuente real de cada componente Arc (salida del porter).

FALTA (recrear):
- El DS-skill empaquetado desde Arc (SKILL.md + v0.json + reference de componentes + starter).
- El LOOP DEL AGENTE: load DS → read components → plan → write section-by-section → verify
  (nombres/props existen, render-gate) → fix. Hoy tenemos select→copy, que NO es esto.
- La salida como CÓDIGO que compone componentes Arc (importa y arregla props), no selección de bloque.
  Restricción de la meta: el agente NUNCA reescribe la maquetación interna del componente; lo importa
  y le pasa props/children, como v0 con @carbon/react.
- El preview/sandbox (ya tenemos el scaffold Vite; basta build + preview local).

## División (Karen asignó a Fable + Secondary)

FABLE (motor del agente / codegen):
- El loop del agente: contexto (componentes Arc + convenciones) → plan de secciones → escribir cada
  sección como TSX componiendo Arc → verify (props/nombres existen + render-gate) → fix.
- La orquestación y el entrypoint nuevo `v0compose` (sin tocar run.ts ni main).
- Medir variedad (negocios distintos → páginas distintas) y fidelidad (se queda en el DS).

SECONDARY (el DS-skill desde Arc):
- Empaquetar los 191 Arc como DS-skill estilo v0: SKILL.md (convenciones/voz/qué componente por rol)
  + v0.json + reference de componentes (nombre, props, whenToUse, ejemplo) + starter.
- Es lo que el agente LEE. Reusa manifests del catálogo y la fuente del porter.

Punto de integración: el agente (Fable) consume el DS-skill (Secondary) como contexto. Contrato del
skill = el mismo formato que Secondary arme; Fable lo lee y compone.

## Slice 1 (primero, medible)
Un entrypoint `v0compose` que, dado un brief + el contexto de componentes Arc, escribe UNA página
componiendo Arc (vía LLM), la valida y la renderiza. Correr 2-3 briefs distintos y medir variedad +
fidelidad vs el pipeline select de hoy. Sin tocar main; PR solo con números.
