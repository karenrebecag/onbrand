# DS base neutral del core (ADR 0017, decisión 1 del 2026-11-05)

Estado: PROPUESTA (decide Karen; la implementa ec) | Autora: Arq | Base: main 339ccfd5 | Fecha: 2026-11-05
Marco DECIDIDO [KAREN:chat 2026-11-05]:

- El core público trae un DS base neutral propio: layout, tipografía, botones y secciones genéricas, que el agente sepa
  usar.
- Arc y los demás entran por el registry de la distro, o los instala cada persona.
- Cita de Karen: "no tiene que ser bonito; tiene que ser suficiente para que un clon limpio genere una página".
- Cumple la gramática de ADR 0011: el agente escribe `src/sections/<rol>.tsx` importando átomos y componentes del DS
  (`0011-agente-escribe-como-v0.md:45`). Los bloques son referencia y molde, no catálogo (:53-55).

Nombre: el orquestador ya usa B8 para `orquestador-enrutamiento.md`. Esta spec es **B9**.

## 1. Qué consume hoy el agente (inventario en main 339ccfd5)

### 1.1 El registry publicado (`registry/`, lo lee `fileRegistry`)

- Índice `registry/index@8e6eb7df351eb116.json`: 339 entradas.

  | origen (`importPath`) | entradas |
  |---|---|
  | Arc (`@/components/arc/...`) | 235 |
  | relume | 37 |
  | morphin | 15 |
  | bencho | 2 |
  | sin `allow` (libs: 44 motion, 4 relume, `arc-motion-tokens`, `components-brand-icons`) | 50 |

- Por tipo, con `allow`:
  - **componentes:** data 39, special 37, inputs 33, actions 14, disclosure 11, feedback 9, text 4;
  - **bloques:** app-ui 39, features 36+, faq 7, pricing 7, cta 6, hero 5+3, testimonials 5, footers 4, logos 4,
    navbar 4, stats 4, steps 1;
  - **layout:** 6.
- Skill del agente: `registry/skills/arc-agent@6483fa6d860420f6.json`, `AGENT_SKILL_ID = 'arc-agent'`
  (`src/skill-registry.ts:8`). Son 40 archivos:
  - `SKILL.md`, `allowlist.json`, `icons.json` y `v0.json` (política de layout, `serve.ts:167`);
  - 5 de `assets/starter` (`main.tsx`, `index.css`, `identity.css`);
  - 31 `references/`: una guía por categoría y una por rol de bloque (`block-hero`, …, `block-footer`), más
    `components/layout.md`.
- `serve.ts:79-87`: en core, el skill sale de `registry/`. Si falta, el arranque falla (exit 2).

### 1.2 El scaffold (`templates/arc-scaffold`, `scaffoldDir` en `serve.ts:308`)

El scaffold se copia en cada ws (`src/runtime/workspace.ts`, `prepareWorkspace`).

Lo que es infraestructura del core y no de Arc, aunque hoy viva dentro de él:

| pieza | dónde | qué es |
|---|---|---|
| gramática de layout | `src/components/layout/layout.tsx` + `layout.css` | `Section`, `Stack`, `Grid`, `Cluster`, `Split`, `Text`, `Image` (:43-114). Es la de ADR 0011, y es propia |
| boundary por sección | `src/wt-section.tsx` | lo citan `section-ops.ts:29` y el render |
| puentes del preview | `src/wt-*-bridge.ts`, `wt-bridges.ts`, `wt-hmr-recover.ts`, `wt-source.ts` (`bridgesDir()`) | `preview-vite.config.ts:14` |
| shims | `src/shims/next-image.tsx` | `ds-registry.ts:188` (`STARTER`) |
| starter | `main.tsx` (neutral); `index.css` NO es neutral: importa `@fontsource-variable/{geist,inter}`, `components/arc/foundation.css` y `skins/whatsapp.css` (:5-9) | lo copia `build-ds-skill.ts:288` |

El **contrato de tokens de marca** está en `src/components/arc/foundation.css`. Lo leen tres lugares:
- `brand-pack.ts:20` (`CONTRACT_CSS`);
- `src/theme/contract-roles.json:3`;
- `tools/porter/token-map.relume.ts:13`.

