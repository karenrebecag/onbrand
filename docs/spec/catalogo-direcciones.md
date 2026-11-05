# Spec — Catálogo de direcciones (semilla B2)

**Estado:** APROBADA (Karen, 2026-10-27). Catálogo v0 de 8 direcciones; N de exclusión 2; la distro no fija styleSet: la identidad la fija el pack, la estructura varía dentro del catálogo.

## 1. Objetivo
Que dos corridas del mismo brief no salgan con el mismo esqueleto. La dirección de cada página se elige fuera del modelo, en una semilla determinista, y el agente recibe solo esa dirección.

## 2. Fundamento (RE)
- **Variedad = prior del modelo** en las tres herramientas. Las cuatro (Stitch, Lovable, v0 y la nuestra) sacan el mismo esqueleto de 7 secciones y las mismas cifras (+38 %, 3x). La gen 999ea0e0 cumplió skill, contrato y plan, y aun así repitió el esqueleto (`re-*/ArqWebTransformer*.md`, sección "gen Karen 999ea0e0").
- **Lovable** es la única que tiene catálogos: 15 pares tipográficos y 15 estructuras con nombre. La elección la hace el modelo, por eso varía poco (`re-lovable/ArqWebTransformer.md`).
- **El starter de v0 es un molde, no una librería:** el agente reescribe las secciones sobre el esqueleto que recibe. Una dirección con referencia de código por rol cumple esa función de molde.
- **Ninguna herramienta trae reglas de contenedor ni de variedad.** El contrato `Section` ya lo tenemos; el catálogo es la otra mitad.

## 3. Contrato de una dirección
Cada entrada es una dirección completa. No se mezclan ejes de entradas distintas: un eje suelto vuelve a dejar la combinación al prior.

```ts
interface Direction {
  id: string;                         // 'editorial-split', 'bento-producto', …
  sector: string[];                   // etiquetas: 'saas', 'salud', 'retail', 'educacion', 'finanzas', …
  tone: string[];                     // 'sobrio', 'cercano', 'audaz', 'editorial', …
  styleSet: string;                   // = id; es el valor de BrandComposition.styleSet que la fija
  type: { display: string; body: string };          // par de FONT_LIST, no fuentes sueltas
  rhythm: RhythmProfile;              // banded | quiet | neutral (types.ts)
  density: Density;                   // compact | default | spacious (brand.ts)
  roles: Record<SectionRole, {
    form: string;                     // estructura de la sección: 'split-media-izq', 'bento-4', 'zigzag', 'lista-numerada', 'tabla', …
    focal: 'foto' | 'mockup' | 'cifra' | 'tabla' | 'cita' | 'ninguno';
    surface: 'base' | 'muted' | 'raised' | 'inverse';
    ref: string;                      // slug de un bloque del registry para ese rol (relume/<categoría>/<bloque>)
  }>;
  order?: SectionRole[];              // orden de secciones si difiere del de ROLE_SPEC
}
```

- **Reuso de `BrandComposition`:** `rhythm` y `density` son los mismos tipos. `styleSet`, que hoy se parsea y nadie consume, pasa a ser el id de la dirección: una marca que lo declara fija su dirección y se salta la semilla.
- **Prioridad:** brand pack > dirección. Si el pack trae fuentes, el par de la dirección se ignora; los tokens del pack siempre ganan. La dirección decide estructura, ritmo, focal y densidad; la marca decide la identidad.
- **`ref`** apunta a un bloque que ya existe en el registry publicado (`relume/hero-header-sections/*`, `feature-sections-*`, …). Un test falla si el slug no existe en el pin.

## 4. Elección (fuera del modelo)
1. Filtro: direcciones cuyo `sector` o `tone` cruzan con la intención del brief (`briefIntent` y el negocio del brief; el sector se etiqueta en este paso, hoy no se extrae). Si nada cruza, se usa el catálogo entero.
2. Semilla: `hash(runId)` elige entre las filtradas y excluye las últimas N usadas para ese brief (N = 2, en un registro nuevo de direcciones por brief, que hoy no existe). Es determinista y reproducible con el mismo runId.
3. `styleSet` del pack, si existe, gana sobre los pasos 1 y 2.
4. Se registra en el log de flujo (`log/flow.ts`), como ya se hace con `composition`.

## 5. Entrega al agente
- El agente recibe un solo archivo, `references/direction.md`, con la dirección elegida. Lleva, por rol: forma, focal, superficie y la ruta del bloque de referencia para leerlo antes de escribir esa sección. **El catálogo nunca entra al workspace ni al prompt.**
- El orden de lectura del skill suma un paso entre Fundamentos y Plan: "Dirección: `references/direction.md`; el plan la sigue".
- `page-plan.md` declara `direccion: <id>` y, por sección, la forma y el focal de la dirección. Sensor nuevo `plan.direction` (sobre los `plan.*` de #254): el plan cita la dirección entregada y cada sección respeta su `form`, `focal` y `surface`.

## 6. Archivos (código, después del OK)
- `src/directions.ts`: tipos, catálogo, `pickDirection(runId, brief, composition, recent)` y `directionReference(d)`.
- `src/ds-skill-agent.ts`: escribe `references/direction.md` y suma el paso al orden de lectura.
- `src/page-sensors*.ts`: `plan.direction`.
- `tests/directions.test.ts`: los `ref` existen en el registry, la elección es determinista, excluye las recientes, `styleSet` gana y el catálogo no entra al workspace.
- La línea del prompt que nombra `direction.md` es de orq (`src/runtime/agent-prompt.ts`).

## 7. Catálogo v0
Ocho direcciones escritas a mano, cada una con su par tipográfico, ritmo y forma por rol distintos, y con referencias tomadas de las categorías del registry (hero ×10, features ×14, testimonios ×8, pricing ×8, CTA ×10, FAQ ×8, stats ×6, logos ×6, footers ×6). Las formas salen de las 15 estructuras de Lovable que el registry puede materializar (split, bento, zigzag, card-grid, full-width, asymmetric, magazine, single-column). El autor es Arq; Front valida los pares.

## 8. Medición
- Set fijo de briefs (el bench de QA de #232), n = 4 por brief: el esqueleto (forma por rol) tiene que diferir entre corridas, medido con el hash de forma por sección (hueco 4). Hoy da el mismo hash.
- `plan.direction` en 0 errores.
- Render-gate y `section.contract` sin regresión.

## 9. Fuera de alcance
- **Las cifras repetidas** (+38 %) son prior de contenido, no de forma. La dirección no las cambia. Se tratan aparte (regla de copy o datos del brief).
- Direcciones generadas por modelo y catálogos por cliente.

## 10. Decisiones de Karen
1. Tamaño del catálogo v0 (propongo 8).
2. N de exclusión entre corridas (propongo 2).
3. Si la distro fija `styleSet` (una dirección de marca) o deja variar la estructura dentro de su identidad.
