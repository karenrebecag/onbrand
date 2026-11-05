const KIND = { '+': 'add', '-': 'del' } as const

export type LineKind = 'add' | 'del' | 'ctx'
export interface PatchLine { kind: LineKind; no: number; text: string }

/** Diff unificado del transport (git contra el commit padre). Se saltan las cabeceras del patch; los
 * números de línea salen de los hunks para que coincidan con el archivo real. */
export function patchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); continue }
    // Una línea vacía solo aparece al final del patch: el contexto vacío de git llega como ' '.
    if (line === '') continue
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|\\ No newline)/.test(line)) continue
    const kind = (KIND[line[0] as '+' | '-'] ?? 'ctx') as LineKind
    out.push({ kind, no: kind === 'del' ? oldNo++ : newNo++, text: line.slice(1) })
    if (kind === 'ctx') oldNo++
  }
  return out
}

