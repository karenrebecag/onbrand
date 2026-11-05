// Corridas sin agente y de reparación, fuera de transport.ts (partición de transport.ts): patch, edición directa,
// Editar con IA por la vía de parche, restore, continuar y los arreglos de render y runtime. Mismo patrón que
// api-handlers.ts y brand-store.ts: lo que necesitan del transport entra por `deps`, nunca por un import del Runtime.

import { openEventLog, readEvents, type EngineEvent, type EventLog, type FinishReason, type Outcome } from './events';
import type { RequestKey } from './run-checks';
import { commitAll, discardChanges, headSha, listFiles, restoreTree, showFile } from './git-workspace';
import { createInfer, type Infer } from './infer';
import { type Allowlist, type Resolve } from './runner';
import { step } from './step';
import { composeEdits, planPatch, snippets, type PatchElement } from './patch-ai';
import { PLAN_PATH } from './section-ops';
import { hasRuntimeErrors, parseRuntimeErrors, previewCheckOf, runtimeRepairPrompt } from './runtime-repair';
import { HttpError } from './http';
import { INTERRUPTED_PROMPT } from './agent-loop';
import { applyEdits, directEdit, escapesWorkspace, freshTscError, loadTypescript, patchBreaks, writeAsset, type DirectEdit, type DirectEditDeps } from './direct-edit';
import { MESSAGE_ID, PAGE_FILE, PAGE_PATHS, planOnly, stepAsync, type MessageEntry, type RunInput } from './shared';

/** Lo que estas corridas usan del transport (ADR 0014): leen el índice con `index()` y lo escriben con `updateEntry`, que
 * también lo guarda; el resto son callbacks del ciclo de corrida, que sigue en Runtime. */
export interface EditRunsDeps {
  /** Las opciones del transport que tocan estas corridas: allowlist, schemas del patch, compilador y tsc inyectables. */
  readonly opts: Resolve & Pick<DirectEditDeps, 'tsc' | 'typescript'> & { allow: Allowlist; patchPlan?: Infer };
  readonly logDir: string;
  readonly running: ReadonlySet<string>;
  readonly maxRunning: number;
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  wsDir: (ws: string) => string;
  entry: (id: string) => Readonly<MessageEntry>;
  claim: (ws: string) => void;
  release: (messageId: string, ws: string) => void;
  supersede: (ws: string) => void;
  settle: (messageId: string) => Promise<void>;
  launch: (messageId: string, ws: string, input: RunInput) => void;
  end: (messageId: string, log: EventLog, finishReason: FinishReason, o?: { outcome?: Outcome; interrupted?: true; continuable?: boolean; usage?: Extract<EngineEvent, { type: 'message.end' }>['usage'] }) => void;
  background: (what: string, messageId: string, work: Promise<unknown>) => void;
  parseModel: (v: unknown) => string | undefined;
  parseThinking: (v: unknown) => RunInput['thinking'];
  assertAutoRepairable: (parent: Readonly<MessageEntry>) => void;
  requestField: (dir: string, commit: string, key: RequestKey) => string | undefined;
  pinOf: (dir: string, commit: string) => string | undefined;
  allowAt: (pin: string) => Promise<Allowlist>;
  directEditDeps: () => DirectEditDeps;
}

export class EditRuns {
  constructor(private deps: EditRunsDeps) {}

