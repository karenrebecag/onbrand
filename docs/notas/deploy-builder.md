# Deploy del builder: core y variante

`apps/builder/vercel.json` del repo es el **core**: sirve la SPA con headers genéricos y no sabe dónde vive el
transport. Con esa config, el builder habla con el transport que diga `VITE_RUN_API` en el build.

Un deploy que pone el transport detrás del mismo origen (como el de la distro, con el transport en un Vercel Sandbox)
necesita una **ruta de proxy** que el core no trae, porque fija un host de un equipo y un secreto de origen. Es un
artefacto de deploy: lo aplica quien despliega, antes de `vercel --prod`, insertando esta entrada en `routes`
**después** de la de headers y **antes** de `{ "handle": "filesystem" }`:

```json
{
  "src": "/api/(.*)",
  "dest": "https://<host-del-sandbox>/$1",
  "headers": { "x-vercel-enable-rewrite-caching": "0" },
  "transforms": [
    { "type": "request.headers", "op": "set", "target": { "key": "x-origin-secret" }, "args": "$WT_ORIGIN_SECRET", "env": ["WT_ORIGIN_SECRET"] }
  ]
}
```

- `WT_ORIGIN_SECRET` es una env del proyecto de Vercel: el valor nunca va en el archivo.
- Con el proxy, el build usa `VITE_RUN_API=/api`.
- La versión que estaba commiteada como default (host incluido) está en la historia: `git show e7dd574:apps/builder/vercel.json`.

Por qué `routes` y no `headers`/`rewrites`: Vercel no permite combinar `routes` con esas claves, y el proxy usa
`transforms` con env, que solo existe en `routes`.

La CSP va en el core como `Content-Security-Policy` en enforce (H4): lo que no esté en la lista se bloquea.
- `connect-src 'self'` asume `VITE_RUN_API=/api` (proxy del mismo origen). Si el transport vive en otro host, ese host
  entra en `connect-src`.
- `frame-src` permite `https://*.vercel.run`: el preview de cada ws es `<ws>.<host de WT_PREVIEW_ORIGIN>`, y en el deploy
  ese host es el Sandbox. Si cambia, se edita aquí (el archivo es estático, no lee env).
- `img-src` permite `https://assets.pipedream.net`, el único origen de íconos que acepta `safeIcon` (`src/runtime/connectors.ts`).

Antes del enforce se corrió el dist con esta CSP bloqueando (frame-src local en vez de `*.vercel.run`) sobre un chat
real: vista previa, código, cambios y plan sin ninguna violación, y el preview con HMR conectado. Si un deploy nuevo
bloquea algo, la consola dice qué directiva: se agrega ese origen aquí, no se vuelve a Report-Only.

El preview manda su propia CSP desde `preview-serve.ts`: solo `frame-ancestors 'self'` más el origen del builder
(`WT_BUILDER_ORIGIN`), para que ningún otro sitio lo enmarque. Sin `WT_BUILDER_ORIGIN` no se manda.

## Gate del preview (identidad fase 4)

Sin gate, quien conoce la url `<ws>.<host>` ve la página y abre su HMR. El listener ya sabe exigir un token por ws
(`preview-serve.ts` `PreviewGate`, #667; spec `identidad-sesion.md` §9), pero **en `e51d4833` ningún deploy lo enciende**:
`scripts/serve.ts` todavía no le pasa el secreto. Lo que sigue es cómo queda al cablearse, después de la fase 2
(ownership).

- `WT_PREVIEW_SECRET`: el secreto del HMAC, de 32 bytes como mínimo (`MIN_SECRET_BYTES`, `preview-token.ts`). Es una env del
  runtime, nunca del builder, y es explícito: no se deriva de `WT_ORIGIN_SECRET`, así rotar uno no invalida el otro en silencio.
- Sin `WT_PREVIEW_SECRET`, el gate queda apagado y el preview funciona como hoy, abierto a quien conozca la url. No es un
  error de arranque, porque en local (loopback) no hace falta.
- Con el secreto puesto, el token llega en el latido `POST /preview/heartbeat` (bajo sesión): `states[ws].previewToken`
  solo para los ws del dueño; un ws ajeno o inexistente sale `absent`, con su url y sin token (spec
  `identidad-sesion.md` §9). El builder abre `<url estable>?wt_preview=<token>` en cada montaje o remonte del iframe. El listener responde 307 a la misma ruta sin el
  token y deja la cookie `wt_preview` del origen del ws. Las dos mitades salen juntas: el secreto sin el builder que manda
  el token deja todos los previews en 401.
- El origen del preview tiene que ser `https` (o `localhost`): la cookie va con `Secure; SameSite=None; Partitioned`,
  porque vive en el iframe del builder, que es otro sitio. Por eso un `WT_PREVIEW_ORIGIN` en `http` con un host que no
  sea localhost no sirve con el gate.
- En el Sandbox (ADR 0016), el runtime del Sandbox valida con el mismo `WT_PREVIEW_SECRET`, que le pasa el orquestador al
  crearlo.
- Cambiar el secreto invalida todas las cookies: cada preview abierto da 401 hasta que el builder pida un token nuevo.

Qué ve quien no tiene token: 401 sin cuerpo, también para un ws que no existe (no se distingue cuál existe). Al upgrade
de HMR sin cookie se le responde 401 y se cierra.

## Preview-check: orígenes de imágenes propias (H11)

El sensor de imagen rota (`src/preview-viewport.ts`) trata como propios el origen de la preview, `data:` y `blob:`; todo
otro http(s) es `broken-image-external`, que se reporta pero no se auto-repara. Hoy las páginas generadas solo usan
imágenes root-relative (`/uploads/:id`, canvas) y `data:` SVG, así que alcanza. Cuando el API y el Blob del perfil
sirvan imágenes desde otro origen (H11):

- [ ] Poblar `ViewportContext.ownOrigins` en el caller (`scripts/preview-runtime.ts` y `scripts/serve.ts`) con el host del
      API del perfil y el del Blob, para que una ruta mal escrita hacia una imagen propia salga `broken-image` (reparable)
      y no `broken-image-external` (sin repair).
