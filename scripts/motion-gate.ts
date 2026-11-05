// Corre el gate de motion sobre el vault (html.md de motion-gsap, tal cual) o sobre módulos ya normalizados.
//   bun scripts/motion-gate.ts vault [<slug>...]     baseline del vault crudo (motion-gsap)
//   bun scripts/motion-gate.ts html [<slug>...]      baseline de motion-html (Osmo)
//   bun scripts/motion-gate.ts dir <dir>             cada <effect>.ts (+ <effect>.css) del directorio
//   --json para la salida completa

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gateMotion, type MotionSource, type MotionVerdict } from '../src/motion-gate';
import { MOTION_DIR, parseFences } from './motion-gsap-extract';

export const MOTION_HTML_DIR = join(MOTION_DIR, '..', '..', 'motion-html');

const readAll = (dir: string, re: RegExp): string =>
  readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

/** motion-html (Osmo): js*.js + css*.css por entrada; doc.md es un volcado de la página, no se usa. */
export function htmlSource(slug: string): MotionSource | null {
  const dir = join(MOTION_HTML_DIR, slug);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const js = readAll(dir, /^js(-\d+)?\.js$/);
  return js ? { js, css: readAll(dir, /^css(-\d+)?\.css$/) } : null;
}

export function vaultSource(slug: string): MotionSource | null {
  const path = join(MOTION_DIR, slug, 'html.md');
  if (!existsSync(path)) return null;
  const fences = parseFences(readFileSync(path, 'utf8'));
  const js = fences.filter((f) => f.lang === 'js' || f.lang === 'javascript').map((f) => f.code).join('\n');
  const css = fences.filter((f) => f.lang === 'css').map((f) => f.code).join('\n');
  return js ? { js, css } : null;
}

function dirSources(dir: string): [string, MotionSource][] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'runtime.ts' && !f.endsWith('.test.ts'))
    .map((f) => {
      const name = f.replace(/\.ts$/, '');
      const css = join(dir, `${name}.css`);
      return [name, { js: readFileSync(join(dir, f), 'utf8'), ...(existsSync(css) ? { css: readFileSync(css, 'utf8'), cssFile: `${name}.css` } : {}) }];
    });
}

function summarize(results: [string, MotionVerdict][]): string {
  const passed = results.filter(([, v]) => v.pass).map(([s]) => s);
  const lines = [`${passed.length}/${results.length} pasan`];
  const byRule = new Map<string, number>();
  for (const [, v] of results) for (const r of new Set(v.failures.map((f) => f.rule))) byRule.set(r, (byRule.get(r) ?? 0) + 1);
  lines.push(`fallas por regla (módulos): ${[...byRule].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`);
  for (const [slug, v] of results) {
    if (v.pass) { lines.push(`PASS ${slug}`); continue; }
    lines.push(`FAIL ${slug}: ${[...new Set(v.failures.map((f) => f.rule))].join(', ')}`);
    for (const f of v.failures.slice(0, 6)) lines.push(`     ${f.rule}: ${f.detail}`);
    if (v.failures.length > 6) lines.push(`     … ${v.failures.length - 6} más`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2).filter((a) => a !== '--json');
  const asJson = process.argv.includes('--json');
  let results: [string, MotionVerdict][];
  if (mode === 'vault') {
    const slugs = rest.length ? rest : readdirSync(MOTION_DIR).sort();
    results = slugs.flatMap((s) => { const src = vaultSource(s); return src ? [[s, gateMotion(src)] as [string, MotionVerdict]] : []; });
  } else if (mode === 'html') {
    const slugs = rest.length ? rest : readdirSync(MOTION_HTML_DIR).sort();
    results = slugs.flatMap((s) => { const src = htmlSource(s); return src ? [[s, gateMotion(src)] as [string, MotionVerdict]] : []; });
  } else if (mode === 'dir' && rest[0]) {
    results = dirSources(rest[0]).map(([s, src]) => [s, gateMotion(src)]);
  } else {
    console.error('uso: bun scripts/motion-gate.ts vault|html [<slug>...] | dir <dir> [--json]');
    process.exit(2);
  }
  console.log(asJson ? JSON.stringify(Object.fromEntries(results), null, 2) : summarize(results));
  if (results.some(([, v]) => !v.pass)) process.exitCode = 1;
}

if (import.meta.main) await main();
