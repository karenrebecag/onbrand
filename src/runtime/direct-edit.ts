// Edición sin modelo (Stitch Direct Edit: texto, borrar, imagen, sección) y la vía de parche de Editar con IA (H5): de
// la forma del body a los archivos escritos y al tsc en seco. No toca el índice ni el log del transport: eso sigue en
// Runtime.startDirectEdit/runDirectEdit, que solo llaman aquí. Paso 3 de la modularización de transport.ts.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Suggestion } from './events';
import { discardChanges, headSha, restoreTree } from './git-workspace';
import { quickEditText } from './text-edit';
import { type Composed } from './patch-ai';
import { bytesMatchType, replaceImage, uploadedImagePath } from './image-replace';
import { deleteElement, type DeleteTarget } from './element-delete';
import { applyOrder, sectionOp, type SectionOp } from './section-ops';
import { parseTscOutput, runTsc, type TscError } from './workspace-tools';
import type { UploadStore } from './uploads';
import { HttpError } from './http';

/** Una edición sin modelo: archivos que se escriben y que se borran, en un solo commit (una sección mueve varios). */
export interface DirectEdit {
  name: 'text-edit' | 'delete-element' | 'replace-image' | 'section-op' | 'patch-ai';
  title: string;
  labels: [string, string];
  writes: Record<string, string>;
  deletes: string[];
  summary: string;
  notes?: string[];
  /** Pedidos listos para el arreglo que la edición dejó pendiente: el builder los ofrece como primer chip. */
  followUps?: Suggestion[];
  /** Un archivo que entra al workspace con el cambio: la imagen subida que pasa a public/uploads. */
  asset?: { file: string; body: Buffer };
  /** Sin el tsc del workspace (5 s), como Stitch guarda Edit Text sin verificar (DesignPage wakaru l.10996-11009): texto
   * sin { } < > \ ni ` (text-edit.ts UNSAFE) en JSX o en un atributo de texto, y mover una sección, que solo reordena
   * líneas e items sin cambiar un import ni un tipo. */
  skipTypecheck?: boolean;
}

/** Lo que la edición directa necesita del transport: el compilador y el tsc inyectables (tests) y el store de uploads
 * para resolver una imagen subida. */
export interface DirectEditDeps {
  typescript?: typeof import('typescript');
  tsc?: (dir: string) => string | Promise<string>;
  uploads: Pick<UploadStore, 'resolve'>;
}

type Fail = (r: { reason: string; message: string }) => never;

// Sin dependencia nueva en la raíz: todo workspace trae typescript para su propio typecheck.
export const loadTypescript = (dir: string): typeof import('typescript') => {
  try { return createRequire(join(dir, 'package.json'))('typescript') as typeof import('typescript'); } catch { throw new HttpError(409, 'el workspace no tiene typescript instalado: usa Editar con IA'); }
};

/** Copia la imagen subida dentro del workspace. El agente puede commitear un symlink en public/ o en public/uploads:
 * cada tramo se revisa antes de escribir para no salir del workspace a través de él. */
export function writeAsset(dir: string, asset: { file: string; body: Buffer }): void {
  let at = dir;
  for (const part of asset.file.split('/')) {
    at = join(at, part);
    // lstat y no existsSync: un symlink roto no "existe" pero writeFileSync lo seguiría igual.
    let link = false;
    try { link = lstatSync(at).isSymbolicLink(); } catch { /* no existe todavía */ }
    if (link) throw new Error(`${asset.file} pasa por un enlace: usa Editar con IA`);
  }
  mkdirSync(dirname(join(dir, asset.file)), { recursive: true });
  writeFileSync(join(dir, asset.file), asset.body);
}

/** La ruta escapa del workspace: es un symlink o su directorio real no es el del workspace. Cierra el traversal por
 * enlaces que el agente pudo dejar en el árbol (un `src/sections -> ~/.ssh` commiteado). */
export function escapesWorkspace(dir: string, path: string): boolean {
  const full = join(dir, path);
  if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
  try {
    return realpathSync(dirname(full)) !== join(realpathSync(dir), dirname(path));
  } catch {
    return true;
  }
}

