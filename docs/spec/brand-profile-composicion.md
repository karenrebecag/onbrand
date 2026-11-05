# Spec: Brand Profile → composición consciente de marca

Slug: brand-profile-composicion | Estado: APROBADO | Fecha: 2026-10-16
Brief: `docs/research/ds-multibrand-brand-profile-composicion.md` (APROBADO)
ADR: `docs/adr/0003-brand-profile-determinista.md` (APROBADO)

## 1. Objetivo

Que la marca hable con el motor de composición, no solo con los tokens: un **Brand Profile
determinista** sesga la selección de secciones en un punto único (espejo de `INTENT_OVERRIDES`,
`src/plan.ts:44`), de modo que la misma marca produzca la misma huella estructural de forma
reproducible. Éxito = misma brief + dos marcas con sesgo distinto → composición distinta y estable.

## 2. Requisitos funcionales

- **RF1** `Brief.brand?: string` referencia el brand pack activo (hoy `WT_BRAND_PACK`). Ausente =
  sin sesgo de marca (comportamiento actual, intacto).
- **RF2** El brand pack puede declarar un bloque `composition` determinista en su `brand.json`:
  sesgos por rol (`desiredTags` / `undesiredTags`), `density` (afecta ritmo y nº de strips),
  `allowedCategories` (recorta el pool por rol) y `styleSet` (nombre de set de estilo/tokens).
  Todos opcionales; un `brand.json` sin `composition` se comporta como hoy.
- **RF3** `src/brand.ts` parsea y valida `composition` en el límite de confianza (extiende
  `parseBrandPack`), expone `BrandProfile = { identity, composition }`.
- **RF4** `specFor(role, intent, composition?)` compone el spec de rol en un punto único:
  `ROLE_SPEC[role]` ← override de marca (`composition`) ← override de intención (`INTENT_OVERRIDES`).
  **Regla marca↔intent: la intención gana en claves en conflicto** (la intención es el propósito de
  la página; la marca es preferencia). Mismo mecanismo que ya usa `INTENT_OVERRIDES`, no esparcido
  por router/rank/select.
- **RF5** `density` del profile mapea al `RhythmProfile`/nº de strips que recibe `selectPage`
  (`src/select.ts:40`), de forma determinista; sin `density`, el default actual.
- **RF6** `allowedCategories` (si está) filtra los candidatos de un rol antes de rankear; si deja el
  pool vacío para un rol, ese rol se omite (no se inventa), igual que un rol sin candidato hoy.
- **RF7** El LLM no toca el Brand Profile: identidad y sesgo son datos deterministas; el LLM sigue
  solo en `copygen`, acotado por el profile.

## 3. Requisitos no funcionales

- **RNF1 Determinismo**: para un mismo (brief, brand, catálogo) la composición es idéntica entre
  corridas (sin aleatoriedad, sin LLM en la ruta de selección).
- **RNF2 Agnóstico**: ningún valor de marca hardcodeado en el motor; todo viene del `brand.json`.
- **RNF3 Aditivo**: `Brief` sin `brand` y `brand.json` sin `composition` reproducen el output actual
  byte a byte (los tests E2E existentes no cambian de resultado).
- **RNF4 Punto único**: el sesgo de marca entra solo por `specFor`/`planSections`; `grep` no debe
  hallar lógica de marca en `router.ts`, `rank.ts` ni `select.ts`.

## 4. Criterios de aceptación

- **CA1 (RF1,RF3)** Dado un `brand.json` con `composition`, cuando el emit corre con
  `WT_BRAND_PACK` apuntándolo, entonces `parseBrandPack` devuelve `composition` tipado y un
  `brand.json` inválido (tag no-string, density fuera de enum) lanza con mensaje claro, sin escribir.
- **CA2 (RF4)** Dado marca que pone `cta.undesiredTags=[]` e intent `waitlist` que pone
  `cta.desiredTags=['Form',...]`, cuando se resuelve `specFor('cta','waitlist',comp)`, entonces el
  resultado tiene los `desiredTags` de la intención (gana intención) y hereda lo que la marca no
  pisó. Test determinista por tabla.
