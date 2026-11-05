# Decisiones sobre el path de publish y export (2026-11-04)

Origen: brief `docs/research/publish-path-agnostico.md` (local, no versionado; Estado ESCALADO → DECIDIDO). Karen
delegó las seis decisiones a Orq en el chat del 2026-11-04 ("el resto, ocupate"). Se registran aquí porque los briefs
no entran al repo.

- **G1. Dónde viven los adaptadores hosted.** En este repo, gated por perfil (`atom`), como image/transcribe/compose
  hoy (`src/config.ts`). "Distro" = perfil atom, no un repo aparte, mientras un segundo perfil no lo pida. Mismo
  patrón para identidad: el core expone el puerto de sesión y el adaptador local; el proveedor real vive en el perfil
  (Karen: "eso va en el distro").
- **G2. Write-path git → Blob (ADR 0013 D5).** Detrás de un puerto del lado atom; el runtime del core solo lee Blob
  (`registry-blob.ts`).
- **G3. `publishEnv` + `scripts/build-registry.ts`.** Se quedan en el core como build-tooling del DS.
- **501.** El perfil `atom` vuelve a `publishProvider: 'local'` hasta que el adaptador `vercel` esté cableado; un 501
  silencioso en atom no es aceptable.
- **P1.** El zip de export excluye `request.json` e `instructions.json` (`docs/spec/export-zip-mcp.md`).
- **P2.** El MCP de lectura es solo lectura.

Siguen siendo de Karen: el dominio del sitio publicado (wildcard propio o `*.vercel.app`, costo de DNS) y la
retención de deployments viejos (`re-sistema/onbrand/h1-publish-diseno.md` §Abierto).

## Alcance del core (Karen, chat 2026-11-04, después de la spec hosted)

"Publicación a servicios externos va en el distro. Habíamos hablado de mantenerlo sencillo: a download de paquete o
algo así sobre el core, solamente." Por tanto:

- **El core entrega un paquete**: export zip (H9, `docs/spec/export-zip-mcp.md`, P1/P2) construido con
  `vite build --mode publish` (sin puentes, P3) desde el commit de la versión, más el publish local que ya existe.
- **Publicar a un servicio externo es de la distro** (perfil `atom`): `docs/spec/publish-hosted.md` queda como spec
  de la distro, aparcada, con las correcciones de Arq anotadas; no se implementa en este programa. El seam
  `PublishProvider` del core no crece para el hosted (ni polling, ni alias, ni recover de publicación).
- El orden D de `docs/estandares.md` pasa a: (a) headers, (b) identidad + D6, (c) export zip + MCP de lectura.
