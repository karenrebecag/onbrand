# S6 Selección con archivo:línea
Estado: APROBADA · Dueño: Arq (marcador) + UI (chip y cola)

## Objetivo
La selección llega al agente como slug, ancla y archivo:línea:col, con la regla "solo esta instancia" (ADR E, decisión 3).

## Fundamento
- Marcador dev: lovable-tagger@1.3.5 dist/index.js:7, :10-17 y :177 (npm, sin ofuscar).
- Canal: Make Annotate, figma-make/annotate-chunks/deob/figma_app/deobfuscated.js :440813-440885, :439581-439592, :439746-439845; figma-make/annotate-chunks/deob/iframe/deobfuscated.js :45692-45705.
- React 19 no expone _debugSource (arq.md §2).
- Cola (Make 4): RECEIPT = figma-make/annotate-chunks/deob/92302/deobfuscated.js :96210-96300; figma_app :439215-439245.

## Huecos a cerrar antes de implementar (Arq)
1. Que el JSX dev transform de vite 8 (oxc/rolldown) le pase el 5º argumento source {fileName, lineNumber, columnNumber} a jsxDEV. Sin ese extract el marcador puede quedar vacío.
2. Que el resolveId del módulo virtual gane sobre react/jsx-dev-runtime, que hoy está en dedupe y en optimizeDeps.include del scaffold.

Si alguno falla, se frena y se consulta a Karen.

## Cambios
1. Plugin de dev en templates/arc-scaffold/vite.config.ts (Arq): un transform propio de jsxDEV, solo en serve, sin deps.
2. apps/builder/src/lib/element-context.ts, edit-popover.tsx y el composer de chat-panel.tsx (UI): el chip con archivo:línea. Estos archivos salen de S3 mientras dure S6.
3. Cola "Task N" (UI): en el composer, chat-panel.tsx. Ahí la pone Make (RECEIPT:96210-96300).

## Terminado
- Tests del transform.
- El HTML de build no lleva Symbol ni mapa.
- Arnés A6.
- La selección en 56644d79 manda el archivo:línea correcto en 3 elementos: uno dentro de un .map, uno en un condicional y uno simple.
