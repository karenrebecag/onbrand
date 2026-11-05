// shotStore y la poda por versión del store visual (wt-visual/<sha>/), más roleOf. preserve.visual (la comparación de
// capturas entre versiones) se revirtió por falta de respaldo (fila 9 del cierre de módulo); queda el store porque ahí
// viven dom@1440.html (H12) y texts.json (preserve.text), y su poda para que no crezca sin tope.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { roleOfSlug } from './section-slug';
import { gitEnv } from './runtime/git-env';

/** El de src/section-slug.ts: la copia `04-casos-2` es de rol `casos`, como su origen. */
export const roleOf = roleOfSlug;

/** Una versión deja ~1 MB de artefactos (DOM + textos): se guardan las últimas, suficientes para un restore cercano. */
const KEEP_VERSIONS = 12;
/** Carpeta del store dentro de .git; también es la guarda de pruneVersions (solo poda bajo este nombre). */
const STORE_DIR = 'wt-visual';

const git = (ws: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', ['-C', ws, ...args], { encoding: 'utf8', env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
};

/** Directorio de artefactos de una versión dentro de .git del workspace (nunca en el árbol: la versión ya está commiteada). */
export function shotStore(ws: string, sha: string): string | null {
  const gitDir = git(ws, ['rev-parse', '--absolute-git-dir']);
  return gitDir.ok ? join(gitDir.out.trim(), STORE_DIR, sha) : null;
}

/** Conserva solo las KEEP_VERSIONS versiones más recientes bajo wt-visual/, borrando las más viejas. Se llama una vez por
 * versión (desde saveDom): sin tope, wt-visual/ crece sin fin. Toma el dir de la versión y poda sus hermanos.
 *
 * Guarda crítica: solo poda si el padre es exactamente `wt-visual`. Sin esto, un dir cuyo padre fuera otro (un test con
 * un tmpdir directo) borraría sus hermanos ajenos (hasta todo $TMPDIR menos 12). lstat (no stat) no sigue symlinks:
 * un enlace colgante no revienta ni cuenta como versión, y solo se podan directorios reales. */
export function pruneVersions(dir: string): void {
  const root = join(dir, '..');
  if (basename(root) !== STORE_DIR) return;
  const versions = readdirSync(root).flatMap((d) => {
    try { return lstatSync(join(root, d)).isDirectory() ? [{ d, t: lstatSync(join(root, d)).mtimeMs }] : []; }
    catch { return []; }
  });
  const old = versions.sort((a, b) => b.t - a.t).slice(KEEP_VERSIONS);
  for (const { d } of old) rmSync(join(root, d), { recursive: true, force: true });
}
