import type { Version } from './run-client'

// Deshacer y Rehacer de Stitch (static-editor.md §3: pila de snapshots, ⌘Z / ⇧⌘Z) hechos con versiones: deshacer
// restaura la versión anterior como un commit nuevo, así que se guarda, cosa que el undo de Delete de Stitch no hace
// (dinamico-rail.md, Direct Edit). Las versiones de restore no cuentan como pasos: son el undo mismo.

const originOf = (v: Version, byId: Map<string, Version>): Version => {
  let at = v
  for (let hops = 0; at.restoreFrom && hops < 100; hops++) at = byId.get(at.restoreFrom) ?? at
  return at
}

function position(versions: Version[]): { steps: Version[]; at: number; head: Version } | null {
  const head = versions.find((v) => v.head) ?? versions.at(-1)
  if (!head) return null
  const byId = new Map(versions.map((v) => [v.messageId, v]))
  const steps = versions.filter((v) => !v.restoreFrom)
  return { steps, at: steps.indexOf(originOf(head, byId)), head }
}

/** La versión a la que vuelve Deshacer: la anterior a lo que se ve ahora. */
export function undoTarget(versions: Version[]): Version | null {
  const p = position(versions)
  return p && p.at > 0 ? p.steps[p.at - 1]! : null
}

/** Rehacer solo existe justo después de deshacer: un cambio nuevo encima corta la pila, como en Stitch. */
export function redoTarget(versions: Version[]): Version | null {
  const p = position(versions)
  return p && p.head.restoreFrom && p.at >= 0 && p.at < p.steps.length - 1 ? p.steps[p.at + 1]! : null
}
