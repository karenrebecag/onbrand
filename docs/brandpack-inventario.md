# Inventario del brandpack y su radio de impacto

Mapa de código para dimensionar un rediseño del schema del brandpack. Verificado contra `origin/main` en el commit `b7d1f2a5`. Todos los anchors son `archivo:línea` de ese árbol. No propone diseño: describe qué hay y qué depende de su forma.

El brandpack es la **capa 1 (identidad)** sobre la **capa 2 (contrato de tokens de Arc)**, que vive en `templates/arc-scaffold/src/components/arc/foundation.css` (115 declaraciones `--x`; desde el alpha ese archivo es de la distro y el core lleva los mismos nombres de token en `templates/base-scaffold/src/theme/tokens.css`). Lo que el pack no declara se hereda del contrato.

---

## 1. Estructura actual del brandpack

### 1.1 `brands/brandpack.schema.json` (brand.json)

Raíz: `additionalProperties:false`, `required: ["name","accent"]` (`brandpack.schema.json:8-11`). Campos:

| Campo | Tipo | Oblig. | Qué es | Anchor schema |
|---|---|---|---|---|
| `name` | string | sí | Nombre de marca | `:17-21` |
| `accent` | preset \| objeto | sí | Acento: preset del contrato o `{base,strong,subtle,foreground?}` | `:39-84` |
| `logo` | string (ruta rel.) | no | svg/png/webp dentro del pack | `:22-26` |
| `logoDark` | string | no | Logo para zonas oscuras | `:27-31` |
| `logoKind` | `wordmark`\|`mark` | no | wordmark = el archivo ya trae el nombre | `:32-38` |
| `surface` | objeto | no | `{background,surface,foreground,textSecondary}` | `:85-107` |
| `fonts` | objeto | no | `{display,body,import}` | `:108-124` |
| `composition` | objeto | no | Sesgo determinista `{roles,density,styleSet}` | `:125-172` |
| `tokens` | map `--x`→valor | no | Ancla cualquier token del contrato (light) | `:173-182` |
| `tokensDark` | map `--x`→valor | no | Igual bajo `[data-theme="dark"]` | `:183-192` |
| `inherit` | map `--x`→motivo | no | Tokens dejados en el default, con MOTIVO (no valor) | `:193-203` |
| `requires` | `{ds}` | solo con components | Pin del DS contra el que se validaron variantes | `:204-218` |
| `components` | map | no | Variantes de marca por componente | `:219-225` |

Nota: el schema declara `composition.{roles,density,styleSet}`, pero el parser acepta además `composition.rhythm` (`brand.ts:367-373`) — divergencia schema/código no cubierta por el test de sincronía (ver §3).

### 1.2 `brands/facts.schema.json` (facts.json)

Raíz: `additionalProperties:false`, **sin `required`** (todo opcional). Campos: `domain` (`:12-17`), `whatsapp` (`:18-22`), `channels` (`:23-32`), `clients[]` (`:33-66`, req `name`), `metrics[]` (`:67-97`, req `label,value,source`), `testimonials[]` (`:98-142`, req `quote,person`), `prices[]` (`:143-186`, req `plan,price`). Textos ≤300 chars, listas ≤12.

**`tracking` NO está en el schema ni en `FACTS_KEYS`** (`brand-facts.ts:65`), pero sí en la interfaz `BrandFacts` (`brand-facts.ts:28-33`): es un campo de overlay en runtime (companyToken + whatsapp por idioma), inyectado por la fuente viva, no por el pack. Ver §2.4.

### 1.3 El pack de ejemplo (`brands/brand-pack-ejemplo/`)

- `brand.json`: accent **custom** (`base/strong/subtle/foreground`), surface de 3 campos, fonts `{display:Fraunces, body:Inter}`, `tokensDark` de 7 tokens, y un bloque `inherit` de **~97 tokens** cada uno con el motivo `"default del contrato"` / `"rampa neutral…"`.
- `facts.json`: solo `{domain:"example.com"}`.
- `DESIGN.md`: frontmatter YAML (`name`, `colors`, `typography`) + prosa en 3 secciones (`## Brand & Style`, `## Colors`, `## Typography`). Los valores son copia de los tokens.
- `logo.svg`: wordmark generado (rect con `#c2410c` + `<text>` "Ejemplo" en Fraunces) — derivable de name+accent+font.

