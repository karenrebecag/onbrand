// Entorno de todo `git` que corre sobre un workspace: lo escribe el agente, y un hook o filtro suyo (`.git/hooks`, `core.*`) lee el env del
// proceso. Solo lo que git necesita para ejecutarse: nada de WT_*, claves ni tokens, y ningún GIT_* heredado (GIT_DIR o GIT_INDEX_FILE
// del proceso redirigirían el repositorio).

const KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL'] as const;

/** `extra` va encima (GIT_INDEX_FILE, GIT_CONFIG_*): lo que el llamador decide explícitamente. */
export function gitEnv(extra: Readonly<Record<string, string>> = {}, source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEEP) if (source[k] !== undefined) out[k] = source[k]!;
  return { ...out, ...extra };
}
