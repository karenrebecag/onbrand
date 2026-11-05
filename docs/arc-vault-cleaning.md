# Limpieza Arc → vault

Escalón upstream de `src/catalog/ingest-arc.ts`. Toma un item **free** del Arc público
(`kuratlielia/arc-library`) y lo deja en el formato que el vault espera
(`VAULT_ROOT/ui-react/{blocks,components}/<slug>/`), con uiarc.dev despersonalizado a `uikit`.
El ingest luego lee esa carpeta READ-ONLY, clasifica y corre el gate; no vuelve a limpiar.

No es automático: se corre a mano por lote de slugs nuevos (el último fueron 14 componentes).
El ingest valida el resultado, así que la limpieza no necesita tests propios: un slug mal
limpiado falla el gate (`imports resolubles`, `deps npm declaradas`, `sin export principal`).

## Entrada

Clon del Arc público en HEAD fijo. Por cada slug:

- `registry/components/<slug>/<slug>.tsx` y `<slug>.module.css` — el source.
- `registry.json` raíz del clon — metadata del item (`name`, `type`, `title`, `description`,
  `categories`, `dependencies`, `registryDependencies`, `meta.tags`).
- `<slug>.md` — la doc (se baja aparte).

## Transformaciones

Tres, una por tipo de archivo.

### TSX (imports a relativos)

El Arc público importa con alias `@/`; el vault usa relativos desde `files/registry/components/<slug>/`.

| De | A |
|---|---|
| `"@/lib/motion-tokens"` | `"../lib/motion-tokens"` |
| `"@/registry/components/<x>/<y>"` | `"../<x>/<y>"` |

El CSS (`.module.css`) se copia sin tocar.

### `registryDependencies` (despersonalizar el host)

| De | A |
|---|---|
| `uiarc.dev` | `example.com` |
| `/r/arc-motion-tokens.json` | `/r/uikit-motion-tokens.json` |

Las deps que son **componentes** del propio registro (`button`, `switch`, `checkbox`, …) quedan
como host-only, sin prefijo: el gate las resuelve dentro del vault, no contra una URL.

### doc.md (quitar rastros del host y de la publicación)

- Se eliminan las líneas `- Page:`, `- Markdown:`, `- Registry item:` (apuntan al sitio público).
- `@uiarc/` → `@uikit/`
- `uiarc.dev` → `example.com`

Se conservan `- Access:`, `- Keywords:` y el cuerpo: el ingest los lee (acceso free/pro, keywords
para clasificar el rol).

## Salida

```
<slug>/
  registry.json
  doc.md
  files/registry/components/<slug>/
    <slug>.tsx
    <slug>.module.css
```

`registry.json` de salida fija `meta.tier: "free"`, `meta.kind: "component"`,
`meta.markdown: "https://example.com/components/<slug>/markdown"`, y los `files` con
`target: "@components/uikit/<slug>/..."`. Si la carpeta del slug ya existe, se omite (idempotente
por slug; no pisa una limpieza previa).

## Verificación

Después de limpiar un lote, correr el ingest real contra el vault y confirmar que cada slug
entra con `gate.ok` y el `kind` esperado:

```bash
WT_VAULT_ROOT=<vault> bun scripts/catalog-ingest.ts --lib arc
```

Un slug que no aparezca, o aparezca con gate en rojo, quedó mal limpiado: revisar imports y
`registryDependencies` contra las tablas de arriba.
