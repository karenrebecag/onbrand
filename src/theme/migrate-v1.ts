// v1 -> v2 sin IO: lo usan el script de migración (scripts/brandpack-migrate-v2.ts) y applyTheme, que necesita un pack
// v2 para fusionar el tema del panel con el de la marca.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const V1_ONLY = ['accent', 'surface', 'fonts', 'tokens', 'tokensDark', 'inherit'];
// Claves de v1 que pasan tal cual: no cambian de forma en v2 (components conserva sus slugs, requires su pin).
const SAME = ['logo', 'logoDark', 'logoKind', 'composition', 'requires', 'components'];
const ACCENT: Record<string, string> = { base: '--accent', strong: '--accent-strong', subtle: '--accent-subtle', foreground: '--accent-foreground' };
const SURFACE: Record<string, string> = { background: '--background', surface: '--surface', foreground: '--foreground', textSecondary: '--text-secondary' };
// Palanca de contrato -> campo de theme. Solo migra si el valor es un número positivo; si no, queda en overrides y el
// parser decide (no se reinterpreta nada en silencio).
const LEVERS: Record<string, 'scale' | 'roundness'> = { '--scaling': 'scale', '--radius-factor': 'roundness' };

export const isV1 = (raw: unknown): boolean => isObj(raw) && V1_ONLY.some((k) => k in raw);

/** v1 -> v2, sin validar valores: eso es del parser. Lanza con una clave desconocida para no perderla. */
export function migrateV1ToV2(raw: Obj): Obj {
  if (!isV1(raw)) return raw;
  if ('theme' in raw || 'overrides' in raw || 'overridesDark' in raw) throw new Error('migracion: el pack mezcla v1 y v2');
  const known = new Set(['$schema', 'name', ...V1_ONLY, ...SAME]);
  const extra = Object.keys(raw).filter((k) => !known.has(k));
  if (extra.length) throw new Error(`migracion: clave desconocida ${extra.join(', ')}; no se pierde en silencio`);

  const theme: Obj = {};
  const overrides: Record<string, unknown> = {};
  if (typeof raw.accent === 'string') theme.preset = raw.accent;
  else if (isObj(raw.accent)) for (const [k, v] of Object.entries(raw.accent)) overrides[ACCENT[k] ?? `?${k}`] = v;
  if (isObj(raw.surface)) for (const [k, v] of Object.entries(raw.surface)) overrides[SURFACE[k] ?? `?${k}`] = v;
  if (isObj(raw.fonts)) theme.fonts = raw.fonts;
  for (const [t, v] of Object.entries(isObj(raw.tokens) ? raw.tokens : {})) {
    const field = LEVERS[t];
    const n = typeof v === 'string' ? Number(v) : v;
    if (field && typeof n === 'number' && Number.isFinite(n) && n > 0) theme[field] = n;
    else overrides[t] = v;
  }
  const bad = Object.keys(overrides).filter((t) => t.startsWith('?'));
  if (bad.length) throw new Error(`migracion: canal desconocido ${bad.map((b) => b.slice(1)).join(', ')}`);

  const schema = typeof raw.$schema === 'string' ? raw.$schema.replace(/brandpack\.schema\.json$/, 'brandpack-v2.schema.json') : undefined;
  return {
    ...(schema ? { $schema: schema } : {}),
    name: raw.name,
    ...Object.fromEntries(SAME.slice(0, 3).filter((k) => k in raw).map((k) => [k, raw[k]])),
    ...(Object.keys(theme).length ? { theme } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(raw.tokensDark !== undefined ? { overridesDark: raw.tokensDark } : {}),
    ...Object.fromEntries(SAME.slice(3).filter((k) => k in raw).map((k) => [k, raw[k]])),
  };
}
