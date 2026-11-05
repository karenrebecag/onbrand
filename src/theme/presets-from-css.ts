// Fuente de presets.json. Puro (recibe el CSS como string) para que el test de igualdad y el script de generación
// lean foundation.css con la misma función y no haya dos lecturas que puedan divergir.

export type ThemeMode = 'light' | 'dark';
export type TokenMap = Record<string, string>;
export type PresetTable = Record<string, Record<ThemeMode, TokenMap>>;

// Las reglas de preset de foundation.css:163-197 son de una línea: `[data-accent="x"]` (claro) o
// `[data-accent="x"][data-theme="dark"]` (oscuro), dos bloques por modo (accent* y control-*).
const PRESET_RULE = /^\[data-accent="([a-z]+)"\](\[data-theme="dark"\])?,[^{]*\{([^}]*)\}\s*$/;
const DECLARATION = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/;

/** Los valores tal como están escritos en cada regla de preset, por modo y en orden de aparición. No resuelve la
 * cascada entre modos: eso es de derive.ts, así este archivo es una transcripción que se puede comparar byte a byte. */
export function presetsFromCss(css: string): PresetTable {
  const out: PresetTable = {};
  for (const line of css.split('\n')) {
    const rule = PRESET_RULE.exec(line);
    if (!rule) continue;
    const [, name, dark, body] = rule;
    const mode: ThemeMode = dark ? 'dark' : 'light';
    const entry = (out[name] ??= { light: {}, dark: {} });
    for (const decl of body.split(';')) {
      if (!decl.trim()) continue;
      const m = DECLARATION.exec(decl);
      if (!m) throw new Error(`presets: declaración ilegible en el preset ${name} (${mode}): "${decl.trim()}"`);
      entry[mode][m[1]] = m[2];
    }
  }
  for (const [name, modes] of Object.entries(out)) {
    if (!Object.keys(modes.light).length || !Object.keys(modes.dark).length) throw new Error(`presets: el preset ${name} no trae reglas para los dos modos`);
  }
  return out;
}

/** Los dos primeros bloques de foundation.css: el tema claro (`:root, [data-theme]`) y el oscuro (`[data-theme="dark"]`),
 * tal como están escritos. Lo leen el gate AA (brand.ts) y, vía contract.json, la derivación pura de semilla, que necesita
 * el contrato para medir el contraste sin IO (derive.ts lo importa también el builder). */
export function contractFromCss(css: string): Record<ThemeMode, TokenMap> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: RegExp): TokenMap => {
    const body = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(clean)?.[1] ?? '';
    return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map((m) => [m[1], m[2].trim()]));
  };
  return { light: block(/:root,\s*\[data-theme\]/), dark: block(/\[data-theme="dark"\]/) };
}

/** El texto exacto de presets.json: lo que escribe el script y lo que el test compara. */
export const serializePresets = (table: PresetTable): string => `${JSON.stringify(table, null, 2)}\n`;

/** Los nombres `--x` que declara una hoja. */
export function cssVarNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]!);
  return names;
}