  /** POST /runs { parentId, continue: true, messageId?, model?, thinking? }: sigue una corrida que quedó a medias (ADR 0013
   * D2 opción A). Es un follow-up sobre la versión detenida que reanuda la sesión del CLI que la escribió, con el aviso de
   * corte del propio loop (agent-loop.ts INTERRUPTED_PROMPT). Una continuación por corrida: un segundo clic es 409. */
  startContinue(b: Record<string, unknown>): { messageId: string } {
    if (typeof b.parentId !== 'string') throw new HttpError(400, 'continuar necesita parentId (la corrida interrumpida)');
    const parentId = b.parentId;
    const parent = this.deps.entry(parentId);
    if (!parent.continuable || !parent.sessionId || !parent.commit) throw new HttpError(409, `el mensaje ${parentId} no se puede continuar`);
    if (parent.continued) throw new HttpError(409, `el mensaje ${parentId} ya se continuó en ${parent.continued}`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws } = parent;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning) throw new HttpError(429, `ya hay ${this.deps.maxRunning} corridas en curso`);
    // Sin modelo en el pedido sigue el del turno interrumpido: --resume retoma su sesión del CLI, y parseModel(undefined)
    // devolvería el default del server (revisión de Arq sobre #748).
    const model = b.model === undefined && parent.model ? parent.model : this.deps.parseModel(b.model);
    // Sin thinking en el pedido sigue el del turno interrumpido: el reinicio no debe bajar el effort (QA fila 1).
    const thinking = this.deps.parseThinking(b.thinking) ?? parent.thinking;
    // Primero el hijo y después `continued`: cada updateEntry guarda, y un corte entre ambos dejaría al padre apuntando a
    // un mensaje que no existe (409 al reintentar, `continuable` en false).
    this.deps.updateEntry(messageId, { ws, parentId, title: 'Continuar', at: Date.now(), continueOf: parentId, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(parent.permissionMode ? { permissionMode: parent.permissionMode } : {}) });
    this.deps.updateEntry(parentId, { continued: messageId });
    this.deps.claim(ws);
    this.deps.launch(messageId, ws, { prompt: INTERRUPTED_PROMPT, attachments: [], resume: parent.sessionId, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
    return { messageId };
  }

  /** POST /runs { repair: 'runtime', parentId, model?, runtimeErrors?, auto? } sin prompt: el pedido de arreglo sale del
   * transport:preview-check de esa versión (los errores no viajan desde el navegador); `runtimeErrors` del preview vivo
   * entra como dato no confiable, validado y delimitado. Sin revisión de preview (o caída), 400. */
  startRuntimeRepair(b: Record<string, unknown>): { messageId: string } {
    if (typeof b.parentId !== 'string') throw new HttpError(400, 'repair runtime necesita parentId (la versión actual)');
    const model = this.deps.parseModel(b.model);
    const parentId = b.parentId;
    const parent = this.deps.entry(parentId);
    if (!parent.commit) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    const auto = b.auto === true;
    if (auto) this.deps.assertAutoRepairable(parent);
    const check = previewCheckOf(readEvents(this.deps.logDir, parentId).events);
    if (!check) throw new HttpError(400, 'la versión no tiene revisión de preview (transport:preview-check) o la revisión falló');
    let reports: ReturnType<typeof parseRuntimeErrors>;
    try { reports = parseRuntimeErrors(b.runtimeErrors); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    if (!hasRuntimeErrors(check, reports)) throw new HttpError(400, 'la versión no tiene errores de runtime que arreglar');
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const ws = parent.ws;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning) throw new HttpError(429, `ya hay ${this.deps.maxRunning} corridas en curso`);
    this.deps.updateEntry(messageId, { ws, parentId, title: 'Arreglar errores de runtime', at: Date.now(), runtimeRepair: true, ...(auto ? { autoRepair: 'runtime' as const } : {}) });
    if (auto) this.deps.updateEntry(parentId, { autoRepaired: messageId });
    this.deps.claim(ws);
    this.deps.launch(messageId, ws, { prompt: runtimeRepairPrompt(check, reports), attachments: [], runtimeRepair: true, ...(model ? { model } : {}) });
    return { messageId };
  }

  /** POST /runs {restoreFrom}: como el restore de v0, un mensaje nuevo cuyo commit trae los archivos de
   * esa versión, colgado de la cabeza actual. Sin modelo ni build: la historia solo avanza. */
  startRestore(b: Record<string, unknown>): { messageId: string } {
    const target = this.deps.entry(String(b.restoreFrom));
    if (!target.commit) throw new HttpError(409, `el mensaje ${String(b.restoreFrom)} no tiene versión`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws } = target;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    const dir = this.deps.wsDir(ws);
    const head = headSha(dir);
    const index = this.deps.index();
    const parentId = Object.keys(index).find((id) => index[id].ws === ws && index[id].commit === head && index[id].asked === undefined && !planOnly(index[id], index[id].parentId ? index[index[id].parentId as string]?.commit : undefined));
    const restoreFrom = String(b.restoreFrom);
    // kind antes de restoreTree: si el proceso cae entre restoreTree y commitAll, recover descarta el árbol a medias (R2.4).
    this.deps.updateEntry(messageId, { ws, ...(parentId ? { parentId } : {}), restoreFrom, title: `Restored ${target.title ?? restoreFrom}`, at: Date.now(), kind: 'restore' });
    this.deps.supersede(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    try {
      step(log, 'transport:restore', 'action', ['Restoring version', 'Restored version'], () => {
        restoreTree(dir, target.commit as string);
        return { value: undefined, detail: { kind: 'action', name: 'restore', summary: restoreFrom } };
      });
      const commit = commitAll(dir, this.deps.index()[messageId].title as string);
      this.deps.updateEntry(messageId, { commit });
      this.deps.end(messageId, log, 'restore');
      log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    } catch (e) {
      // Un restore que falla no deja el árbol de otra versión sin commit: el siguiente turno lo vería como suyo.
      try { discardChanges(dir); } catch { /* el error que importa es el de abajo */ }
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.deps.end(messageId, log, 'error');
    }
    void this.deps.settle(messageId);
    return { messageId };
  }

  /** POST /runs {parentId, textEdit | deleteElement}: la edición directa de Stitch (Edit Text y Delete) sobre el código
   * de la página, sin modelo. El elemento se busca antes de registrar el mensaje: si no está o está repetido, 409 y el
   * builder ofrece Editar con IA. Deshacer es restaurar la versión anterior: el undo de Delete de Stitch no se guarda
   * (dinamico-rail.md, Direct Edit). */
  startDirectEdit(b: Record<string, unknown>): { messageId: string } {
    if (b.parentId === undefined) throw new HttpError(400, 'la edición directa necesita parentId');
    const parentId = String(b.parentId);
    const parent = this.deps.entry(parentId);
    if (!parent.commit) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws } = parent;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning) throw new HttpError(429, `ya hay ${this.deps.maxRunning} corridas en curso`);
    const dir = this.deps.wsDir(ws);
    const commit = parent.commit;
    // La sección también reescribe su CSS module y el plan; las otras dos ediciones solo miran TSX.
    const keep = b.sectionOp !== undefined ? (p: string) => /\.(tsx|css|md)$/.test(p) : (p: string) => p.endsWith('.tsx');
    const files = Object.fromEntries(listFiles(dir, commit, [...PAGE_PATHS, PLAN_PATH]).filter(keep).map((p) => [p, showFile(dir, commit, p)]));
    const edit = directEdit(this.deps.directEditDeps(), b, files, dir);
    this.deps.updateEntry(messageId, { ws, parentId, title: edit.title, at: Date.now(), kind: 'direct-edit' });
    this.deps.claim(ws);
    // runPatch/runDirectEdit atrapan su propio error, pero ese catch emite al log y puede volver a lanzar (auditoría #3).
    this.deps.background('direct-edit', messageId, this.runDirectEdit(messageId, commit, edit).finally(() => this.deps.release(messageId, ws)));
    return { messageId };
  }

