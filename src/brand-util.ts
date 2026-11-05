// Helpers de validación compartidos por el consumidor de brand packs (brand-pack, brand.ts). Hoja: no importa a ningún
// módulo de marca, así el grafo de valor queda en una sola dirección (docs/estandares.md A4).

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

export function onlyKeys(obj: Record<string, unknown>, keys: readonly string[], at: string): void {
  const unknown = Object.keys(obj).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`brand pack: ${at}clave desconocida ${unknown.map((k) => `"${k}"`).join(', ')} (válidas: ${keys.filter((k) => k !== '$schema').join(', ')})`);
}

export const ACCENT_TOKENS: readonly string[] = ['--accent', '--accent-strong', '--accent-subtle', '--accent-foreground'];

export const withoutAccent = (tokens: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(isObject(tokens) ? tokens : {}).filter(([t]) => !ACCENT_TOKENS.includes(t)));
