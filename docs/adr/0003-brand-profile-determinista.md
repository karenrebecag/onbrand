# ADR 0003: El Brand Profile es un dato determinista que sesga la composición; el LLM solo toca contenido

Estado: APROBADO | Fecha: 2026-10-16
Origen: brief `docs/research/ds-multibrand-brand-profile-composicion.md` (ESCALADO 2026-10-16).

## Contexto

Hoy la marca solo habla con los tokens (capa de identidad, ADR del brand pack / fix A). El motor de
composición es ciego a la marca: `Brief` no tiene campo de marca (`src/types.ts:28`) y
`selectPage(brief, candidatesByRole, profile)` (`src/select.ts:40`) ni `routeCandidates`
(`src/router.ts:230`) reciben preferencia de marca. Dos marcas con el mismo brief salen compuestas
igual, aunque su identidad estructural sea distinta.

El brief verificado (0 citas falsas) muestra que ampliar la flexibilidad multi-marca tiene cuatro
frentes (tokens / variantes / composición / piezas) y que **ningún sistema de referencia sesga la
composición por marca** — es territorio sin precedente externo. El único frente con precedente
primario directo (shadcn `registry:style`, Radix `accentColor`, Primer component tokens) es nivel 1-2;
su valor real no es estético sino **crear el canal marca→motor que no existe**.

## Decisión

1. **La identidad de marca es un dato DETERMINISTA, no una decisión del LLM.** El eje no es
   "determinista vs LLM" sino **identidad vs contenido**:
   - **Identidad** (cómo se ve y se compone una marca) = el **Brand Profile**, un artefacto firmado y
     versionado. Misma marca → misma huella, reproducible.
   - **Contenido** (qué dice la página y qué piezas encajan con el goal) = juicio del LLM/router sobre
     el **registry de componentes (el DS)**, siempre **acotado por el Brand Profile**.

   El LLM nunca re-deriva "cómo es la marca"; eso sería no-determinista y fuera de marca. [KAREN:chat 2026-10-16]

2. **El Brand Profile entra al motor por un punto único**, análogo a `INTENT_OVERRIDES`
   (`src/plan.ts:44`), no esparcido por router/rank/select. Compone con la intención del brief del lado
   determinista (`rank`/`cohesion` ya son deterministas; el LLM solo entra en `copygen`).

3. **El Brand Profile restringe/pondera, no reemplaza la selección.** Declara sesgos (prefiere hero
   editorial, nav mínima, densidad baja, set de estilo/tokens, categorías permitidas); el router elige
   **dentro** de ese marco, movido por el brief.

4. **Orden de ataque** (del brief, resuelto con la decisión de determinismo):
   - En arc las variantes del Button son **semánticas** (primary/ghost/danger), no perillas estéticas;
     el nivel 2 "variantes por marca" **colapsa** sobre "la marca elige un set de tokens/estilo". Por
     eso el primer trabajo NO es un layer de variantes aparte, sino **extender el brand pack →
     Brand Profile determinista y cablear el canal** (`Brief.brand` → `selectPage`).
   - El valor novedoso es **la composición consciente de marca** (nivel 3): que el Brand Profile sesgue
     el router. Se construye sobre el mismo canal.
   - Se **difieren** las piezas por-marca (nivel 4, contradice la tesis agnóstica) y exponer el catálogo
     como MCP (ortogonal: el MCP de shadcn no consume perfil de marca).

5. **Forma propuesta del contrato** (a afinar en `/spec`, no congelada aquí):
   - `Brief.brand?: string` — referencia al brand pack/profile activo (hoy `WT_BRAND_PACK`).
   - `BrandProfile` = la capa de identidad (tokens, ya resuelta por el brand pack) **+** un bloque
     determinista de composición: sesgos por rol (preferir/evitar), densidad/ritmo, categorías
     permitidas, set de estilo. Vive junto al `brand.json` del brand pack.
   - Un único `applyBrandBias(pool|plan, profile)` lo inyecta antes de `selectPage`, espejo de
     `INTENT_OVERRIDES`.

## Consecuencias

- Contrato nuevo entre módulos (`BrandProfile` → `select`/`compose`): por eso es ADR y pide firma.
- La reproducibilidad del render por marca queda garantizada (dato determinista, no slot de LLM).
- El brand pack deja de ser solo "theme" (nivel 1) y pasa a ser "brand profile" (identidad + sesgo de
  composición). El esquema `brandpack.schema.json` crece con un bloque `composition` opcional.
- Regla de especificidad CSS vigente: un accent custom NO emite `data-accent` o el contrato le gana
  (`src/brand.ts:112`); el profile debe respetarla si llega a tocar variantes.

## Alternativas descartadas

- **Brand Profile como slot del LLM**: no-determinista, no reproducible, se sale de marca. Rechazada
  por la decisión 1.
- **Empezar por nivel 2 (variantes) como capa estética aparte**: en arc las variantes son semánticas;
  poca superficie real. Colapsa sobre el set de tokens/estilo.
- **Nivel 4 (piezas por-marca) primero**: contradice la tesis agnóstica (reuso antes de escribir).

## Abierto para `/spec`

- Granularidad del bloque `composition` (¿sesgo por rol + densidad basta para v1, o también orden?).
- Cómo compone el sesgo de marca con `INTENT_OVERRIDES` cuando ambos opinan sobre el mismo rol.
