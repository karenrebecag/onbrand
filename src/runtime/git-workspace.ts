// El workspace de una página es un repo git, como el de la VM de v0 (VERIFIED: vm/git?type=vm_diff y
// vm/workspace-git-status, v0-endpoint-map.md §4f). Un commit por mensaje: el snapshot es el sha, el
// diffstat sale de git y un follow-up sigue sobre el mismo workspace. Usa el git del sistema.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gitEnv } from './git-env';

// Identidad fija y sin firma: el commit es del runner, no de quien lo corre, y no debe depender de la
// config global de git de la máquina. El .git lo puede escribir el agente: sin hooks ni fsmonitor, un archivo suyo en
// .git/hooks o core.fsmonitor no corre en el proceso del runtime al commitear (como export.ts con fsmonitor).
const IDENTITY = ['-c', 'user.name=web-transformer', '-c', 'user.email=runner@web-transformer.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

function git(dir: string, args: string[]): string {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} falló en ${dir}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

export const isRepo = (dir: string): boolean => existsSync(join(dir, '.git'));

export function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
}

// El install y el build del ws no son de la página, sea cual sea el scaffold: sin esto la exclusión dependía de su
// .gitignore, que una distro puede no traer y que el agente puede editar o borrar (Write sobre el ws). Entre #852 y #856
// el base no lo traía y cada versión guardaba node_modules entero. Los dos globs: `**/node_modules` solo no cubre su
// contenido, y `/**` solo no cubre un node_modules que sea symlink.
const BUILD_PATHS = [':(glob)**/node_modules', ':(glob)**/node_modules/**', ':(top)dist', ':(top)dist-ssr'];
const BUILD_OUT = BUILD_PATHS.map((p) => p.replace(':(', ':(exclude,'));
// `.wt` nunca entra a una versión (ver KEEP): sin .gitignore del registry, el lienzo y el stream del CLI se commiteaban, y
// volver a otra versión los borraba del árbol. Medir cambios con la misma vara: lo que nunca entra a una versión tampoco
// cuenta como cambio (un plan en .wt/plans hacía pasar por escritura un build que falló sin escribir).
const OUT_OF_VERSION = [':(exclude).wt', ...BUILD_OUT];
// Los diffs entre versiones con la misma regla: un ws de #852-#856 versionó node_modules, y su versión que migra (y las
// anteriores) listaban cientos de archivos del install en Cambios y en el picker.
const PAGE_ONLY = ['--', '.', ...BUILD_OUT];
// En `add`, un exclude con prefijo literal sobre una ruta que el .gitignore ya ignora aborta ("paths are ignored", git
// 2.54): `dist` no puede ir aquí. Los globs de node_modules empiezan con comodín y no disparan ese chequeo.
const NM_OUT = [':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**'];
const ADD_OUT = [':(exclude).wt', ...NM_OUT];

/** Commitea el árbol de la página (sin .wt, node_modules ni dist) y devuelve el sha. */
export function commitAll(dir: string, message: string): string {
  git(dir, ['add', '-A', '--', '.', ...ADD_OUT]);
  // Saca del índice lo que el add no puede excluir (dist sin .gitignore) y lo que ya estaba versionado: los ws del base
  // creados entre #852 y #856 guardaron node_modules, y un pathspec del add no lo quita.
  if (git(dir, ['ls-files', '--', ...BUILD_PATHS]).trim()) git(dir, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...BUILD_PATHS]);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return headSha(dir);
}

export const headSha = (dir: string): string => git(dir, ['rev-parse', 'HEAD']).trim();

/** Workspace propio para una variante (S5): cada una escribe su App.tsx y corre su vite, así N agentes no chocan.
 * Clon local (los objetos se comparten por hardlink) parado en `sha`, sin remoto que apunte al de la fuente. Lo ignorado
 * (node_modules, .wt) no viaja: el turno lo instala y lo arma como en cualquier follow-up. */
export function forkRepo(src: string, dest: string, sha: string): void {
  git(dirname(dest), ['clone', '-q', src, basename(dest)]);
  git(dest, ['checkout', '-q', '-B', 'main', sha]);
  git(dest, ['remote', 'remove', 'origin']);
}

// `.wt` guarda estado del workspace fuera de las versiones (lienzo, sesión del CLI, stream crudo): solo lo ignora git cuando
// el DS del registry escribió su .gitignore, así que el clean lo excluye siempre (canvas-store.ts:2). El install y el build
// tampoco se borran aunque el scaffold no los ignore: reinstalar en cada restore costaría el turno.
const KEEP = ['-e', '/.wt', '-e', '/node_modules', '-e', '/dist', '-e', '/dist-ssr'];