Los brand packs de `brands/` sobrescriben esos nombres.

Las dependencias del scaffold son: `react`, `react-dom`, `lucide-react`, `clsx`, `motion`, `gsap`, `@gsap/react`, `three`,
`@paper-design/shaders-react`, `@number-flow/react`, 9 `@radix-ui/*`, `@fontsource-variable/{inter,geist}` y
`@usespaceui/{avatars,emoji}`.

### 1.3 Quién construye eso (y por qué un clon no puede rehacerlo)

- `scripts/build-registry.ts:44-76` lee `SCAFFOLD` y el **vault** (`VAULT_ROOT`, `staticGateOf`, `:50`). Por eso
  `serve.ts:85` dice "build-registry --local lo genera donde está el vault". Un clon limpio consume `registry/`, pero no lo
  puede regenerar.
- Los siguientes también apuntan a `templates/arc-scaffold` y son herramientas de Arc o del porter, no del camino del
  agente:
  - `build-ds-skill.ts:37-41`;
  - `catalog.ts:13`, `catalog-ingest.ts:26`;
  - `compliance.ts:375,475,536`;
  - `gen-schemas.ts:19`, `gen-theme-presets.ts:8`;
  - `motion-render-gate.ts:27`;
  - `brandpack-red.ts:18`, `block-contract.ts:10`;
  - `svg-to-icons.ts:14`, `ingest-sample-build.ts:36`;
  - `src/adapters/arc.ts:208,390`, `src/catalog/ingest-ported.ts:85`, `src/registry.ts:22`;
  - `tools/porter/build.ts:17`, `deps-root.ts:33,39`.
- `scripts/e2e-core-clone.ts:46` instala `templates/arc-scaffold`. D3 (`:49-70`) monta todo el índice desde `registry/` y
  pide el skill `arc-agent`.

## 2. Qué trae el DS base (mínimo, neutral, propio)

### 2.1 Tokens (contrato de marca)

- `templates/base-scaffold/src/theme/tokens.css` lleva **los mismos nombres de token** que clasifica
  `src/theme/contract-roles.json` (112), salvo una lista declarada `ARC_ONLY` de 10:
  - `--arc-gradient`, `-foreground`, `-from`, `-ink`, `-line`, `-soft` y `-to`;
  - `--whatsapp`, `--whatsapp-foreground` y `--button-whatsapp-foreground`.

  Ningún pack de `brands/` los usa (grep 0). Los tres de whatsapp ya figuran como `THIRD_PARTY_TOKENS` en `brand.ts:69`.
  `ARC_ONLY` cae en el paso 5.
- Los valores son neutrales: grises, un acento, escala modular y la pila de fuentes del sistema (sin `@fontsource`).
- `--duration-spring: 500ms`, `--neutral-0: #ffffff` y `--background: #121212` en oscuro (`tokens.css:111`, `:8`, `:116`):
  valores de base; el brand pack los sobrescribe (decisión 18).
- `index.css` del base lleva `tokens.css`, `identity.css` y el reset, sin `@fontsource` ni skins.
- **El contrato también aporta valores, no solo nombres.** `CONTRACT_CSS` (`brand-pack.ts:20`) alimenta
  `contractThemes()` (:363-367), y de ahí salen:
  - los temas por marca;
  - el gate AA (`brand.ts:40,258`);
  - el seed (`brand-pack.ts:268`).

  Además, `gen-theme-presets.ts:8` genera `contract.json` y `presets.json` desde `foundation.css` (los consume
  `derive.ts`). Por eso los lectores (`CONTRACT_CSS`, `contract-roles.json` "contract"/"source", `gen-theme-presets`,
  `contract.json`/`presets.json`) se mudan en el **paso 4**, junto con `scaffoldDir`: el contrato sigue al scaffold del
  perfil. Mudarlos antes mediría los ws de `arc-scaffold` contra valores que no renderizan.