### 1.4 El pack Base (`brands/brand-pack/brand.json`)

`{name:"Base", accent:"neutral"}` + el **mismo bloque `inherit` de ~97 tokens** que el ejemplo. No trae surface/fonts/tokens/logo/facts/DESIGN.md: es el neutro agnóstico. El `inherit` es casi idéntico entre Base y Ejemplo → boilerplate, no identidad (ver §4).

---

## 2. Loader y consumidores

### 2.1 `src/brand.ts` (662 líneas) — parse, resolución, aplicación

- **Parse/validación** (frontera de confianza): `parseBrandPack` (`brand.ts:124-177`) → `onlyKeys` contra `BRAND_PACK_KEYS` (`:29`), accent preset/custom (`:129-149`), `parseTokens` con allowlist del contrato + guard CSS `UNSAFE_TOKEN_VALUE` (`:292-308`), `parseInherit` (`:203-214`), `parseComposition` (`:336-384`), `parseFonts` con `FONT_IMPORT` (`:325-331`), `parseLogo` anti-traversal (`:73-80`). `withComponents` valida variantes contra el pin del DS (`:179-189`).
- **Allowlist de tokens** = nombres de `foundation.css`, cacheado (`contractTokens` `:267-275`); defaults claro/oscuro del contrato (`contractThemes` `:279-288`).
- **Cobertura / cierre de contrato (C1)**: `brandCoverage` (`:238-251`) separa `defined` (identidad real: accent+surface+fonts+tokens) vs `inherited` (bloque `inherit`) vs `missing`; `assertBrandCoverage` (`:256-261`) falla si queda cualquier token sin definir ni heredar. Excepciones que no cuentan como fuga: `FORM_LEVERS`, `DERIVED_TOKENS`, `THIRD_PARTY_TOKENS` (`:225-231`).
- **tokens → CSS**: `resolveIdentity` (`:400-441`) baja el pack a `htmlAttrs` (data-accent para preset) + `rootDeclarations` + `darkDeclarations`; `identityCss` (`:467-474`) emite `:root,[data-theme]{…}` y `[data-theme="dark"]{…}`. Orden de precedencia: accent → surface → fonts (`--font-geist`/`--font-inter`) → `tokens` al final (puede pisar todo).
- **Aplicación al workspace**: `applyBrand` (`:538-579`) escribe `src/identity.css`, copia `fonts/`, copia logos a `public/brand/logo.<ext>`, escribe `src/brand.ts` (`brandModule` `:105-121`, lo que pinta `BrandMark`), copia `DESIGN.md`, y fija `data-accent` en `index.html`. `brandFontsHref` (`:450-453`) añade el `<link>` de Google Fonts.
- **Resolución del pack activo**: `activeBrandDir` (`:610-612`) y `resolveBrandTrace` (`:630-642`) con precedencia **Brief.brand > `WT_BRAND_PACK` > base**; el base sale de `config().brandsRoot` (`fallbackBaseDir` `:659-662`). `loadBrandComposition` (`:653-657`) para el planner.

### 2.2 `src/brand-detect.ts` / `src/brand-registry.ts`

- `detectBrand` (`brand-detect.ts:10-15`): si el prompt nombra el id de un pack publicado, carga ese pack (id ≥3 letras, nunca `base`).
- `brand-registry.ts`: empaqueta el pack para el Blob (`readBrandPackItem` `:44-60` — solo brand.json, fonts si `fonts.import` los usa, logos, DESIGN.md), lo baja y reescribe con anti-traversal (`writePackFiles` `:86-93`), convención de carpeta `brand-pack[-<id>]` (`brandDirName`/`brandIdOfDir` `:18-23`).

### 2.3 `src/brand-facts.ts` — hechos → prompt