/** Deja el árbol de trabajo igual al commit dado sin reescribir historia: el siguiente commit cuelga
 * de HEAD con el contenido de ese sha. Así volver a una versión vieja también es un mensaje más. Los archivos nuevos sin
 * versionar se borran: read-tree solo repone lo versionado, y lo que dejó una corrida fallida entraba al siguiente turno o
 * al commit del restore (nosotros.md §7.7; ADR 0013, regla común 1). node_modules y dist quedan por KEEP. */
export function restoreTree(dir: string, sha: string): void {
  git(dir, ['read-tree', '-u', '--reset', sha]);
  git(dir, ['clean', '-fdq', ...KEEP]);
}

// Solo los commits del runner y del transport: el mensaje de un turno es el brief y podría empezar igual.
const BASE_COMMIT = /^base: (scaffold|ds@)/;

/** El último commit "base: …" del hilo: el scaffold, o el DS del registry que el transport commitea después (con la
 * marca del pack ya aplicada). Lo que hay antes no es de la página. */
export function lastBaseCommit(dir: string): string {
  const line = git(dir, ['log', '--first-parent', '--format=%H %s', 'HEAD']).split('\n').find((l) => BASE_COMMIT.test(l.slice(41)));
  return line ? line.slice(0, 40) : git(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0];
}

/** Lo que la página cambió desde el último commit base, incluido lo que el turno aún no commiteó: los archivos de la
 * página frente a los de la librería y la marca. Es el criterio de dueño de un error de tipos (gen fac2bce5: contra la
 * raíz, el identity.css del pack del registry salía como editado por el agente). */
export function filesSinceBase(dir: string): string[] {
  const base = lastBaseCommit(dir);
  const changed = git(dir, ['diff', '--name-only', base, '--', '.', ...BUILD_OUT]).split('\n');
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ...BUILD_OUT]).split('\n');
  return [...new Set([...changed, ...untracked].filter(Boolean))].sort();
}

/** Sin cambios respecto de HEAD, incluidos los que no pasan por Write/Edit del agente (un `mv` por Bash). */
export function isClean(dir: string): boolean {
  return git(dir, ['status', '--porcelain', '--', '.', ...OUT_OF_VERSION]) === '';
}

/** Vuelve la rama a `sha` con su árbol: descarta commits propios que ninguna versión referencia (el montaje de un DS que
 * no pasó el build). Reescribe solo lo que el llamador acaba de crear; una versión nunca apunta a esos commits. */
export function rewindTo(dir: string, sha: string): void {
  git(dir, ['reset', '--hard', sha]);
  git(dir, ['clean', '-fdq', ...KEEP]);
}

/** Descarta lo que una corrida cortada dejó a medias: archivos versionados vuelven a HEAD y los nuevos
 * se borran. node_modules y dist se quedan por KEEP, haya o no .gitignore. */
export function discardChanges(dir: string): void {
  restoreTree(dir, 'HEAD');
}

export interface FileStat {
  additions: number;
  deletions: number;
}

/** Líneas agregadas/borradas de un archivo del árbol de trabajo contra HEAD. Un archivo nuevo cuenta
 * todas sus líneas como agregadas (intent-to-add lo hace visible a diff sin stagearlo). */
export function fileStat(dir: string, path: string): FileStat {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', path], { cwd: dir, env: gitEnv() }).status === 0;
  if (!tracked) git(dir, ['add', '-N', path]);
  const out = git(dir, ['diff', '--numstat', 'HEAD', '--', path]).trim();
  if (!out) return { additions: 0, deletions: 0 };
  const [a, d] = out.split('\t');
  // Un binario da "-": no tiene líneas.
  return { additions: Number(a) || 0, deletions: Number(d) || 0 };
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  patch: string;
}

const STATUS: Record<string, DiffFile['status']> = { A: 'added', M: 'modified', D: 'deleted' };

/** +N/-N de un rango por archivo, sin los patches: lo que el picker de versiones pinta junto a cada una. */
export function diffStats(dir: string, base: string, head: string, exclude: string[] = []): Omit<DiffFile, 'status' | 'patch'>[] {
  return git(dir, ['diff', '--numstat', '--no-renames', base, head, ...PAGE_ONLY]).trim().split('\n').filter(Boolean).map((l) => {
    const [a, d, path] = l.split('\t');
    // Un binario da "-": no tiene líneas.
    return { path, additions: Number(a) || 0, deletions: Number(d) || 0 };
  }).filter((f) => !exclude.includes(f.path));
}

/** Diff entre dos commits, por archivo, con su patch unificado. */
export function diffCommits(dir: string, base: string, head: string): DiffFile[] {
  const status = new Map(
    git(dir, ['diff', '--name-status', '--no-renames', base, head, ...PAGE_ONLY]).trim().split('\n').filter(Boolean).map((l) => {
      const [s, p] = l.split('\t');
      return [p, STATUS[s[0]] ?? 'modified'] as const;
    }),
  );
  const stats = git(dir, ['diff', '--numstat', '--no-renames', base, head, ...PAGE_ONLY]).trim().split('\n').filter(Boolean);
  return stats.map((l) => {
    const [a, d, path] = l.split('\t');
    return {
      path,
      status: status.get(path) ?? 'modified',
      additions: Number(a) || 0,
      deletions: Number(d) || 0,
      patch: git(dir, ['diff', '--no-renames', base, head, '--', path]),
    };
  });
}