- Criterio, con un test: los nombres de `tokens.css` son iguales a los de `contract-roles.json` menos `ARC_ONLY`. Ningún
  token que use un pack de `brands/` queda sin destino.

### 2.2 Gramática de layout

La API se mantiene (`Section`, `Stack`, `Grid`, `Cluster`, `Split`, `Text`, `Image`), con `references/components/layout.md`.
Pero no se muda tal cual: `layout.tsx:3` importa `../arc/carousel/carousel` (el modo carrusel de `Grid`). El base lleva su
propio `layout.tsx` sin Carousel (`Grid` sin modo carrusel) en el paso 3, y el de `arc-scaffold` no cambia.

### 2.3 Átomos (componentes con props)

Son 10, uno por categoría que hoy usan los bloques de `references/block-*`. Sin dependencias fuera de `react` y
`react-dom`.

| átomo | categoría | props de contenido | notas |
|---|---|---|---|
| `Button` | actions | `label`, `href?`, `variant: primary\|secondary\|ghost`, `size?` | `<a>` si hay `href`, si no `<button>` |
| `Link` | actions | `label`, `href` | |
| `Heading` | text | `level: 1-4`, `children` | además del `Text` de layout, por semántica |
| `Badge` | feedback | `label`, `tone?` | |
| `Icon` | special | `name` | set propio pequeño en SVG inline (`check`, `arrow-right`, `menu`, `x`, `plus`, `minus`, `star`, `quote`), sin `lucide-react` |
| `Avatar` | data | `name`, `src?` | iniciales si no hay `src` |
| `Card` | data | `title`, `body?`, `media?`, `action?` | |
| `Accordion` | disclosure | `items: { title; content }[]` | `<details>`/`<summary>`, sin Radix |
| `Input` | inputs | `label`, `name`, `type?`, `placeholder?` | |
| `Textarea` | inputs | `label`, `name`, `rows?` | |

### 2.4 Bloques de sección (referencia y molde, ADR 0011)

Son 11, uno por rol de `references/block-*` de hoy. Cada uno es un `.tsx` que compone solo layout más átomos, con props de
contenido según el contrato de bloque (ADR 0009, ahora reglas del skill): textos, `items[]`, `media` y `actions[]`.

| bloque | props de contenido |
|---|---|
| `navbar` | `brand`, `links[]`, `action?` |
| `hero` | `eyebrow?`, `title`, `subtitle?`, `actions[]`, `media?` |
| `features` | `title`, `items: { icon?; title; body }[]` |
| `logos` | `title?`, `logos: { name; src? }[]` |
| `stats` | `items: { value; label }[]` |
| `steps` | `title`, `items: { title; body }[]` |
| `testimonials` | `items: { quote; name; role? }[]` |
| `pricing` | `plans: { name; price; features[]; action }[]` |
| `faq` | `title`, `items: { title; content }[]` |
| `cta` | `title`, `subtitle?`, `actions[]` |
| `footer` | `brand`, `columns: { title; links[] }[]`, `legal?` |

Sin motion. El DS base no publica `motion-*` y el skill dice que no hay motion. Si una distro quiere motion, lo trae por su
registry.

### 2.5 Skill del agente

- `base-agent` vive en `templates/base-scaffold/skill/`, y no sale de `build-ds-skill.ts`, que es de Arc y del vault
  (`:37`, `:288`).
  - **Se escriben a mano:**
    - `SKILL.md`;
    - `references/<categoría>.md` y `block-<rol>.md`;
    - `components/layout.md`, adaptado del de Arc sin carrusel.
  - **Se generan del código:**
    - `allowlist.json`: 10 átomos, 7 de layout y 11 bloques, con las props leídas de sus interfaces;
    - `icons.json`, desde `ICON_NAMES` de `ui/icon.tsx`;
    - `v0.json`;
    - `assets/starter`: `main.tsx`, `index.css`, `identity.css` del base y un `App` vacío.
  - Un test compara `allowlist.json` con los exports.
- `AGENT_SKILL_ID` pasa a ser configuración: `base-agent` en core; la distro pone `arc-agent` en sus `defaults`.

