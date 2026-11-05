// Condición de Arq y Orq para los bloques Pro bajo slots (agent-run, ai-composer): (a) el bloque no importa nada del core
// (<repo>/src/); (b) de apps/builder/src/lib solo tipos, para usar los del proyecto sin copias y sin correr lógica del builder.
// Un import mixto (`{ type A, b }`) cuenta como de valor. Resuelve rutas relativas y el alias `@/` (components.json).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

export const REPO = resolve(import.meta.dir, '../..')
export const BUILDER_SRC = join(REPO, 'apps/builder/src')

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g

export function resolveSpec(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return join(BUILDER_SRC, spec.slice(2))
  if (spec.startsWith('.')) return resolve(dirname(file), spec)
  return null
}

export function typeOnly(typeKw: string | undefined, clause: string): boolean {
  if (typeKw) return true
  const named = clause.match(/^\{([\s\S]*)\}$/)
  if (!named) return false
  const specs = named[1]!.split(',').map((s) => s.trim()).filter(Boolean)
  return specs.length > 0 && specs.every((s) => s.startsWith('type '))
}

/** Los imports del bloque que rompen (a) o (b), y cuántos imports de solo tipos trae de apps/builder/src/lib. */
export function blockImports(blockDir: string): { offenders: string[]; libTypeImports: number } {
  const core = join(REPO, 'src') + sep
  const lib = join(BUILDER_SRC, 'lib') + sep
  const offenders: string[] = []
  let libTypeImports = 0
  for (const name of readdirSync(blockDir).filter((f) => /\.tsx?$/.test(f))) {
    const file = join(blockDir, name)
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[4] ?? m[5]!
      const target = resolveSpec(file, spec)
      if (!target) continue
      if (target.startsWith(core)) offenders.push(`${name}: core ${spec}`)
      if (target.startsWith(lib)) {
        if (m[5] || !typeOnly(m[2], m[3]!.trim())) offenders.push(`${name}: valor de lib ${spec}`)
        else libTypeImports++
      }
    }
  }
  return { offenders, libTypeImports }
}
