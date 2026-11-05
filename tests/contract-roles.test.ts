import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DERIVED_TOKENS, FORM_LEVERS, THIRD_PARTY_TOKENS } from '../src/brand';
import { cssVarNames } from '../src/theme/presets-from-css';

const ROOT = new URL('../', import.meta.url);
const FOUNDATION = fileURLToPath(new URL('templates/base-scaffold/src/theme/tokens.css', ROOT));

interface RoleEntry { role: string; source: number; why: string }
interface ContractRoles { roles: string[]; tokens: Record<string, RoleEntry> }

const roles = JSON.parse(readFileSync(fileURLToPath(new URL('src/theme/contract-roles.json', ROOT)), 'utf8')) as ContractRoles;
const css = readFileSync(FOUNDATION, 'utf8');
const names = [...cssVarNames(css)];

/** C1 del contrato: tokens de foundation.css sin rol, y roles de tokens que ya no existen. */
function classify(contract: readonly string[], map: Record<string, RoleEntry>): { unclassified: string[]; stale: string[] } {
  const set = new Set(contract);
  return {
    unclassified: contract.filter((t) => !(t in map)).sort(),
    stale: Object.keys(map).filter((t) => !set.has(t)).sort(),
  };
}

describe('contract-roles.json: C1 como test del contrato', () => {
  test('ningun token de foundation.css queda sin rol ni sobra un rol de un token que ya no existe', () => {
    expect(classify(names, roles.tokens)).toEqual({ unclassified: [], stale: [] });
  });

  test('el chequeo tiene dientes: un token nuevo sin rol se reporta', () => {
    const { ['--border']: _drop, ...sinBorder } = roles.tokens;
    expect(classify(names, sinBorder).unclassified).toEqual(['--border']);
    expect(classify([...names, '--token-nuevo'], roles.tokens).unclassified).toEqual(['--token-nuevo']);
  });

  test('cada rol pertenece al conjunto declarado', () => {
    const bad = Object.entries(roles.tokens).filter(([, e]) => !roles.roles.includes(e.role)).map(([t]) => t);
    expect(bad).toEqual([]);
  });

  test('source apunta a la linea donde foundation.css declara el token', () => {
    const lines = css.split('\n');
    const bad = Object.entries(roles.tokens).filter(([t, e]) => !new RegExp(`${t}\\s*:`).test(lines[e.source - 1] ?? '')).map(([t]) => t);
    expect(bad).toEqual([]);
  });

  test('cada token cita su fundamento con archivo:linea', () => {
    const bad = Object.entries(roles.tokens).filter(([, e]) => !/\.(css|ts|md):\d+/.test(e.why)).map(([t]) => t);
    expect(bad).toEqual([]);
  });

  // Las tres listas de brand.ts siguen cubriendo C1 hoy; el json debe decir lo mismo para no divergir en silencio.
  test('coincide con las listas vigentes de brand.ts', () => {
    const role = (t: string) => roles.tokens[t]?.role;
    expect(FORM_LEVERS.map(role).every((r) => r?.startsWith('derived-from:theme.'))).toBe(true);
    expect(DERIVED_TOKENS.map(role)).toEqual(DERIVED_TOKENS.map(() => 'derived-from:contract'));
    // Los de WhatsApp son del DS de Arc: el contrato del core no los declara (B9 paso 4).
    expect(THIRD_PARTY_TOKENS.filter((t) => t in roles.tokens)).toEqual([]);
  });
});