/** Escribe y borra en el orden que pide applyOrder (una sección renombra archivos: primero los borrados). */
export function applyEdits(dir: string, writes: Record<string, string>, deletes: readonly string[]): void {
  for (const s of applyOrder(writes, deletes)) {
    if (s.op === 'write') writeFileSync(join(dir, s.path), writes[s.path]!);
    else rmSync(join(dir, s.path), { force: true });
  }
}

/** Del body de POST /runs a la edición: valida la forma y ubica el elemento en los archivos de la versión padre. */
export function directEdit(deps: DirectEditDeps, b: Record<string, unknown>, files: Record<string, string>, dir: string): DirectEdit {
  const fail: Fail = (r) => { throw new HttpError(r.reason === 'invalid' || r.reason === 'unsafe' ? 422 : 409, r.message); };
  if (b.textEdit !== undefined) {
    const edit = b.textEdit as Record<string, unknown> | null;
    if (typeof edit !== 'object' || edit === null || typeof edit.before !== 'string' || typeof edit.after !== 'string') throw new HttpError(400, 'textEdit es {before, after} con dos strings');
    const found = quickEditText(deps.typescript ?? loadTypescript(dir), files, edit.before, edit.after);
    if (!found.ok) return fail(found);
    return { name: 'text-edit', title: 'Edited text', labels: ['Editing text', 'Edited text'], writes: { [found.path]: found.source }, deletes: [], summary: `${found.path} (${found.strategy})`, skipTypecheck: found.typeSafe };
  }
  if (b.sectionOp !== undefined) {
    const op = b.sectionOp as Record<string, unknown> | null;
    const valid = typeof op === 'object' && op !== null && typeof op.slug === 'string'
      && (op.op === 'remove' || op.op === 'duplicate' || (op.op === 'move' && (op.to === 'up' || op.to === 'down')));
    if (!valid) throw new HttpError(400, "sectionOp es {op: 'move', slug, to: 'up'|'down'}, {op: 'remove', slug} o {op: 'duplicate', slug}");
    const found = sectionOp(deps.typescript ?? loadTypescript(dir), files, op as SectionOp);
    if (!found.ok) return fail(found);
    const title = op.op === 'move' ? 'Moved section' : op.op === 'remove' ? 'Removed section' : 'Duplicated section';
    const labels: [string, string] = op.op === 'move' ? ['Moving section', 'Moved section'] : op.op === 'remove' ? ['Removing section', 'Removed section'] : ['Duplicating section', 'Duplicated section'];
    return { name: 'section-op', title, labels, writes: found.writes, deletes: found.deletes, summary: found.summary, notes: found.notes, followUps: found.followUps, skipTypecheck: op.op === 'move' };
  }
  if (b.replaceImage !== undefined) return imageEdit(deps, b.replaceImage, files, dir, fail);
  const target = b.deleteElement as Record<string, unknown> | null;
  const valid = typeof target === 'object' && target !== null
    && ((target.kind === 'text' && typeof target.text === 'string') || (target.kind === 'image' && typeof target.src === 'string'));
  if (!valid) throw new HttpError(400, "deleteElement es {kind: 'text', text} o {kind: 'image', src}");
  const found = deleteElement(deps.typescript ?? loadTypescript(dir), files, target as DeleteTarget);
  if (!found.ok) return fail(found);
  return { name: 'delete-element', title: 'Deleted element', labels: ['Deleting element', 'Deleted element'], writes: { [found.path]: found.source }, deletes: [], summary: `${found.path} (<${found.tag}>)` };
}

/** {src, url} cambia a una URL externa, como el Enter URL de Stitch; {src, upload} a un archivo de POST /uploads, que
 * se copia al workspace para que la página no dependa del transport. */