`parseBrandFacts` (`:103-119`) valida; `brandFactsLines` (`:131-141`) arma el bloque "DATOS REALES" del prompt (domain, whatsapp→wa.me, clients, metrics, testimonials, prices). `factsForLang` (`:56-59`) elige el whatsapp del idioma desde `tracking`. `parseTracking` (`:40-53`) valida companyToken (UUID) + whatsapp por idioma — el único consumo de `tracking`.

### 2.4 `src/brand-facts-source.ts` — overlay vivo (la "variante WhatsApp")

`loadFacts` (`:49`) baja hechos de una fuente viva; `webflowFacts` (`:183`) es la fuente Webflow; `parseSnapshot` (`:251-312`) construye los facts y, en `:311`, llama `parseTracking(raw.config.companyToken, raw.config.whatsapp)` e **inyecta `tracking`** sobre los facts del pack. `mergeFacts` (`:335`) combina pack + vivo. Es decir: el tracking de WhatsApp/SDK NO es del pack sino de la fuente viva por marca — hoy acoplado a la forma Webflow.

### 2.5 Resto

- `src/identity-ephemeral.ts`: identidad que el agente declara cuando NO hay pack; `checkPackDesign` (`:148`) valida DESIGN.md contra el brand.json; `packDesignFrontmatter` (`:163`) **genera** el frontmatter de DESIGN.md desde el pack; `FONT_LIST` (`:17`) = fuentes cargables; `PACK_MARKER` (`:54`) marca identity.css de pack.
- `src/identity-design.ts`: `DESIGN_COLOR_ROLES` (`:14-24`) mapea roles del frontmatter (Material 3) → tokens; `checkDesignMd` (`:55-86`) valida que DESIGN.md sea copia fiel de identity.css.
- `src/brand-components.ts`: variantes de marca sobre extension points; `parseComponents` (`:76`), `variantsCss` (`:143`), `variantContrastErrors` (`:124`), `brandVariantFiles` (`:158`).
- `src/brand-skill.ts` / `src/skill-brand.ts`: `brandSkillParts` (`brand-skill.ts:177`) arma la skill de marca (colors.md, logos.md, variants.md) con chequeo de contraste `MIN_CONTRAST=4.5`.
- `src/brand-sensors.ts`: `brandSensors` (`:42`) mide la página contra lo esperado de la marca (accent, typeface, background, logo…).

### 2.6 Dónde entra al render (pipeline)

- Runner determinista: `scripts/run.ts:106-107` (`resolveBrandTrace`, `loadBrandComposition`), emisión en `src/emit.ts:259-260` (`applyBrand` + `writeBrandVariants`).
- Camino v0/agente: `src/runtime/runner.ts:472,513` (applyBrand al crear workspace), `src/runtime/server.ts:1588` (apply por turno), `:1748-1793` (POST `/runs {applyBrand:<id>}` sin agente), `:2605` (variantes); `scripts/serve.ts:211` (`workspaceBrandDir`).
- Prompt/imágenes: `src/runtime/agent-prompt.ts:109` y `src/runtime/image-step.ts:121` (`brandFactsLines`); `src/runtime/agent-composer.ts:127,242` (`writeBrandSkill`, `factsForLang`); facts vivos en `server.ts:1541`, pack facts en `:1590`, skill en `:2245`.

---

## 3. Radio de impacto si cambia la estructura

**Contrato duro schema ↔ código**: `tests/brand-schema.test.ts:17-67` afirma que las claves del schema son EXACTAMENTE `BRAND_PACK_KEYS`/`FACTS_KEYS`/`ACCENT_KEYS`/`SURFACE_KEYS`/`FONT_KEYS` y que `required` = `["accent","name"]`. Cualquier cambio de schema **debe** actualizar en el mismo commit los constants de `src/brand.ts:29-32` y `src/brand-facts.ts:65-71`, o este test falla. Es el primer punto a tocar.

