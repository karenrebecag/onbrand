// Hoja sin imports: el builder la importa y su tsc no tiene tipos de node, así que no puede colgar de runtime-repair.ts
// (que arrastra events.ts y con él node:fs). La lista la re-exporta runtime-repair, que es donde la lee el server.

// Solo los kinds de error de runtime (RuntimeIssue en src/runtime-sensors.ts:12, más 'unmounted'): "Arreglar" y el
// auto-repair salen solo de un error que dejó la página sin render. Los sensores de diseño y de preservación (contrast,
// overflow, interaction, cta-wrap, visual, preserve-*) van por otras rondas y no abren un arreglo de runtime.
export const RUNTIME_KINDS: ReadonlySet<string> = new Set(['pageerror', 'console', 'request', 'broken-image', 'unmounted']);