- **CA3 (RF2,RF4)** Dado dos marcas con `composition` distinto (p.ej. A prefiere `hero` con `Image`,
  B con `Background Image`) y el mismo brief, cuando se compone, entonces `selectPage` elige heros
  distintos de forma estable (misma elección en 3 corridas).
- **CA4 (RF5)** Dado `density: 'compact'` vs `'spacious'`, cuando se compone, entonces el
  `RhythmProfile`/nº de strips resultante difiere de forma determinista y documentada.
- **CA5 (RF6)** Dado `allowedCategories` que excluye la única categoría disponible de un rol, cuando
  se compone, entonces ese rol se omite (no aparece en el output) y no rompe la página.
- **CA6 (RNF3)** Dado `Brief` sin `brand`, cuando corre el E2E `pulse`, entonces el output es
  idéntico al actual (los tests existentes pasan sin cambios).
- **CA7 (RNF4)** `grep -rE "composition|brandBias|BrandProfile" src/{router,rank,select}.ts` no
  devuelve lógica de decisión de marca (solo, a lo sumo, el tipo que pasa de largo).

## 5. Datos

- `BrandComposition` (nuevo, en `src/brand.ts`): `{ roles?: Partial<Record<Role, {desiredTags?: string[]; undesiredTags?: string[]; allowedCategories?: string[]}>>; density?: 'compact'|'default'|'spacious'; styleSet?: string }`.
- `BrandProfile = { identity: BrandPack; composition?: BrandComposition }`.
- `Brief` (en `src/types.ts`): campo opcional `brand?: string`.
- `brand.json` schema (`brandpack.schema.json` en los proyectos brand-pack): bloque `composition`
  opcional, aditivo. Sin migración de datos (los `brand.json` existentes siguen válidos).

## 6. Dependencias

- Brand pack (`~/Desktop/SoftwareDevProjects/brand-pack*`): fuente del `brand.json`. Si el dir no
  existe o `brand.json` no parsea → error claro en emit (ya hoy: `applyBrand` lee y valida).
- `src/plan.ts` (INTENT_OVERRIDES), `src/select.ts` (selectPage), `src/brand.ts` (parse). Sin
  servicios externos, sin red, sin flags nuevos más allá de `WT_BRAND_PACK` (ya existe).

## 7. Seguridad

- `superficie_expuesta: no`. El cambio lee un `brand.json` local (dato en frontera de confianza) ya
  validado por `parseBrandPack` (se extiende la validación al bloque `composition`). No hay auth,
  endpoints, uploads, pagos, webhooks ni `fetch` a URL de usuario. Sin secretos nuevos.
- Regla CSS vigente: un accent custom no emite `data-accent` (`src/brand.ts:112`); el profile no la
  altera (composición ≠ identidad CSS).

## 8. Plan de pruebas

- **Unit** (determinista, el grueso): `specFor` composición marca↔intent (CA2), parse/validación de
  `composition` (CA1), mapeo `density`→ritmo (CA4), filtro `allowedCategories` con pool vacío (CA5).
- **Integración**: `selectPage` con dos profiles distintos → heros distintos y estables (CA3);
  sin-brand reproduce el actual (CA6).
- **Guard**: el `grep` de CA7 como test de punto único (RNF4).
- **Fuera**: no tests de UI nuevos (la identidad visual ya se cubre con captura en el fix A); piezas
  por-marca (nivel 4) y MCP quedan fuera de v1 (ADR 0003).

## Fases (≤3–5 archivos por fase, mergeables)

- **F1 · canal + regla** (mínima): `Brief.brand?`, `BrandComposition`/`BrandProfile` en `brand.ts`
  con validación, `specFor(role,intent,composition)` con la regla marca↔intent, thread por
  `planSections`→`selectPage`. CA1, CA2, CA6, CA7. Archivos: `types.ts`, `brand.ts`, `plan.ts`,
  `select.ts`/`run.ts` + test.
- **F2 · density + categorías** (happy path): RF5, RF6. CA4, CA5. Archivos: `plan.ts`/`select.ts`,
  `brand.ts` + test + `brandpack.schema.json` (proyectos brand-pack).
- **F3 · styleSet + perfil real de la distro** (edge): poblar `composition` en el brand pack de la distro, CA3 con
  dos marcas reales. Archivos: `brand-pack*/brand.json`, `brandpack.schema.json` + test E2E.