/** Contenido de un archivo en un commit. */
export const showFile = (dir: string, sha: string, path: string): string => git(dir, ['show', `${sha}:${path}`]);

/** Padre de un commit, o undefined si es la raíz. */
export function parentOf(dir: string, sha: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', `${sha}^`], { cwd: dir, encoding: 'utf8', env: gitEnv() });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Hash del árbol de trabajo tal como está (versionado, nuevo sin ignorar y borrado), sin tocar el índice real: un índice
 * temporal recibe `add -A` y `write-tree` da el árbol. Dos llamadas con el mismo hash = nada cambió entre ellas. */
export function worktreeTree(dir: string): string {
  const index = join(dir, '.git', `wt-tree-index-${process.pid}`);
  const env = gitEnv({ GIT_INDEX_FILE: index });
  try {
    // El install no cuenta como cambio de la página, y hashearlo en cada llamada cuesta segundos sin .gitignore.
    for (const args of [['add', '-A', '--', '.', ...NM_OUT], ['write-tree']]) {
      const r = spawnSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} falló en ${dir}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      if (args[0] === 'write-tree') return r.stdout.trim();
    }
    throw new Error('write-tree sin salida');
  } finally {
    rmSync(index, { force: true });
  }
}

/** Rutas que difieren entre dos árboles (de worktreeTree o commits). */
export const treeChanges = (dir: string, a: string, b: string): string[] =>
  a === b ? [] : git(dir, ['diff', '--name-only', '--no-renames', a, b]).split('\n').filter(Boolean).sort();

/** Rutas del árbol de trabajo que difieren de `sha` (versionadas o nuevas sin ignorar). Contra un commit dado y no contra
 * HEAD: construir sobre una versión vieja restaura su árbol sin mover HEAD. */
export function changedSince(dir: string, sha: string): string[] {
  const changed = git(dir, ['diff', '--name-only', sha, '--', '.', ...OUT_OF_VERSION]).split('\n');
  const untracked = git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ...OUT_OF_VERSION]).split('\n');
  return [...new Set([...changed, ...untracked].filter(Boolean))].sort();
}

/** Rutas que cambian de `base` a `head` (altas, cambios y bajas), ordenadas. */
export function changedFiles(dir: string, base: string, head: string): string[] {
  return git(dir, ['diff', '--name-only', '--no-renames', base, head, ...PAGE_ONLY]).split('\n').filter(Boolean).sort();
}

/** Archivos versionados bajo las rutas dadas en un commit. */
export function listFiles(dir: string, sha: string, paths: string[]): string[] {
  return git(dir, ['ls-tree', '-r', '--name-only', sha, '--', ...paths]).trim().split('\n').filter(Boolean);
}

export interface TreeEntry {
  path: string;
  size: number;
  /** modo git: 100644/100755 blob regular, 120000 symlink, 160000 submódulo. El MCP solo sirve blobs regulares. */
  mode: string;
}

/** Árbol completo commiteado en `sha` (blobs, symlinks y submódulos) con su tamaño, ordenado. No entra en submódulos ni
 * lista `.wt`/`node_modules`: no están commiteados. `-z` evita el escape octal de nombres raros; el tamaño de un symlink o
 * submódulo viene como `-`. */
export function treeEntries(dir: string, sha: string): TreeEntry[] {
  return git(dir, ['ls-tree', '-r', '--long', '-z', sha])
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      const [mode, , , size] = row.slice(0, tab).split(/\s+/);
      return { path: row.slice(tab + 1), mode: mode ?? '', size: size === '-' ? 0 : Number(size) || 0 };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Bytes crudos de un blob commiteado, sin decodificar a utf8: así se distingue texto de binario. `path` es una ruta del
 * árbol (verificada por el llamador contra `treeEntries`), no del disco; no hay acceso a archivos fuera del commit. */
export function showFileBytes(dir: string, sha: string, path: string): Buffer {
  // Mismas defensas que sourceZip (export.ts): tope de tiempo y sin config global/sistema, porque el .git del ws lo
  // puede tocar el agente. El mensaje no lleva `dir`: el handler de 500 devuelve e.message al cliente.
  const r = spawnSync('git', ['cat-file', 'blob', `${sha}:${path}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL', env: gitEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }) });
  if (r.status !== 0) throw new Error(`git cat-file blob falló (${path})`);
  return r.stdout;
}
