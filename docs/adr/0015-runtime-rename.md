# ADR 0015: `src/v0` pasa a `src/runtime` y `Transport` pasa a `Runtime`

Estado: DECIDIDO [KAREN:chat 2026-11-04 "vamos con runtime"; cita transmitida por WebTransformerOrq] | Fecha: 2026-11-04 |
Autora: Arq | Ejecuta: orq (un PR mecánico)

## Contexto

Karen pegó una crítica externa. Estos nombres ya no describen el código:
- `v0` es histórico: nació como réplica del transport de v0 (`feat/v0-transport`), y hoy es el runtime de corridas del
  producto. A quien lee el repo le hace pensar en una dependencia o un modo que no existe.
- Tras el ADR 0014, `Transport` es la raíz de composición (estado del ciclo, persistencia y cableado de colaboradores)
  y el servidor HTTP. "Transport" sugiere solo la capa de red.
- La frontera 6.9 (lo que los tests tocan por cast se queda en la clase) sobrevive al renombre, porque cambia el nombre
  de la clase y no sus miembros. QA la guarda con un test.

## Decisión

### Nombres (contrato del PR)

| antes | después |
|---|---|
| `src/v0/` | `src/runtime/` |
| `src/v0/transport.ts` | `src/runtime/server.ts` |
| clase `Transport` | `Runtime`, con todos sus usos en `src`, `tests`, `scripts` y `apps/builder` |
| `TransportOptions` | `RuntimeOptions` |
| `src/v0/transport-shared.ts` | `src/runtime/shared.ts`. Tiene helpers además de tipos; partir un `types.ts` es otro PR |
| `scripts/v0serve.ts` | `scripts/serve.ts`, con sus menciones en README, docs y `scripts/e2e-core-clone.ts` |
| imports del builder `@engine/v0/...` | `@engine/runtime/...` |
| texto "Transport del modo v0" en README y docs vivos | "runtime de corridas" |

El alias `@engine/*` ya apunta a `../../src/*` (`apps/builder/tsconfig.app.json:17`, `vite.config.ts:19`), así que
**no se tocan configs**: solo cambian las rutas de import.

### Lo que NO se renombra (datos de la gente y contratos persistidos)

| se queda | por qué |
|---|---|
| root por defecto `generated/v0-transport` | ahí están los workspaces y logs existentes; cambiarlo los deja huérfanos |
| variables `WT_*` | configuración desplegada (perfil de la distro) y local |
| `.wt/` y sus archivos | viven dentro de cada workspace |
| el log de eventos (formato, nombre y ubicación) | los logs viejos se siguen leyendo con `readEvents` |
| los `stepId` con prefijo `transport:` (`transport:build`, `transport:stop`…) | están escritos en los logs, y el builder los lee (`run-state.ts`, `turn-phases.ts`). Renombrarlos rompe el replay de los chats viejos |
| `TransportCapabilities` (`apps/builder/src/lib/run-client.ts:557`) y `transportPort` | son locales y no confunden. Quedan fuera para que el PR siga siendo mecánico |
| ADRs y specs históricos (0001-0014, `docs/programa-*`) | son registro: dicen lo que era verdad cuando se escribieron. Solo se actualizan README y docs vivos |
| `src/copygen/claude-transport.ts` | es otro "transport" (de copygen) y no tiene relación |

### Cómo se ejecuta

- Un solo PR mecánico de orq: `git mv` más reemplazos. No cambia lógica, y ningún test cambia salvo imports y el
  nombre de la clase.
- Equipo congelado mientras esté abierto. Nadie abre PRs que toquen `src/v0`.
- Condición 6 del ADR 0014 antes y después: la misma lista de archivos con los mismos números (pass, fail, skip y todo),
  y `tsc --noEmit` limpio.
- Revisión de Arq:
  - `git diff -M --stat` muestra solo renombres al 100% o con cambios de import;
  - `git grep -nE "src/v0|@engine/v0|\bTransport\b|transport-shared|v0serve"` sobre `src`, `tests`, `scripts`,
    `apps/builder/src` y README da cero, salvo las excepciones de la tabla de arriba.

## Consecuencias

- Las ramas abiertas que tocan `src/v0` tienen que hacer rebase después del merge. Por eso el equipo se congela.
- Los ADRs viejos siguen diciendo `src/v0/transport.ts`. Para leerlos, la tabla de nombres de este ADR es la traducción.