  /** Editar con IA por la vía de parche (H5): infer → ops → aplicadores AST → tsc en seco, todo antes de abrir el log del
   * mensaje. Si algo no encaja el mismo mensaje sigue como turno completo, sin un message.start de más. */
  async runPatchAi(messageId: string, ws: string, commit: string, input: RunInput, elements: PatchElement[]): Promise<void> {
    const dir = this.deps.wsDir(ws);
    let edit: DirectEdit;
    try {
      const files = Object.fromEntries(listFiles(dir, commit, [...PAGE_PATHS, PLAN_PATH]).filter((p) => /\.(tsx|css|md)$/.test(p)).map((p) => [p, showFile(dir, commit, p)]));
      const infer = this.deps.opts.patchPlan ?? createInfer({ model: process.env.WT_PATCH_MODEL ?? 'haiku' });
      const plan = await planPatch(infer, { prompt: input.prompt, elements, snippets: snippets(files, elements) });
      if (plan.route === 'full') return this.patchFallback(messageId, ws, input, plan.reason);
      const composed = composeEdits(this.deps.opts.typescript ?? loadTypescript(dir), files, plan.ops);
      if (!composed.ok) return this.patchFallback(messageId, ws, input, composed.reason);
      const broken = await patchBreaks(this.deps.opts, dir, commit, composed);
      if (broken) return this.patchFallback(messageId, ws, input, `tsc: ${broken.file} ${broken.message}`.slice(0, 200));
      const title = this.deps.index()[messageId]?.title ?? 'Edited with AI';
      // tsc ya pasó en seco sobre el mismo árbol: runDirectEdit solo escribe y commitea.
      edit = { name: 'patch-ai', title, labels: ['Editing with AI', 'Edited with AI'], writes: composed.writes, deletes: composed.deletes, summary: composed.summary, notes: composed.notes, followUps: composed.followUps, skipTypecheck: true };
      this.deps.updateEntry(messageId, { patchAi: { route: 'patch' } });
    } catch (e) {
      return this.patchFallback(messageId, ws, input, (e instanceof Error ? e.message : String(e)).slice(0, 200));
    }
    try {
      await this.runDirectEdit(messageId, commit, edit);
    } finally {
      this.deps.release(messageId, ws);
    }
  }

