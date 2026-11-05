# web-transformer — pendientes

Solo lo que sigue abierto hoy y se puede comprobar en el repo. El detalle de cada cosa vive en su ADR, spec o PR; esto
es el índice. Lo anterior al [ADR 0011](docs/adr/0011-agente-escribe-como-v0.md) (ranker de composición sobre el
registry de Relume, superficie Arc Pro) está archivado en
[`docs/archive/pendientes-relume-ranker.md`](docs/archive/pendientes-relume-ranker.md).

## Esperan una decisión de Karen

La lista completa, con la opción que recomienda Arq en cada una, está en
[`docs/notas/decisiones-pendientes-2026-11-04.md`](docs/notas/decisiones-pendientes-2026-11-04.md):
- chips de variantes;
- ZAP en vivo;
- fase 5 de identidad;
- topes de gasto;
- imágenes y transcripción en la VM;
- `@vercel/sandbox`;
- publicar el registry.

Además:
- **ADR 0014** sigue en `PROPUESTO` en [`docs/adr/README.md`](docs/adr/README.md). La Enmienda 1 está hecha; pasarlo a
  `APROBADO` es de Karen.
- **¿Se retira el runner?** Bloquea C5, el archivo del camino props/JSON, y el porter
  (`docs/notas/cierre-modulo-2026-11-04.md` §3).

## Trabajo repartido sin Karen

[`docs/notas/cierre-modulo-2026-11-04.md`](docs/notas/cierre-modulo-2026-11-04.md) §2: filas con extract, dueño, tamaño y
orden.

## Brechas de producto (README, "Status and known limits")

- **Publicar:** el core entrega el paquete exportable. Publicar a un host externo es de la distribución.
- **Identidad:** fases 0-4 en el core. Falta la fase 5, el proveedor del perfil `atom`.
- **Deploy con un Sandbox por chat (ADR 0016):** los pasos 1-3 de `docs/spec/deploy-sandbox.md` §6 están en main como
  módulos sin cablear. El paso 4 espera a `@vercel/sandbox`.

## Deuda con dueño en el código

- **Viewport fuera de la tabla del browser tool:** `MAX_SEGMENTS` y `VISION_SCALE` caen en su `??` por defecto con un
  ancho como 1280; falta medir cuántos tokens de visión gasta antes de decidir ([mismo spec](docs/spec/contexto-agente.md) §5).
- **Atajos marcados `HACK:`** con su techo y su disparador. Se cosechan con:

  ```bash
  grep -rnE '(#|//) ?HACK:' --exclude-dir={node_modules,.git,dist,build} .
  ```

## Cerrado por el ADR 0014 (no reabrir)

La partición de `transport.ts` y la Enmienda 1 están completas: `transport.ts` 593 líneas, `run-cycle.ts`, `run-close.ts`,
`run-checks.ts` (#612, #620), el token de corrida (#627) y las pruebas 6.6 y 6.8 (#624). Lo que quede de ese ADR se
decide en él, no aquí.
