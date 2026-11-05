// Parsers puros del cuerpo de POST /runs: validan un campo del request (dato externo) y devuelven el valor limpio o lanzan
// HttpError 400. Hoja sin estado de la partición de transport.ts (ADR 0014).

import { isBrandId } from '../brand-registry';
import { isPermissionMode, type PermissionMode } from './approvals';
import { isAgentAppSlug } from './connectors';
import type { Viewport } from './follow-up-context';
import { HttpError } from './http';
import { SECTION_SLUG } from './section-ops';
import { EFFORTS, type ThinkingEffort } from './shared';

export function parseBrand(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!isBrandId(v)) throw new HttpError(400, 'brand debe ser un id de marca en kebab-case');
  return v;
}

export function parsePermissionMode(v: unknown): PermissionMode | undefined {
  if (v === undefined) return undefined;
  if (!isPermissionMode(v)) throw new HttpError(400, 'permissionMode debe ser ask|auto');
  return v;
}

export function parseConnectors(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 20 || v.some((s) => typeof s !== 'string' || !isAgentAppSlug(s))) throw new HttpError(400, 'connectors debe ser un array de hasta 20 slugs de app (sin wt, approval ni __)');
  return [...new Set(v as string[])];
}

export function parseSelectedSections(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 20 || v.some((s) => typeof s !== 'string' || !SECTION_SLUG.test(s))) throw new HttpError(400, 'selectedSections debe ser un array de hasta 20 slugs NN-rol');
  return [...new Set(v as string[])];
}

const MAX_VIEWPORT_PX = 10_000;

/** `viewport` del request (dato externo): ancho y alto enteros acotados y, si viene, el tema; lo demás se descarta. */
export function parseViewport(v: unknown): Viewport | undefined {
  if (v === undefined) return undefined;
  const o = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const px = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_VIEWPORT_PX;
  if (!o || !px(o.width) || !px(o.height)) throw new HttpError(400, `viewport debe ser { width, height } en px enteros entre 1 y ${MAX_VIEWPORT_PX}`);
  if (o.colorScheme !== undefined && o.colorScheme !== 'light' && o.colorScheme !== 'dark') throw new HttpError(400, 'viewport.colorScheme debe ser light o dark');
  return { width: o.width, height: o.height, ...(o.colorScheme ? { colorScheme: o.colorScheme } : {}) };
}

export function parseThinking(v: unknown): { effort: ThinkingEffort } | undefined {
  if (v === undefined) return undefined;
  const effort = typeof v === 'object' && v !== null ? (v as { effort?: unknown }).effort : undefined;
  if (!EFFORTS.includes(effort as ThinkingEffort)) throw new HttpError(400, `thinking.effort debe ser ${EFFORTS.join('|')}`);
  return { effort: effort as ThinkingEffort };
}

export function parseTools(v: unknown): { webSearch: boolean } | undefined {
  if (v === undefined) return undefined;
  const webSearch = typeof v === 'object' && v !== null ? (v as { webSearch?: unknown }).webSearch : undefined;
  if (typeof webSearch !== 'boolean') throw new HttpError(400, 'tools.webSearch debe ser boolean');
  return { webSearch };
}
