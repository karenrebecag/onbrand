# Spec: Token map — la marca remapea el contrato Arc completo, no solo 10 tokens

Estado: APROBADO
Research: docs/research/ds-multibrand-brand-profile-composicion.md (arquitectura de tokens en 3 capas)
Origen: MAPPING.md del brand pack de la distro declara el mapeo UIKit→Arc pero el brand pack no tiene canal
para los tokens fuera de accent/surface/fonts. Extiende ADR 0003 (identidad determinista).

## 1. Objetivo

Que un brand pack pueda anclar **cualquier token del contrato Arc** (radii, type scale, motion,
gradientes, control, neutrals), no solo los ~10 de hoy, por el punto único existente
(`resolveIdentity` → `src/identity.css`). Métrica: una marca puede cambiar la forma del DS (p. ej.
radios cuadrados, type scale propia) sin tocar código del motor ni del scaffold.

## 2. Requisitos funcionales

- **RF1.** `BrandPack` gana `tokens?: Record<string, string>`: nombre de token del contrato (`--x`) →
  valor CSS. Opcional; ausente = comportamiento de hoy.
- **RF2.** `resolveIdentity` emite cada par de `tokens` como declaración `:root` en `identity.css`,
  DESPUÉS de accent/surface/fonts, para que el canal general pueda sobrescribir incluso esos
  (determinista, el más general gana).
- **RF3.** Las claves se restringen al **conjunto de tokens del contrato** (los `--x` declarados en
  `foundation.css`, fuente única). Una clave fuera del contrato se **rechaza** en el parse (no se
  inventan tokens nuevos: extender el contrato es decisión aparte, ver MAPPING.md).
- **RF4.** El valor pasa un **guard de gramática CSS** en la frontera de confianza (brand.json es dato
  externo): se rechaza si contiene `;`, `{`, `}`, `@`, `/*`, `*/`, `url(` o `expression(`. Previene
  inyección de CSS por un brand.json malicioso.

## 3. Requisitos no funcionales

- Determinismo (RNF1 del motor): misma marca → mismo `identity.css`, orden estable.
- Sin deps nuevas. El allowlist sale de `foundation.css` ya versionado en el scaffold (cacheado).

## 4. Criterios de aceptación

- **CA1.** `tokens: { "--radius-control": "0.25rem" }` → `identity.css` contiene
  `--radius-control: 0.25rem;`.
- **CA2.** `tokens: { "--no-existe": "1rem" }` → `parseBrandPack` lanza (clave fuera del contrato).
- **CA3.** `tokens: { "--accent": "red; } body { display: none" }` → lanza (guard de valor).
- **CA4.** `tokens` que fija `--accent` gana sobre el `accent` tipado del mismo brand pack
  (canal general al final; orden determinista).
- **CA5.** El allowlist coincide con los `--x` de `foundation.css` (test de sincronía: si el contrato
  suma un token, el allowlist lo refleja sin edición manual).

## 5. Datos

Ninguna entidad nueva. `brandpack.schema.json` (vive en los repos brand-pack, fuera de git) gana la
propiedad `tokens`; se documenta aquí y lo actualiza Karen en esos repos. Este repo solo consume.

## 6. Dependencias

- `templates/arc-scaffold/src/components/arc/foundation.css` como fuente única del allowlist (desde el alpha, en el core la fuente es `templates/base-scaffold/src/theme/tokens.css`, con los mismos nombres). Si
  falta (no debería: se envía con el scaffold), el parse de `tokens` falla cerrado (sin allowlist no
  se valida → se rechaza, no se acepta a ciegas).

## 7. Seguridad

superficie_expuesta: no — no hay endpoint, auth ni red nueva. PERO brand.json es **input en frontera
de confianza**: valores se inyectan en CSS. RF4 (guard de valor) + RF3 (allowlist de claves) son el
control. Sin red → sin familias offensive-*. Sin secretos nuevos.

## 8. Plan de pruebas

- Unit: CA1-CA5 en `tests/brand.test.ts` (o el que exista para brand.ts).
- E2E: una corrida real con un brand pack que trae `tokens` (p. ej. `--radius-*` cuadrados) y
  verificar que `generated/<brief>/src/identity.css` los lleva. Sin trampa: `bun scripts/run.ts`.
- Fuera: remapeo de **dark mode** (`:root[data-theme="dark"]`) — identity.css es :root/light hoy;
  un `tokensDark` es follow-up, no v1.

## Archivos (≤3 en este repo)

1. `src/brand.ts` — tipo `BrandPack.tokens`, `parseTokens` (hermano de `parseComposition`),
   allowlist desde foundation.css, guard de valor, emit en `resolveIdentity`.
2. `tests/brand.test.ts` — CA1-CA5.
3. (si aplica) un helper de lectura del contrato si no conviene en brand.ts.