## 3. Dónde vive

| pieza | ruta |
|---|---|
| scaffold | `templates/base-scaffold/` (infraestructura de §1.2 + tokens + layout + átomos + bloques) |
| registry del core | `registry/` regenerado desde `templates/base-scaffold` |
| constructor | `scripts/build-base-registry.ts`, un constructor aparte. `build-registry.ts` lee catálogo y vault (:48-54, :61, :77-78) y aplica `extensionPoints` (:125), y un flag mezclaría dos constructores. El nuevo lee `templates/base-scaffold/src/components` y escribe el mismo formato (`index@sha`, `latest.json`, `skills/<id>@sha`). Reusa `buildIndex`, `hashItem`, `guidePath` y `readSkillPack`, sin catálogo, vault, gates, motion ni extension points. Así un clon puede regenerarlo |
| registry del base hasta el paso 4 | `registry-base/`, versionado. `registry/` sigue siendo el de Arc, porque es el default actual (`serve.ts:79-87`, un solo `latest.json`). En el paso 4 `registry-base/` pasa a `registry/`, junto con `scaffoldDir` y `agentSkillId`, y el de Arc sale con la distro. No se mezclan los dos skills en un índice |
| materialización | los ítems del base **se publican con sus archivos**, y `ITEM_ROOTS` (`src/runtime/registry.ts:48`) suma `src/components/ui/`, `src/components/blocks/` y `src/components/layout/`. Que `prepareWorkspace` ya copie el scaffold no alcanza, por dos razones: D3 de `e2e-core-clone.ts` exige que cada componente del skill se materialice desde el registry, y el pin del DS por versión con "Actualizar DS" (C3) solo funciona si los ítems salen del registry y no de la copia del scaffold |
| scaffold de la distro | `templates/arc-scaffold` sale a el repo de la distro con sus herramientas de §1.3. Mientras tanto queda en la excepción fechada de la guarda B3 (como `src/adapters/vercel-blob/`) |

Configuración nueva: `scaffoldDir` y `agentSkillId` en `Config` y en `DEFAULT_KEYS` de `src/profile.ts`. El core usa
`templates/base-scaffold` y `base-agent`; la distro los pone en sus `defaults`.

El `package.json` de `templates/base-scaffold` es una copia del de `arc-scaffold` sin Arc, Tailwind ni motion, en
versiones que ya están en el lockfile. DECIDIDA [KAREN:chat 2026-11-05, "aprobadas las deps sobre el scaffold"].

Lleva `react`, `react-dom` y `vite`, y además dos dependencias de desarrollo que el core necesita del ws, porque las carga
de ahí:
- `typescript`: la edición determinista por AST (decisión 5) lo carga del ws (`direct-edit.ts:50-51`, `edit-runs.ts:257`).
  Sin él, cada edición directa responde 409 "el workspace no tiene typescript instalado".
- `@vitejs/plugin-react`: el preview compila JSX con vite.

Las dos están incluidas: DECIDIDA [KAREN:chat 2026-11-05, "si si", ante la pregunta por `typescript` y `@vitejs/plugin-react`].

