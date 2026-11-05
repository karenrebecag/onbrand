> **ARCHIVADO (2026-11-05).** Este archivo era `PENDIENTES.md` y describe el ranker de composición sobre el registry de
> Relume y la superficie Arc Pro, anteriores al [ADR 0011](../adr/0011-agente-escribe-como-v0.md) (el agente escribe la
> página y el DS es gramática, no catálogo). Se conserva como historia: nada de lo que sigue es una lista de trabajo
> vigente. Los pendientes de hoy están en [`PENDIENTES.md`](../../PENDIENTES.md).

# web-transformer — pendientes

## Patrón adoptado (de Relume, verificado en su editor)

Fuente: extract de-ofuscado del editor real de Relume en `~/Desktop/relume-llm-infer/`
(`paginas/section-component.js`, `paginas/page-content.js`), 2026-10-12.

**Relume NO rankea componentes con un score numérico. Primero CURA, después elige:**

1. Mantiene un set de **approved categories** (curado/gateado). La basura nunca entra al pool.
2. Un **LLM clasifica** sección→categoría por nombre+descripción (devuelve un índice de la lista
   aprobada), con `findClosest` como atajo. No es overlap de tags.
3. Elige el componente dentro del set aprobado y **mantiene consistencia** por categoría
   (`getConsistentCategories`/`shouldBeConsistent`): reusa el mismo navbar/footer en toda la página.
4. Un **LLM genera el copy** por campo con presupuesto de longitud (`jQ`: "3 words", "1 sentence",
   "2 paragraphs") y narrativa coherente ("maintain the flow, avoid repetition").
5. LLMs separados para estilos (brief→fuentes/color) e íconos.

**Decisión:** replicar ese patrón. Dos capas SEPARADAS:

- **Gate (ocultar):** registry curado por rol; solo componentes verificados (no rotos,
  semánticamente correctos, compatibles con el scaffold). La calidad se resuelve EXCLUYENDO, no
  bajando puntos. — ESTO ES "A".
- **Score (elegir):** entre los aprobados, la cohesión numérica que ya existe (banda, ritmo, orden
  narrativo, intención de CTA, dedupe). Ya sólido.

Antes puntuábamos TODO el catálogo (97 candidatos, basura incluida) pidiéndole al score que la
esquivara. Relume no hace eso.

## A — registry curado + lint (HECHO en `feat/registry-gate`)

- `registry.json` + `src/registry.ts`: allowlist por rol con tags/layoutStyle reales del MCP.
  `candidatesForRole` / `verifiedCandidatesByRole` arman el pool SOLO con `verified: true`;
  los excluidos quedan registrados con la razón en `notes` (Timeline10 = v4-nativo + off-topic;
  Testimonial39 = `gid-cols-1` + avatar sin contenedor + 6 logos : 1 quote).
- `src/lint.ts`: v4-nativo (`size-N.M`, `var(--color-*)`, `@theme`, `@import "tailwindcss"`),
  typos de grid y guion roto en className → `issues` (bloquean); img `size-full` en `<div>` pelado
  → `warnings` (no bloquea: Cta23 tiene la misma forma y renderiza bien).
- `scripts/demo-registry.ts`: el finding corriendo sobre el gate. 30 tests verdes.

Falta integrar (lo hace el runner):
- **Fetch del MCP → lint → registry.** Hoy la semilla es lo que ya estaba en disco. El flujo real:
  `search_components` por rol → `get_component` → `lintComponent` → entrada `verified:false`
  hasta que una persona vea el render → `verified:true`. Sin fuente en disco no hay lint.
- **Roles sin candidato verificado:** testimonials, pricing, faq (exige `@radix-ui/react-accordion`,
  dep bloqueada), banner. `composePage` los omite; no inventa strips.
- **Proporción quote:logo** del lint (Testimonial39): no se implementó como regla; sale por el typo
  y queda documentado en notes. Hacerla regla si vuelve a aparecer en otro componente.
- **Merge de defaults invertido** (hallado al renderizar fixtures/relume-themed sobre el registry): Layout237
  traía `{ ...props, ...Defaults }` — los defaults pisan los props y el componente ignora todo copy
  inyectado (render lorem silencioso, sin error). Corregido en el scaffold. Regla de lint pendiente:
  marcar `...props` ANTES de `...*Defaults` en el objeto de merge como `issue` (bug de datos, no de
  estilo; el gate no lo veía porque no es className).

## Superficie Arc Pro (adaptada a Atom) — `app-arc/`

