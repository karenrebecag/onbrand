# Investigación — Por qué sale la misma página, y el puente contenido→forma

**Fecha:** 2026-10-22 | **Sesiones:** orq + WebTransformerSecondary (investigaciones independientes, consenso firmado) | **Estado:** hallazgo medido, sin implementar.

## Meta del proyecto (contexto)
Generar landing pages desde un prompt; Karen cambia el brandpack y listo. Relume = maquetación; componentes Arc encima (se cambia contenido/paleta/font, NUNCA la maquetación del componente); motion anima los slots con contratos agnósticos sobre el DOM. Todo desde el vault Knowledge/Frontend/Components.

## Problema
Con 1035 items en el catálogo (844 Relume + 191 Arc), la página generada es **casi la misma** sin importar el brief o el brand pack. Medido: App.tsx byte a byte idéntico entre packs; dos negocios distintos (e-commerce vs clínica dental) dan el mismo top-3 en 6 de 7 roles.

## Causa raíz (medida, no supuesta)
1. **Autodeclaración, desigual.** Relume NO se autodeclara: su metadata es DERIVADA (843/843), y cada item trae un `registry.json` hermano con `description: ""`. Arc SÍ se autodeclara (191/191 parseados de su `doc.md`), por eso Arc gana por el eje semántico y Relume no. La consulta debería explotar esa descripción, no ignorarla.
2. **La consulta es gruesa.** El plan fija `desiredTags` por rol (pricing = `['Cards']`, features = `['3 Columns','Icons']`). El scorer (`rank.ts:scoreCandidate`) solo cuenta esos tags. Los tags que SÍ diferencian (columnas, Image, Tabs, Icons) quedan fuera de la consulta. El eje semántico vale constante 1 en Relume (los tokens de negocio no cruzan con metadata de forma).
3. **Empates masivos.** Candidatos distintos del mismo rol obtienen el mismo puntaje (pricing: 11-23 según la etapa; features: todos → `layout233`). El desempate son dos comparadores: shortlist por score→verified→slug (`router.ts:219`), pick final por score→slug (`rank.ts:90`, `select.ts:96`). Ganador visible = verificado y primero por abecedario.
4. **Raíz arquitectónica.** `composePage` (selección) corre en `run.ts:107`; el copy en `run.ts:131`. La selección ocurre **antes** del copy, así que la FORMA del contenido no puede informar la selección.

## Diferencia real con Relume y Webflow
No es la metadata (un componente Relume declara lo mismo que indexamos: categoría + tags + layoutStyle). Es la **consulta**. **Relume** (VERIFIED) rankea con la **descripción de la sección del negocio**, el conteo de bloques de texto (`textBlocksCount`), el `layoutStyle` del proyecto y la **sección anterior** (adyacencia, `prevSlug`) para no repetir, y baraja dentro del tier; su `PQ(candidatos, prevSlug)` corre con flag OFF y la selección server-side por descripción con flag ON. **Webflow** elige `matches[0]` de una lista `libraryMatches` ordenada en el servidor por una señal **desconocida (MISSING)**: no hay campo de score y solo capturamos una corrida. En ninguno de los dos el desempato es alfabético (en Webflow es MISSING, no confirmado). Esa señal fina separa a los candidatos.

## Experimentos (render-gate + réplica del scorer)
- **Reemplazo de contenido: limpio.** El render-gate mide residuo (texto visible que no vino de props) ~0 en Arc y Relume; cambiar el pack no toca el contenido. El reemplazo sin romper el componente YA funciona.
- **Puente contenido→forma en pricing.** Baseline: las dos formas de copy → `pricing10_block`. Con el puente (nº planes→columnas, anual→Tabs, imagen→Image): forma A (2 planes, anual) → `section_pricing14` (2 Columns, Tabs); forma B (1 plan, imagen) → `section_pricing2` (1 Column, Image). **2 secciones distintas, cada una por el motivo correcto.**
- **Puente en features.** Baseline: 4 formas → `layout233`. Con el puente: **3 páginas distintas de 4 formas** (A→layout233, B→layout10, C y D→layout371). Con 98 combos de tags, separa más que pricing.
- **Límite (predicho por Secondary):** el puente separa por FORMA, no elimina los empates dentro de un grupo de forma; ahí el desempate alfabético persiste. Techo esperado; se afina con un mapeo de forma más fino.

## Conclusión
El fallo no es la variedad, ni el pool, ni el desempate. Es que **el selector no usa la metadata diferenciadora que el índice ya tiene, y selecciona antes del copy, así que no puede ver la forma del contenido.** El fix es un **puente determinista contenido→forma**: derivar la forma del **plan de contenido por sección** (nº items, imagen sí/no, conteo de textos) antes de seleccionar, y usarla en la consulta. El copy final se escribe después, al slot elegido. Validado en dos bancos.

## La industria confirma (investigación externa, Secondary, fuentes citadas)
Dos familias de generadores:
- **Generadores de código** (v0, Lovable, Google Stitch): sin paso de selección; un modelo escribe estructura + contenido + código juntos. No aplican a nuestra restricción (maquetación fija de componentes); ni confirman ni contradicen.
- **Ensambladores de librería** (Relume, Webflow AI, Wix ADI, Builder.io): TODOS siguen el mismo orden, y es el nuestro afinado:
  1. LLM → secciones + **descripción por sección** (Relume DOC: "el título y la descripción son prompts para la IA a nivel de sección").
  2. Selección por sección usando esa descripción + forma estimada (textBlocksCount, layoutStyle) + adyacencia.
  3. Copy final escrito PARA los slots del componente elegido. Si cambia el componente, el copy se regenera.

Lo que esto resuelve y añade:
- **Resuelve la pregunta abierta de abajo:** antes de seleccionar NO va el copy final, va un **plan de contenido por sección** (descripción + nº items + imagen sí/no + conteo de textos). El copy final va después, al slot elegido. Ningún referente hace "seleccionar después del copy completo" (obligaría a generar el copy dos veces). Así que de las dos opciones, la industria elige **derivar la forma antes de seleccionar**.
- **Nuestros tres niveles ya existen** (plan → composePage → generatePageCopy). Lo que falta es QUÉ viaja del 1 al 2: hoy un ROLE_SPEC fijo; debe viajar **descripción + forma**.
- **La descripción por sección es la otra mitad del puente.** La forma sola no captura intención (p. ej. "galería" → componente con imágenes). Forma + descripción juntas.
- **Desempate:** nadie conocido desempata por abecedario. Relume baraja dentro del tier; Wix usa un prior de popularidad; Stitch deja elegir al humano. Propuesta: **shuffle determinista con semilla = hash del brief**.
- Académico (Zheng, SIGGRAPH 2019) critica los layouts "oblivious to the input contents"; es exactamente nuestro bug.

## Lo que queda (el trabajo real)
Derivar la forma del contenido **antes** de seleccionar, o reordenar para seleccionar **después** del copy. Ese reordenamiento es la fase, no el scorer. Reemplaza la premisa "ensanchar el pool" de RFV3 (que solo cambiaría una página fija por otra) con "puente contenido→forma".

## Resuelto (investigación externa 2026-10-22)
El patrón de la industria confirma el puente y resuelve el orden: **plan de contenido por sección (descripción + forma) → selección → copy final al slot**. Ver la sección "La industria confirma". Pendiente de Karen: diseñar qué viaja de plan a composePage (descripción + forma en vez de ROLE_SPEC fijo) y el desempate por hash del brief.