Lleva también `@types/react` y `@types/react-dom` (dependencias de desarrollo): son los tipos de `react` y `react-dom`, que
ya estaban aprobados, y los pide `tsc -p tsconfig.app.json` en `build`. Entran por la aprobación general ("aprobadas las
deps sobre el scaffold"), no por una decisión aparte.

Lista completa (`templates/base-scaffold/package.json`, #832):
- dependencias: `react`, `react-dom`;
- de desarrollo: `vite`, `typescript`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`.

Cualquier otra dependencia necesita un OK nuevo.

## 4. Cómo se sustituye `arc-scaffold` sin romper nada

Va en PRs mecánicos, en este orden. Cada uno deja el clon limpio en verde.

1. **Extraer la infraestructura** de §1.2 a `templates/base-scaffold/src`, que pasa a ser la fuente. Son 12 archivos:
   - `wt-section.tsx`, `wt-bridges.ts`, `wt-hmr-recover.ts`, `wt-source.ts`;
   - `wt-error-bridge.ts`, `wt-size-bridge.ts`, `wt-reveal-bridge.ts`, `wt-select-bridge.ts`, `wt-theme-bridge.ts`;
   - `shims/next-image.tsx`, `main.tsx`.

   Reglas del paso:
   - `arc-scaffold` conserva copias byte a byte, con un test que las compara. No las puede importar, porque
     `prepareWorkspace` copia solo `scaffoldDir` (`workspace.ts:28`) y las herramientas de §1.3 compilan dentro de
     `arc-scaffold`.
   - `bridgesDir()` (`preview-vite.config.ts:14`) apunta a `base-scaffold/src`.
   - Quedan en `arc-scaffold` hasta su paso: el layout (paso 3), `index.css` (el base trae el suyo en el paso 2, sobre
     `tokens.css`) y `STARTER.name` (`ds-registry.ts:188`, paso 4).
   - Sin `package.json` todavía: entra en el paso 3 o 4, cuando el base compile solo. El `main.tsx` del base importa
     `./index.css` y `./App.tsx`, que llegan en los pasos 2-3.
   - Las copias de Arc caen en el paso 5. Sin cambio de conducta.
2. **Tokens base e `index.css` del base** (§2.1), con el test de nombres contra `contract-roles.json` menos `ARC_ONLY`.
   Los lectores del contrato no cambian todavía: se mudan en el paso 4. Sin cambio de conducta.
3. **Átomos, bloques y skill `base-agent`** (3a: scaffold; 3b: `build-base-registry.ts` escribe `registry-base/` y
   `ITEM_ROOTS` suma las carpetas del base).
4. **Cambio de default:** `scaffoldDir` y `agentSkillId` pasan al base, y con ellos los lectores del contrato de tokens (§2.1). `e2e-core-clone.ts:46` instala
   `templates/base-scaffold`, y D3 pide `base-agent`.
5. **Arc a la excepción de la guarda,** y salida a la distro con el primer alpha (mismo mecanismo que Blob).

Porter y herramientas de Arc (§1.3): siguen apuntando a `arc-scaffold` hasta salir con él. No forman parte del clon limpio.
`tools/porter` recibe la ruta por parámetro en el paso 5, no antes.

## 5. Qué queda fuera del core

- Arc, relume, morphin y bencho, más sus herramientas de §1.3, `motion-*` y `@usespaceui/*`: van a la distro.
- Las fuentes `@fontsource` y las dependencias pesadas (`three`, `gsap`, shaders, `@number-flow`, Radix): van a la distro.
- La curación desde el vault: es de la distro, porque el vault es de Karen.

No es parte de esto el DS del builder (`apps/builder/src/components/arc/`): es la UI de la app, no el DS de las páginas
generadas, y se queda en el core por la decisión 16 (`docs/notas/decisiones-pendientes-2026-11-04.md` §3), con sus dos bloques
de Arc Pro tratados bajo slots. No entra a `ARC_PATHS`.

## 6. Criterio de aceptación

1. Un clon limpio (`scripts/e2e-core-clone.ts`) sin `templates/arc-scaffold` instalado pasa D1-D3. Con `--fixture`
   (snapshot de #790) genera una página con preview 200.
2. El mismo clon, con el agente (`bun scripts/serve.ts`, CLI `claude` logueado), genera una página de al menos 4 secciones
   (`navbar`, `hero`, una de contenido, `footer`). La página importa solo átomos y layout del DS base, y pasa
   preview-check sin issues de `RUNTIME_KINDS` (incluye `broken-image`; el render-gate se borró en #854).
3. `brands/brand-pack-ejemplo` aplicado sobre esa página cambia el color de acento y la tipografía, sin tokens huérfanos.
4. La guarda B3 sigue verde. `templates/base-scaffold` no tiene dependencias fuera de `react`, `react-dom` y `vite`, y lo
   comprueba un test sobre su `package.json`.
5. No es criterio que la página sea bonita (cita de Karen).

## 7. Abierto

Nada. Las dependencias del scaffold base se decidieron el 2026-11-05 (§3).