Segunda superficie de render, elegida por Karen: bloques Arc (motion real) con identidad Atom.
Scaffold Vite+React+shadcn; foundation + bloques free por CLI; Pro (`feature-bento`) por source
del MCP (sin `ARC_PRO_TOKEN`). Tema: tokens semánticos de Arc → Atom (`data-accent="orange"` +
`--accent` #FF6600, Inter Tight, bg #fafafa). `next/image` shimado a `<img>`. Página Atom Pulse
compuesta a mano (igual que fixtures/relume-themed): site-header, hero (minimal), logo-marquee, feature-bento,
stats-band, cta-section, site-footer. Render verificado 1440/768/390, 0 errores.

Pendiente en esta superficie:
- **Adaptador de registry Arc** para que el FINDING elija los bloques (hoy composición a mano, como
  empezó Relume). `mcp__arc__search/list/get_component` → esquema Candidate (whenToUse/whenNotToUse
  es la señal de intención que diferíamos).
- **Localizar `bentoSamples`**: las micro-UIs del bento traen contenido genérico en inglés (Q3 launch
  plan, Invite people, Admins/Editors). Reescribir a e-commerce/WhatsApp.
- `scroll-story` (Pro) para "cómo funciona"; traer por source del MCP.
- Capturas estáticas requieren scroll para disparar el motion in-view (ya resuelto en el script).

## Backlog (después de A)

- **Pasada de composición** (capa de acabado, "secundaria"): normalizar headings (#6: hoy 2-4 h1,
  h2 de 16px en footer), contraste de bandas (P1/D5), cerrar el CTA sin imagen gigante abajo (P2),
  reducir el ruido de botones (P4/D7), orientación del hero text-left para SaaS (P5/D8), longitud
  (P6/D9), stats/logos débiles (P7/D10).
- **Tailwind v4:** migrar el scaffold a Tailwind v4 + preset v4 de Relume → todos los componentes
  renderizan fieles (la librería Relume actual es v4-nativa). Decisión estructural de Karen (C).
- **steps:** Relume no tiene categoría de pasos. Decidir: eliminar el rol, exigir lista/3-4 items,
  o componerlo sin componente de librería (D).
- **Empates (C5):** hoy se resuelven por slug alfabético (en 5/7 roles decide el alfabeto). El
  registry curado y tags más ricos lo mitigan; evaluar un desempate con criterio.
- **Upgrade LLM de intención:** cambiar el regex/tags de sección→rol por un LLM que entienda la
  intención (como Relume). Resuelve "steps", "cómo funciona", etc. sin depender de tags que no
  existen.
- **De-brand de `fixtures/relume-themed` (frente aparte):** los valores de `tailwind.config.js` e
  `index.css` (accent #ff6600, ai #8023ff, whatsapp, scheme-*, neutral.darkest) son los overrides de
  la variante Atom, por diseño — es la variante "themed" frente a `relume-preset` (sin overrides). No
  es residuo de marca suelto: quitarlos no es no-op y no hay fuente fundada para neutros inventados.
  Si se de-brandea, el camino fundado es contra los defaults de `@relume_io/relume-tailwind@1.3.0`
  (preset puro ya versionado en `tools/porter/token-map.relume.ts`), no a criterio, y antes verificar
  que cambiar los colores no altere lo que el fixture de QA ejercita.
- **De-brand del contenido demo (frente aparte):** además del slug ficticio "Pulse" (ya agnóstico), el
  contenido embebe la EMPRESA real Atom — "Sobre Atom", "© 2026 Atom", "novedades de Atom" en
  `fixtures/relume-themed/src/App.tsx` y `fixtures/briefs/pulse-completo.copy.json` — y "Atom Pulse"
  está incrustado en ~15 tests y el `<title>` del scaffold. De-brand real pendiente, no hecho.

## Hecho (QA con karenrebecaog-6f, rondas 1-3)

- F0-F4 del core: plan + rank + cohesión + selección conjunta + marco (navbar/footer/banner).
- Fixes QA: heaviness desde tags, undesiredTags (CTA intención), ritmo solo por banda real,
  flatPenalty/bandPresent, tope configurable, rol steps, orden narrativo canónico, tags verificados
  contra el MCP, dedupe de slug, tipografía fluida clamp(). 21 tests verdes.
- Página real renderizada (Vite+React+Tailwind+preset Relume) en `fixtures/relume-preset/` y `fixtures/relume-themed/`.