  /** El parche no aplica: el mismo mensaje sigue como turno del agente, con el pedido tal cual llegó. Deja de ser una
   * corrida sin agente (kind), así recover no la descarta como edición a medias. */
  private patchFallback(messageId: string, ws: string, input: RunInput, reason: string): void {
    this.deps.updateEntry(messageId, { ...(this.deps.index()[messageId] ? {} : { ws, at: Date.now() }), kind: undefined, patchAi: { route: 'full', reason } });
    this.deps.launch(messageId, ws, input);
  }

  private async runDirectEdit(messageId: string, parentCommit: string, edit: DirectEdit): Promise<void> {
    const { ws, parentId } = this.deps.index()[messageId];
    const dir = this.deps.wsDir(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    try {
      if (headSha(dir) === parentCommit) discardChanges(dir);
      else restoreTree(dir, parentCommit);
      await stepAsync(log, `transport:${edit.name}`, edit.labels, async () => {
        const paths = [...Object.keys(edit.writes), ...edit.deletes];
        for (const p of paths) if (escapesWorkspace(dir, p)) throw new Error(`${p} es un enlace: usa Editar con IA`);
        const apply = (): void => applyEdits(dir, edit.writes, edit.deletes);
        // discardChanges también limpia la imagen copiada: cada vuelta al cambio la trae de nuevo.
        const reapply = (): void => { if (edit.asset) writeAsset(dir, edit.asset); apply(); };
        reapply();
        const detail = { kind: 'action' as const, name: edit.name, summary: edit.summary, ...(edit.notes?.length ? { notes: edit.notes } : {}), ...(edit.followUps?.length ? { followUps: edit.followUps } : {}) };
        if (edit.skipTypecheck) return { value: undefined, detail };
        const fresh = await freshTscError(this.deps.opts, dir, parentCommit, Object.keys(edit.writes), reapply);
        if (fresh) throw new Error(`el cambio rompe ${fresh.file} (${fresh.message}): usa Editar con IA`);
        return { value: undefined, detail };
      });
      const commit = commitAll(dir, this.deps.index()[messageId].title as string);
      this.deps.updateEntry(messageId, { commit });
      this.deps.end(messageId, log, 'patch');
      log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    } catch (e) {
      // Sin esto un fallo después de escribir (tsc ausente, commit) deja el archivo sucio hasta la próxima corrida. Al
      // padre y no a HEAD: con la edición sobre una versión vieja, HEAD es otra rama.
      try { restoreTree(dir, parentCommit); } catch { /* el error que importa es el de abajo */ }
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.deps.end(messageId, log, 'error');
    }
  }
}
