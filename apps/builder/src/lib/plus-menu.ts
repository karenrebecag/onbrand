// Los mismos topes que valida POST /runs; validar aquí evita un 400 después de escribir.
export const MAX_RULES = 10
export const MAX_RULE_CHARS = 4000

export function cleanRules(rules: string[]): string[] {
  return rules.map((r) => r.trim()).filter(Boolean)
}

// El motor guarda adjuntos e instrucciones en el workspace para que queden en el commit; no son código de la página.
export const isPageFile = (path: string): boolean => !path.startsWith('attachments/') && path !== 'instructions.json'
