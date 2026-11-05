// preserve.files y preserve.text (G4/G5): cuando el usuario eligió secciones (lápiz o chip de sección, `selectedSections`
// de #375), lo que el turno cambia fuera de ellas es defecto. Make enseña el diff del turno contra el primer padre de su
// commit y deja la decisión al usuario, con revertir por archivo (re-iteracion/deob/make-review/deobfuscated.js:951-961,
// 1371-1372, 268): no sabe qué estaba pedido. Nosotros sí lo sabemos cuando hay selección; sin selección (texto libre)
// no hay defecto, como en Make.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeDefect } from './runtime-sensors';
import { roleOf } from './shot-store';
import { gitEnv } from './runtime/git-env';

const SECTION = /^src\/sections\/(\d+-[\w-]+?)(?:\.module)?\.(?:tsx|css)$/;
// La receta de la versión, el plan y el montaje de App.tsx se tocan en cualquier turno y no son página de otra sección.
const METADATA = new Set(['request.json', 'page.json', 'page-plan.md', 'src/App.tsx']);

const git = (ws: string, args: string[]): string => spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8', env: gitEnv(), maxBuffer: 16 * 1024 * 1024 }).stdout ?? '';

/** Secciones elegidas en el turno: request.json más cada `steer` del log, cruzadas con los archivos reales de la
 * versión y su padre (`selectedSections` solo está validado en forma: un cliente puede mandar `99-x`). Sin ninguna
 * real, null: el turno es texto libre. */
export function turnScope(ws: string, parent: string | null, head: string, logFile?: string): Set<string> | null {
  const asked = new Set<string>();
  const add = (v: unknown): void => { if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') asked.add(s); };
  try { add((JSON.parse(readFileSync(join(ws, 'request.json'), 'utf8')) as { selectedSections?: unknown }).selectedSections); } catch { /* sin request.json no hay selección */ }
  if (logFile && existsSync(logFile)) {
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.includes('"steer"')) continue;
      try { const e = JSON.parse(line) as { type?: string; selectedSections?: unknown }; if (e.type === 'steer') add(e.selectedSections); } catch { /* línea a medias */ }
    }
  }
  const real = new Set([head, ...(parent ? [parent] : [])].flatMap((rev) => git(ws, ['ls-tree', '--name-only', rev, 'src/sections/']).split('\n')).map((p) => SECTION.exec(p)?.[1]).filter((s): s is string => Boolean(s)));
  const scope = new Set([...asked].filter((s) => real.has(s)));
  return scope.size ? scope : null;
}

// Renumerar reescribe el slug dentro del archivo (`slug="05-steps"`, el import del .module.css): en la ronda en vivo
// eso dejaba los renames en R086-R096 sin que la sección cambiara. sectionOp ya no renumera (#723), pero el agente puede
// renombrar al reescribir y los turnos viejos del historial lo hicieron.
const onlyRenumbered = (ws: string, parent: string, head: string, from: string, to: string): boolean => {
  const a = SECTION.exec(from)?.[1];
  const b = SECTION.exec(to)?.[1];
  return Boolean(a && b && roleOf(a) === roleOf(b) && git(ws, ['show', `${parent}:${from}`]).replaceAll(a as string, b as string) === git(ws, ['show', `${head}:${to}`]));
};

/** Archivos del turno fuera del alcance. Un rename que solo renumera no es un cambio de esa sección. */
export function filesOutOfScope(ws: string, parent: string, head: string, scope: ReadonlySet<string>): string[] {
  const roles = new Set([...scope].map(roleOf));
  const rows = git(ws, ['diff', '-M', '--name-status', parent, head]).split('\n').filter(Boolean).map((l) => l.split('\t'));
  // Un archivo corto con el slug en casi todas sus líneas baja del 50 % de similitud y git lo da como D + A.
  const kind = (p: string): string => `${roleOf(SECTION.exec(p)?.[1] ?? '')}${p.endsWith('.css') ? '.css' : '.tsx'}`;
  const deleted = rows.filter(([s, p]) => s === 'D' && p && SECTION.test(p)).map(([, p]) => p as string);
  const paired = new Set<string>();
  for (const [s, to] of rows) {
    if (s !== 'A' || !to || !SECTION.test(to)) continue;
    const from = deleted.find((p) => !paired.has(p) && kind(p) === kind(to) && onlyRenumbered(ws, parent, head, p, to));
    if (from) paired.add(from).add(to);
  }
  return rows.flatMap(([status = '', ...paths]) => {
    const path = paths[paths.length - 1] ?? '';
    if (status === 'R100' || METADATA.has(path) || paired.has(path)) return [];
    if (status.startsWith('R') && onlyRenumbered(ws, parent, head, paths[0] ?? '', path)) return [];
    const slug = SECTION.exec(path)?.[1];
    return slug && roles.has(roleOf(slug)) ? [] : [path];
  });
}

/** Corre en el navegador: texto visible de cada sección. */
export function collectTexts(): Record<string, string> {
  return Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-wt-slug]')].map((e) => [e.getAttribute('data-wt-slug') ?? '', e.innerText]));
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Texto visible de las secciones fuera del alcance contra el de la base, emparejadas por rol. */
export function textOutOfScope(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>, scope: ReadonlySet<string>): string[] {
  const roles = new Set([...scope].map(roleOf));
  const old = new Map(Object.entries(before).map(([slug, t]) => [roleOf(slug), t]));
  return Object.entries(after).filter(([slug, t]) => !roles.has(roleOf(slug)) && old.has(roleOf(slug)) && norm(old.get(roleOf(slug)) ?? '') !== norm(t)).map(([slug]) => slug);
}

export function scopeDefects(files: readonly string[], texts: readonly string[], scope: ReadonlySet<string>, viewport: number): RuntimeDefect[] {
  const asked = [...scope].join(', ');
  return [
    ...(files.length ? [{ field: 'preview.runtime' as const, owner: 'B' as const, kind: 'preserve-files' as const, slug: null, viewport, message: `el pedido era sobre ${asked} y el turno cambió ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` y ${files.length - 6} más` : ''}`.slice(0, 300) }] : []),
    ...texts.map((slug) => ({ field: 'preview.runtime' as const, owner: 'B' as const, kind: 'preserve-text' as const, slug, viewport, message: `el pedido era sobre ${asked} y cambió el texto de ${slug}` })),
  ];
}