**Tests acoplados a la forma del pack** (14): `brand-base-coverage`, `brand-components`, `brand-composition`, `brand-load`, `brand-registry`, `brand-schema`, `brand-skill`, `brand-tokens`, `brands-en-repo`, `check-brand`, `compose-layers`, `flow-log`, `identidad-pagina`, `router`. Facts (4): `brand-facts-source`, `brand-facts`, `brand-schema`, `wa-sdk`.

**Fixtures**: `tests/fixtures/brand-rotundo.json` (pack de control para medir forma). `tests/check-brand.test.ts:34` y `tests/identidad-pagina.test.ts:110` cargan los packs reales `brands/brand-pack` y `brands/brand-pack-ejemplo` del repo — cambiar su forma rompe estos tests.

**Conteo de referencias** (code+tests+brands, `*.ts`/`*.json`): `accent` 133, `surface` 141, `tokens`/`tokensDark` 12, `inherit` 10, `composition` 28, `requires` 6, `components` 30, `logoKind` 7. accent y surface son los campos más enraizados.

**Dónde se derivan tokens hoy vs dónde se exige la rampa completa**:
- Hoy NO se derivan colores: accent custom exige `base+strong+subtle` a mano (`brand.ts:138-139`); surface y `tokensDark` son valores literales del pack. Lo único que se deriva automáticamente es el `<link>` de fuentes (`googleFontsHref`, `brand.ts:450`) y el frontmatter de DESIGN.md (`packDesignFrontmatter`, `identity-ephemeral.ts:163`).
- La rampa completa se **exige** en el cierre de contrato C1 (`assertBrandCoverage`, `brand.ts:256`), llamado desde `resolveBrandTrace` (`brand.ts:639`): por eso cada pack arrastra el bloque `inherit` de ~97 tokens. Es bookkeeping, no identidad.

---

## 4. Lo que hoy es input manual y bajo un modelo paramétrico (pocas semillas → derivar) podría derivarse

Semillas mínimas plausibles: **name, accent.base (1 color), un seed de background, familia display, familia body, logo (o solo el name para wordmark)** + datos reales (facts) + prosa de intención (DESIGN.md). Lo demás es derivable:

1. **`accent.strong` / `accent.subtle` / `accent.foreground`** (hoy manual, `brandpack.schema.json:59-81`): derivables de `base` (oscurecer, alpha, contraste AA — ya hay `contrast()` en `brand-skill.ts:41`).
2. **`surface` completo** (background/surface/foreground/textSecondary): derivable de un seed de fondo + rampa neutral del contrato.
3. **`tokensDark`** (hoy mapa literal de 7+ tokens): derivable aplicando la misma transformación de identidad sobre los defaults oscuros del contrato (`contractThemes().dark` ya existe, `brand.ts:279`).
4. **`inherit` (~97 tokens de boilerplate)**: no es identidad; es el acuse del cierre C1. Se puede autogenerar (todo token no definido por un canal → heredado con motivo por categoría) y sacarlo del archivo de marca por completo. Es la mayor reducción de superficie manual.
5. **`DESIGN.md` (frontmatter)**: ya se genera con `packDesignFrontmatter` (`identity-ephemeral.ts:163`); solo la prosa es humana. Hoy se mantiene a mano y un test castiga el drift (`identity-design.ts:55`).
6. **`logo.svg` wordmark**: el del ejemplo es rect+text derivable de name+accent+font; para `logoKind:wordmark` sin asset propio se puede generar.
7. **fonts `import`/href**: ya derivado del nombre de familia (`brand.ts:450`).

Se quedan como palanca manual (criterio, no derivable): `composition.{roles,density,rhythm,styleSet}`, `components` (variantes sobre el DS), `requires.ds`, `logoKind`, y todo `facts`/`tracking` (datos reales, no se inventan).

**Observación para el rediseño**: el `tracking` de WhatsApp (la "variante") hoy entra por la fuente viva Webflow (`brand-facts-source.ts:311`), no por el pack. Si se quiere como parámetro del pack hay que moverlo al schema de facts (hoy ausente de `facts.schema.json` y `FACTS_KEYS`) y repuntar a `parseTracking`.
