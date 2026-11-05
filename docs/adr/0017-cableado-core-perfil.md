# ADR 0017: onbrand es un core agnóstico; cada distribución es un repo aparte

Estado: PROPUESTO (recomendación de Arq; decide Karen) | Fecha: 2026-11-05 | Autora: Arq | Base: main cdbce093
Marco: DECIDIDO [KAREN:chat 2026-11-05, G1 corregida, trasladada por WebTransformerOrq]:

- "una distro debería estar totalmente separada. Onbrand es un core agnóstico NO anclado a una distro, que se puede
  distribuir como open source; a partir del repo white label se crean distribuciones";
- "el Vercel Blob es infra de Atom".

La primera distro es `karenrebecag/onbrand-atom` (privado, lo crea Karen). Lo que propone este ADR es cómo se cumple
ese marco, no el marco.

Decidido además el 2026-11-05 (todas DECIDIDA [KAREN:chat 2026-11-05], trasladadas por WebTransformerOrq):
- **Distro = repo aparte.** `karenrebecag/onbrand-atom` consume un tag del core y queda congelado, solo con su README,
  hasta 0.1.0.
- **Blob = infra de Atom.** Sale del core con la distro.
- **Runner retirado (C5).** Lo hace Secondary en 3 PRs: B1, B2 y B3 (#770 fue el primero).
- **Fase 5 = Clerk en la distro, sobre el verifier `jwt` agnóstico del core** (#771, #777).
- **Pendientes de este ADR delegados.** Karen delegó todos los pendientes bajo este ADR: no hay OK por PR, y Arq revisa
  post-merge. Cada deploy sigue con su OK (decisión 7).

Decidido además el 2026-11-05, por brief de Karen (todas DECIDIDA [KAREN:chat 2026-11-05], trasladadas por WebTransformerOrq):

1. **DS base del core público: opción (a).** Es un DS base neutral propio, con layout, tipografía, botones y secciones
   genéricas, que el agente sepa usar. Arc y los demás entran por el registry de la distro, o los instala cada persona.
   - Cita de Karen: "no tiene que ser bonito; tiene que ser suficiente para que un clon limpio genere una página".
   - Cumple la gramática de ADR 0011: átomos más bloques de sección con props de contenido.
   - Lo especifica `docs/spec/ds-base-neutral.md`.
2. **`package.json` del alpha.**
   - `exports`/`bin` son: `session-provider` (`setSessionProvider`, `SessionProvider`), `App`, `serve`, el orquestador y
     `build-registry`.
   - LICENSE MIT.
   - `@vercel/blob` sale en el mismo PR del alpha.
3. **Repo público.** Será un repo nuevo, con historial limpio, en el primer alpha y no antes. El repo actual sigue privado.
4. **Operativo.**
   - `tsc --noEmit` en `ci.yml` (#802).
   - La reserva de gasto de 16k se queda, y el tope diario va aparte: no se mezclan.
   - Las cifras de `routes.ts:18` y `local-sandbox.ts:44` se quedan hasta medirlas en el deploy de prueba.
   - Cada deploy lleva su OK.
5. **Sin cambio:** H2 paso 2, colector OTLP, compresión del hilo, H7d/H7e y Figma.

Orden que destraba el alpha: DS base → `package.json` + LICENSE → tag `0.1.0-alpha.1` → repo público → código en
`onbrand-atom`.

## Contexto (main cdbce093)

**Configuración.** `src/config.ts` conoce a `atom`:
- `PROFILES = ['core', 'atom']` en :9;
- los defaults de `atom` en :67-84, con el vault de la máquina de Karen en :75 y el HACK del compose en :69;
- `IMAGE_PROVIDERS` incluye `atom-knowledge` en :16.

**Cableado.** `scripts/serve.ts` elige adaptadores con `if`:
- verifier en :157-160;
- publish en :275;
- guard del proxy en :149-150;
- y nombra `atom` 14 veces.

**Dependencias de Atom en el core.**
- `@vercel/blob` está en `package.json:21`.
- Lo importan dos archivos:
  - `src/orchestrator/vercel-blob.ts:4`, el adaptador del índice global;
  - `src/runtime/registry-blob.ts:13`, el lector del registry, que usa `serve.ts:31`.

  Re-anclado en main 636e0449 (#781, #782):
  - el SDK solo vive en `src/adapters/vercel-blob/client.ts:4` (índice global) y en `reader.ts:4` (lector del registry);
  - la parte agnóstica pasó a `src/runtime/registry-source.ts`, sin SDK y con `read` obligatorio (:55, :87).

**Sin contar tests, 31 archivos de `src/`, `scripts/` y `package.json` nombran a Atom como palabra.** Esto incluye:
- `src/variants/atom.ts`;
- `src/wa-sdk.ts` y `src/wa-sensors.ts`, que son el contrato del SDK de WhatsApp de Atom;
- `src/ds-layout-guides.ts`;
- `src/runtime/image-step.ts`.

**Puertos que ya existen.** No se renombran (A8):

| puerto | dónde | implementación agnóstica de hoy |
|---|---|---|
| `SessionVerifier` | `src/runtime/session.ts:27-30` | `localVerifier` (:67); `signed` (`signed-verifier.ts`, Ed25519 con llave pública) |
| `PublishProvider` | `src/runtime/publish.ts:17-19` | `localPublish` |
| `ImageGen` / `ImageEdit` | `src/runtime/image-step.ts:19`, `image-tool.ts:97` | `none`; `gateway` a cualquier base URL compatible |
| `Composer` | `src/runtime/shared.ts:56` | `cli` (`claude -p`, ADR 0011) |
| `Transcribe` | `src/runtime/transcribe.ts:10` | `none` |
| `BlobClient` (índice global) | `src/orchestrator/chat-index.ts:7-15` | `fs-blob.ts` en disco (#772); el de Vercel está en `src/adapters/vercel-blob/client.ts` |
| `RegistrySource` + `BlobReader` | `src/runtime/registry-source.ts:27,51` | `fileReader` sobre `registry/` (`registry-file.ts:10`); el reader de Vercel está en `src/adapters/vercel-blob/reader.ts:7` |

## Decisión (propuesta)

### 1. Qué es el core (`karenrebecag/onbrand`, white label, apto para open source)

**Puertos.** Los de la tabla, más tres puertos nuevos:

| puerto nuevo | qué es | implementación de core |
|---|---|---|
| `SandboxProvider` | dónde corre el CLI de un chat | proceso propio, como hoy en `children.ts` |
| `BlobStore` | almacenamiento con `ifMatch` | `BlobClient` de hoy, renombrado por rol y movido a `src/ports/` (sobre disco). El nombre `BlobStore` es el que pidió Karen |
| `RegistryStore` | de dónde sale el registry | `RegistrySource`/`BlobReader` de hoy, con `fileReader` sobre `registry/` |

**Implementaciones agnósticas.** Cada puerto tiene una que corre sin cuentas:
- sesión `local` y `signed`;
- `BlobStore` en disco;
- proxy del Gateway hacia cualquier base URL;
- registry desde `registry/` en disco;
- export zip `site`/`source` y publish local.

**Cargador de perfil externo.** `WT_PROFILE_MODULE` apunta a un módulo que exporta `{ defaults, adapters(env) }`:
- `defaults` es parcial sobre la configuración del core;
- `adapters(env)` devuelve, por puerto, la implementación construida.

Si `WT_PROFILE_MODULE` falta, corre el perfil de core. Si el módulo no carga o devuelve un puerto que no cumple su
contrato, el arranque falla.

**`config.ts` deja de conocer a `atom`.**
- `PROFILES` desaparece.
- Los valores de proveedor pasan a ser los agnósticos.
- `atom-knowledge`, el vault de Karen y el HACK de :69 se mudan a la distro.

### 2. Qué es una distro (`karenrebecag/onbrand-atom`)

Es un repo aparte que depende del core y aporta cuatro cosas:
- su perfil (`{ defaults, adapters }`);
- sus adaptadores:
  - el verifier de Clerk (`@clerk/backend`);
  - `BlobStore` sobre Vercel Blob (`src/adapters/vercel-blob/client.ts` de hoy);
  - `RegistryStore` sobre Blob (`src/adapters/vercel-blob/reader.ts` de hoy);
  - `SandboxProvider` sobre `@vercel/sandbox`;
  - publish a Vercel;
- sus brand packs (Atom);
- su deploy (`atomchatio/wt-builder`; cada deploy con OK de Karen, decisión 7).

Lo que solo existe por Atom también se va a la distro: el contrato `wa-sdk` y sus sensores, y `variants/atom.ts`.
Antes de mover cada uno, QA confirma que el core no lo necesita.

### 3. Qué es un "componente" y dónde vive

| capa | qué es | dónde vive |
|---|---|---|
| DS del agente | la gramática que usa el agente (ADR 0011): `templates/arc-scaffold`, `catalog/` y `registry/` | **core**. La fuente es `registry/` en disco. El Blob es solo una copia publicada por la distro (`build-registry --publish` pasa a la distro) |
| Brand packs | identidad sobre el DS sin tocarlo (`brands/README.md`) | **core**: `brand-pack/` (base neutra) y `brand-pack-ejemplo/` (plantilla). **Distro**: los packs de Atom |
| Secciones por chat | lo que el agente escribe en un chat | ws del chat en el `SandboxProvider` (en la VM en la distro, local en core). El índice global va por `BlobStore` (en disco en core, Vercel Blob en la distro) |

### 4. Cómo consume el core la distro

| opción | qué es | a favor | en contra |
|---|---|---|---|
| **a. Dependencia git por tag** | `"onbrand": "github:karenrebecag/onbrand#vX.Y.Z"` en el `package.json` de la distro | el pin es explícito; subir de versión es un bump revisable; el core no sabe que existe la distro; sirve igual para terceros open source | el core necesita una entrada pública: `exports` y un `bin` para `serve` en su `package.json`, que es un cambio de config raíz y lo aprueba Karen |
| b. Submódulo git | el core dentro de la distro | no hace falta empaquetar | el pin se esconde en un sha, la actualización es en dos pasos y es frágil en CI. Invita a parchar el core desde la distro |
| c. Workspace (monorepo) | los dos en un mismo árbol | iterar es cómodo | contradice "totalmente separada" |

**Recomendación de Arq: (a).**
- Cada release del core lleva tag. La distro fija el tag y lo sube en un PR propio.
- La API pública del core es lo que exporta su `package.json`:
  - los puertos;
  - el arranque (`serve`);
  - los tipos de perfil.
- Nada más es contrato.
- El builder (`apps/builder`) viaja con el core. La distro lo configura (marca, sesión de Clerk), no lo copia.

**Regla (consenso 2026-11-05, en la misma línea que la crítica externa que trajo Karen): la distro no importa paths internos;
consume un tag.**
- `karenrebecag/onbrand-atom` existe y queda CONGELADO, solo con su README, hasta el primer tag del core (0.1.0).
- Antes de ese tag, ese repo no lleva código.
- Después, solo importa lo que exporta el `package.json` del core. Un import a `onbrand/src/...` es un error de revisión.

El orden de salida es:
1. interfaces exportadas;
2. proveedores fuera del core;
3. cargador de perfil;
4. artefacto publicado: tag 0.1.0, con `exports` y `bin` en el `package.json` y el OK de Karen;
5. solo entonces, código en la distro.

**¿Monorepo con workspaces hasta estabilizar el contrato, o repo aparte congelado? Recomendación de Arq: repo aparte
congelado, como ahora.**

Los hechos que pesan:

- **El contrato todavía se mueve.** Solo el 2026-11-05 cambiaron los puertos 3 veces:
  - `RunnerPage` pasó a `PageModel` (#770);
  - se agregó `sessionProvider 'jwt'` (#771);
  - nació `SandboxProvider` (#773).

  Faltan además `BlobStore` y `RegistryStore`. Con el código de la distro en el mismo árbol, cada cambio arrastra a la
  distro en el mismo PR, y el contrato se estabiliza a la medida de Atom, no de un tercero.
- **La iteración rápida que daría un monorepo ya la cubre un perfil de prueba dentro del core.** `tests/fixtures/`, sin
  nombre de cliente, es la decisión de orq para la salida de `atom` de `config.ts`. Ese perfil hace de distro de prueba:
  ejercita el cargador y los tests de contrato en el CI del core, sin código de Atom.
- **Un workspace contradice el marco de Karen** ("totalmente separada").
  - El guard B3 tendría que excluir una carpeta de Atom dentro del repo que se publica.
  - Además, hoy el core no usa workspaces: `apps/builder`, `templates/arc-scaffold` y `fixtures/relume-themed` se instalan
    cada uno por su cuenta (`ci.yml:29-36`), así que agregarlos sería otro cambio de config raíz.
- **El costo real del repo congelado** es que el deploy de prueba de Atom (decisión 7) espera al tag. Se acota así:
  - se cortan prerelease 0.x (`0.1.0-alpha.N`) en cuanto entren `exports` y `bin`;
  - en 0.x, semver admite romper entre versiones;
  - la distro sube de tag en un PR por cada alpha.

### 5. Guard B3 (ejecutable, en CI del core)

Un test falla si se cumple cualquiera de estas condiciones:
- `src/`, `scripts/` o `package.json` importan o declaran `@clerk/*`, `@vercel/sandbox` o `@vercel/blob`;
- aparece un nombre de cliente como palabra (lista en el test, empieza con `atom`).

La primera corrida va a dar rojo en 31 archivos. Ese rojo es el inventario del trabajo: el guard entra con esa
lista como excepciones fechadas, y cada PR mecánico (B1) le quita una.

### Orden recomendado

1. Guard con excepciones.
2. Los puertos `BlobStore`, `RegistryStore` y `SandboxProvider` con su implementación de core. `src/adapters/vercel-blob/`
   (`client.ts` y `reader.ts`) sale entera a la distro con `git mv`, junto con `@vercel/blob` de `package.json`.
   Hasta entonces la guarda B3 la tiene como excepción fechada (`tests/core-sin-terceros.test.ts`, #781/#782).
3. El cargador `WT_PROFILE_MODULE`, y `config.ts` sin `atom`.
4. La entrada pública del `package.json` y el primer tag. Es config raíz y necesita el OK de Karen.
5. `onbrand-atom` con el perfil, los adaptadores y el deploy.

Los PRs de hoy (`@vercel/sandbox` de orq, Clerk de ec) se quedan fuera del core. Si ya están escritos dentro, se
re-apuntan a `onbrand-atom` o esperan al paso 2.

## Checklist de madurez del core para la primera distro

Todo en main y corriendo. QA marca cada punto con su evidencia.

- [ ] **Clon limpio:** `git clone`, bun 1.4.4 y `claude` logueado generan una página sin ninguna cuenta. CI verde
  (#766, #768).
- [ ] **Corte alpha y corte final.**
  - Los `0.1.0-alpha.N` se publican con las excepciones fechadas de la guarda todavía vivas. El primer alpha es el que
    deja entrar código en `onbrand-atom`, y en ese mismo corte `src/adapters/vercel-blob/` sale del core.
  - `0.1.0` final sale sin excepciones.
  - Sin esto, la carpeta de Blob no podría salir antes del tag (la distro está congelada) y el tag no podría salir con
    ella dentro.
- [ ] **Guard B3 verde, sin excepciones vivas (para el 0.1.0 final):** ni SDK de terceros ni nombre de cliente en el core.
  - Los 31 archivos que hoy nombran a Atom salen en PRs mecánicos (B1), uno por excepción del guard.
  - `atom` sale de `config.ts` sin shim. Los tests que lo usaban (`tests/config.test.ts:22-44,78`,
    `tests/brands-en-repo.test.ts:35`) pasan a un perfil externo de ejemplo en `tests/fixtures/`, sin nombre de cliente.
- [ ] **DS base del core sin contenido de terceros por cuenta** (DECIDIDA, opción (a): `docs/spec/ds-base-neutral.md`).
  - Hoy `templates/arc-scaffold/` trae los componentes de Arc (`components.json` apunta al registry de Arc Pro de la
    cuenta de Karen) y además bencho, morphin y relume (`src/components/{arc,bencho,morphin,relume}`).
  - Un core público necesita un DS base neutral propio.
  - Arc y los demás entran por el registry de la distro, o los instala cada persona con su cuenta.
  - El builder no entra en esto: `apps/builder/src/components/arc/` se queda en el core (decisión 16, DECIDIDA
    [KAREN:chat 2026-11-05]). Sus dos bloques de Arc Pro (`blocks/agent-run` y `blocks/ai-composer`) se tratan bajo slots para
    funcionar solo con este proyecto; los componentes free, `foundation.css` y `lib/` siguen tal cual. No entra a `ARC_PATHS` ni
    sale con el alpha.
  - La gramática del agente (ADR 0011) tiene que funcionar igual sobre el DS base.
- [ ] **Puertos completos:** `SessionVerifier`, `PublishProvider`, `ImageGen`/`ImageEdit`, `Composer`, `Transcribe`,
  `SandboxProvider`, `BlobStore` y `RegistryStore`. Cada uno tiene implementación de core y un test de contrato
  exportado, que el adaptador de la distro corre en su propio CI.
- [ ] **Cargador de perfil:** `WT_PROFILE_MODULE` con un perfil de prueba dentro de los tests del core. El arranque
  falla con un puerto que no cumple su contrato.
- [ ] **`config.ts` sin `atom`:** sin vault de Karen y sin `atom-knowledge`.
- [ ] **Export y publish local** desde el commit de la versión (H9).
- [ ] **Runner retirado (C5)**, con la edición determinista por AST intacta (decisión 5).
- [ ] **Entrada pública y primer tag:** `package.json` con `exports` y `bin` (OK de Karen), CHANGELOG cortado a versión,
  README con "cómo se crea una distro".
  - Los `exports` del primer alpha incluyen lo que importa el entry de la distro en el builder:
    `apps/builder/src/lib/session-provider` (`setSessionProvider`, `SessionProvider`) y `App` (#787).
  - `setSessionProvider` lanza en una segunda llamada.
- [ ] **Enrutamiento builder↔orquestador:** B8 (`docs/spec/orquestador-enrutamiento.md`) en main:
  - base por chat `/chats/<id>`;
  - allowlist de subrutas con método y scope;
  - `run-client` adaptado.

  Hoy el builder llama unas 20 rutas del runtime fuera de `/runs` que detrás del orquestador dan 404 (`routes.ts:24,175-178`).
- [ ] **La distro de punta a punta:** `onbrand-atom`, fijada al tag, corre en el deploy de prueba:
  - sesión de Clerk;
  - Sandbox por chat;
  - proxy con el tope de 5 USD;
  - preview y export.

  QA corre una vez ZAP con los 6 casos de `identidad-sesion.md` §11.

## Consecuencias

- El core se puede publicar como open source sin infra ni marca de un cliente. Un tercero arma su distro con el mismo
  contrato que usa Atom.
- Atom paga mantener un segundo repo y subir el tag del core a mano.
- La lectura remota del registry, el índice en Blob y `wa-sdk` dejan el core. Si un tercero los quiere, los escribe en
  su distro o los toma de `onbrand-atom` si Karen lo abre.
- **Dependencias.** Ninguna dependencia de proveedor entra al core. `@vercel/sandbox` y `@clerk/backend`, aprobadas por
  Karen el 2026-11-05, se instalan en `onbrand-atom` cuando abra con el primer alpha. La delegación de los pendientes de
  este ADR no cubre dependencias ni configs raíz: siguen siendo un bloqueo de Karen.

### Deuda con disparador

- **`localSandboxProvider` no aísla.** Comparte máquina y usuario con el orquestador, y el check de host de
  `src/orchestrator/main.ts` no puede ver un túnel delante de loopback: ahí solo protege el JWT.
  - Disparador: antes de cualquier uso fuera de la máquina del dev (túnel, demo, staging), el perfil aporta un sandbox
    real.
  - `localSandboxProvider` es solo para desarrollo.

## Alternativas descartadas

- **Perfil dentro del mismo repo** (primera versión de este ADR). Karen la corrigió (G1): ancla el core a una distro.
- **Submódulo o workspace,** también como etapa hasta estabilizar el contrato: §4 (b), (c) y el análisis bajo la regla.
- **Renombrar los puertos existentes a `*Provider`:** es churn sin cambio de conducta (A8). Solo `BlobClient` pasa a
  `BlobStore`, porque deja de ser del orquestador y pasa a ser puerto del core.