function imageEdit(deps: DirectEditDeps, v: unknown, files: Record<string, string>, dir: string, fail: Fail): DirectEdit {
  const edit = v as Record<string, unknown> | null;
  const ok = typeof edit === 'object' && edit !== null && typeof edit.src === 'string' && (typeof edit.url === 'string') !== (typeof edit.upload === 'string');
  if (!ok) throw new HttpError(400, 'replaceImage es {src, url} o {src, upload}');
  let newSrc = edit.url as string | undefined;
  let asset: DirectEdit['asset'];
  if (typeof edit.upload === 'string') {
    const hit = deps.uploads.resolve(edit.upload);
    if (!hit) throw new HttpError(400, 'replaceImage.upload debe ser una url de POST /uploads');
    const body = readFileSync(hit.file);
    const placed = uploadedImagePath(hit.name, hit.contentType, createHash('sha256').update(body).digest('hex'));
    if (!placed || !bytesMatchType(hit.contentType, body)) throw new HttpError(415, 'el archivo subido no es una imagen PNG, JPG, WebP o GIF');
    newSrc = placed.src;
    asset = { file: placed.file, body };
  }
  const found = replaceImage(deps.typescript ?? loadTypescript(dir), files, edit.src as string, newSrc!);
  if (!found.ok) return fail(found);
  return { name: 'replace-image', title: 'Replaced image', labels: ['Replacing image', 'Replaced image'], writes: { [found.path]: found.source }, deletes: [], summary: `${found.path} (${newSrc})`, ...(asset ? { asset } : {}) };
}

/** Con el cambio ya escrito: el primer error de tsc que el cambio agrega en los TSX que toca, o undefined. Un borrado
 * puede dejar un import o un tipo colgando, así que se compara contra los errores que esos archivos ya tenían, para no
 * rechazar todo cambio en una página que el agente dejó con uno. Termina con el cambio escrito solo si no rompe: el ws es
 * el que sirve el vite del preview y cada escritura llega por HMR, así que un cambio rechazado no se vuelve a escribir. */
export async function freshTscError(deps: Pick<DirectEditDeps, 'tsc'>, dir: string, base: string, written: readonly string[], reapply: () => void): Promise<TscError | undefined> {
  const touched = written.filter((p) => p.endsWith('.tsx'));
  const inFiles = (out: string) => parseTscOutput(out).filter((e) => touched.some((p) => e.file === p || e.file.endsWith(`/${p}`)));
  const tsc = deps.tsc ?? runTsc;
  const after = inFiles(await tsc(dir));
  if (!after.length) return undefined;
  // Al árbol del padre y no a HEAD: con la edición sobre una versión vieja, HEAD es otra rama y el rechazo dejaría su
  // árbol en el preview (mismo caso que #593).
  restoreTree(dir, base);
  // Por código y mensaje, no por cantidad: cambiar un error por otro distinto también es romper. Sin línea, porque un
  // borrado corre las de abajo.
  const left = (inFiles(await tsc(dir))).map((e) => `${e.code} ${e.message}`);
  const fresh = after.find((e) => { const i = left.indexOf(`${e.code} ${e.message}`); if (i < 0) return true; left.splice(i, 1); return false; });
  // HACK: aceptar con errores previos todavía pasa por nuevo, viejo, nuevo en el preview. Chequear el árbol base fuera del
  // ws (worktree o host de tsc en memoria) cuando QA vea ese parpadeo en una página real.
  if (!fresh) reapply();
  return fresh;
}

/** Aplica el parche sobre el árbol del commit padre, corre tsc y deja el ws limpio. Devuelve el error nuevo, si hay. */
export async function patchBreaks(deps: Pick<DirectEditDeps, 'tsc'>, dir: string, commit: string, c: Extract<Composed, { ok: true }>): Promise<TscError | undefined> {
  if (headSha(dir) === commit) discardChanges(dir);
  else restoreTree(dir, commit);
  for (const p of [...Object.keys(c.writes), ...c.deletes]) if (escapesWorkspace(dir, p)) throw new Error(`${p} es un enlace`);
  const apply = (): void => applyEdits(dir, c.writes, c.deletes);
  try {
    apply();
    return await freshTscError(deps, dir, commit, Object.keys(c.writes), apply);
  } finally {
    restoreTree(dir, commit);
  }
}
