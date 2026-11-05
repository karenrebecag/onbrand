// Variantes de un mensaje (POST /variants): la cola de las que esperan lugar bajo maxRunning, los grupos y el ciclo
// bifurcar -> planear -> correr -> cancelar. Es la capa que separa "qué variantes hay" de "cómo corre una corrida", que sigue
// en el transport. Modularización de transport.ts: movimiento mecánico, el transport le pasa lo que necesita por `deps`.

import { MAX_INSTRUCTION_CHARS, type ThinkingEffort } from './shared';
import { type CreativeRange, VARIANT_ASPECTS, type VariantAspect, variantsPrompt } from './variants-prompt';
import type { EventLog, FinishReason } from './events';
import { openEventLog } from './events';
import { forkRepo, showFile } from './git-workspace';
import { HttpError } from './http';
import { createInfer, type Infer } from './infer';
import { MAX_VARIANTS, planVariants } from './variants-plan';
import type { MessageEntry, RunInput } from './shared';
import type { PageModel } from './runner';

export interface VariantRunsDeps {
  logDir: string;
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  running: ReadonlySet<string>;
  cancels: ReadonlyMap<string, AbortController>;
  stopReasons: Map<string, string>;
  /** Plan de variantes inyectable (tests); sin él, haiku. */
  variantsPlan?: Infer;
  maxRunning: () => number;
  closing: () => boolean;
  wsDir: (ws: string) => string;
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  claim: (ws: string) => void;
  launch: (messageId: string, ws: string, input: RunInput) => void;
  end: (messageId: string, log: EventLog, finishReason: FinishReason) => void;
  settle: (messageId: string) => Promise<void>;
  titleOf: (prompt: string) => string;
  agent: boolean;
  finished: ReadonlySet<string>;
  entry: (id: string) => Readonly<MessageEntry>;
  background: (what: string, messageId: string, work: Promise<unknown>) => void;
  parseModel: (v: unknown) => string | undefined;
  parseImageGeneration: (v: unknown) => { modelId: string } | undefined;
  parseThinking: (v: unknown) => { effort: ThinkingEffort } | undefined;
  /** Nombre del archivo de la página en el árbol de la versión (`page.json`). */
  pageFile: string;
}

export class VariantRuns {
  /** Variantes listas para correr que esperan un lugar bajo maxRunning, en orden; y los ids de cada grupo. */
  private queue: { messageId: string; input: RunInput }[] = [];
  private groups = new Map<string, string[]>();

  constructor(private deps: VariantRunsDeps) {}

  /** El grupo sale del índice, en el orden de las variantes: el cancel por grupo sigue andando tras reiniciar (R3.3). */
  restoreGroup(groupId: string, id: string): void {
    this.groups.set(groupId, [...(this.groups.get(groupId) ?? []), id]);
  }

  sortGroups(): void {
    for (const [groupId, ids] of this.groups) this.groups.set(groupId, [...ids].sort((a, z) => (this.deps.index()[a].variantOf?.index ?? 0) - (this.deps.index()[z].variantOf?.index ?? 0)));
  }

  setGroup(groupId: string, ids: string[]): void {
    this.groups.set(groupId, ids);
  }

  enqueue(messageId: string, input: RunInput): void {
    this.queue.push({ messageId, input });
  }

  isQueued(messageId: string): boolean {
    return this.queue.some((q) => q.messageId === messageId);
  }

  /** Cierre del proceso: las variantes en cola no se cierran, su run.queued queda en el log y el próximo arranque las reanuda (R3.2). */
  clear(): void {
    this.queue = [];
  }

  /** Bifurca los workspaces, escribe el plan (un título y un prompt por variante) y encola las N. Una variante que no se
   * pudo bifurcar cierra en error y las demás siguen: la falla parcial no tiene extract (ZAP 26790 no falló ninguna) y lo
   * menos destructivo es no arrastrar al resto. */
  async prepareVariants(groupId: string, sourceId: string, ids: string[], basePrompt: string, base: Omit<RunInput, 'prompt'>): Promise<void> {
    const source = this.deps.index()[sourceId];
    const sourceDir = this.deps.wsDir(source.ws);
    const commit = source.commit as string;
    const forked = ids.filter((id) => {
      try {
        forkRepo(sourceDir, this.deps.wsDir(id), commit);
        return true;
      } catch (e) {
        this.failVariant(id, `no se pudo copiar la versión fuente: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    });
    if (!forked.length) return;
    let page: { title?: string; sections?: string[] } | undefined;
    try {
      const p = JSON.parse(showFile(sourceDir, commit, this.deps.pageFile)) as PageModel;
      page = { ...(typeof p.page?.title === 'string' ? { title: p.page.title } : {}), sections: (p.sections ?? []).map((s) => s.role) };
    } catch { /* sin page.json el plan sale solo del pedido */ }
    const infer = this.deps.variantsPlan ?? createInfer({ model: process.env.WT_VARIANTS_PLAN_MODEL ?? 'haiku' });
    const { plans } = await planVariants(infer, { basePrompt, count: ids.length, ...(page ? { page } : {}) });
    for (const id of forked) {
      const entry = this.deps.index()[id];
      const { index, count } = entry.variantOf as NonNullable<MessageEntry['variantOf']>;
      const plan = plans[index];
      this.deps.updateEntry(id, { title: this.deps.titleOf(plan.title), prompt: plan.prompt });
      const variant = { groupId, sourceId, index, count, title: plan.title, prompt: plan.prompt };
      this.queue.push({ messageId: id, input: { ...base, prompt: plan.prompt, variant } });
      openEventLog(this.deps.logDir, id).emit({ type: 'run.queued', variant });
    }
    this.pumpVariants();
  }

  /** Corre las variantes en cola mientras haya lugar bajo maxRunning (MAX_RUNNING: cada corrida instala y compila).
   * Stitch corre las N a la vez (ZAP 26790); aquí a lo sumo maxRunning, y las demás esperan pendientes. */
  pumpVariants(): void {
    if (this.deps.closing()) return;
    while (this.queue.length && this.deps.running.size < this.deps.maxRunning()) {
      const { messageId, input } = this.queue.shift() as { messageId: string; input: RunInput };
      const ws = this.deps.index()[messageId].ws;
      this.deps.claim(ws);
      openEventLog(this.deps.logDir, messageId).emit({ type: 'run.started' });
      this.deps.launch(messageId, ws, input);
    }
  }

  /** Cierra una variante que no llegó a correr (fork fallido o cancelada en la cola): el lienzo ve su fin igual. */
  failVariant(messageId: string, message?: string): void {
    const log = openEventLog(this.deps.logDir, messageId);
    const parentId = this.deps.index()[messageId].parentId;
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    if (message) log.emit({ type: 'error', message });
    this.deps.end(messageId, log, message ? 'error' : 'stopped');
    void this.deps.settle(messageId);
  }

  /** POST /variants/:groupId/cancel: corta las variantes del grupo que corren y saca de la cola las que esperan. */
  cancel(groupId: string): { groupId: string; cancelled: string[] } {
    const ids = this.groups.get(groupId);
    if (!ids) throw new HttpError(404, `no hay grupo de variantes ${groupId}`);
    const cancelled = ids.filter((id) => {
      if (this.cancelQueued(id)) return true;
      const run = this.deps.cancels.get(id);
      if (run) this.deps.stopReasons.set(id, `POST /variants/${groupId}/cancel`);
      run?.abort();
      return Boolean(run);
    });
    return { groupId, cancelled };
  }

  cancelQueued(id: string): boolean {
    const i = this.queue.findIndex((q) => q.messageId === id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.failVariant(id);
    return true;
  }

  /** POST /runs { variants: { sourceId, count, creativeRange?, aspects?, customInstructions? }, model?, imageGeneration?,
   * thinking? }: N variantes de una versión, como "Generate variants" de Stitch (S5). Una sola petición con la cantidad
   * como dato (DesignPage :34477-34490, ZAP 26790 posición 7 del input) y el prompt del grupo de Stitch (pM, 82194b2).
   * Cada variante es un chat propio con su workspace bifurcado de la fuente: N agentes sobre un mismo App.tsx y un mismo
   * vite chocarían. Responde los N ids de entrada para que el lienzo ponga los N marcos ya (ZAP 26790, snaps 3-4). */
  start(b: Record<string, unknown>): { groupId: string; sourceId: string; variants: { messageId: string; index: number }[] } {
    if (!this.deps.agent) throw new HttpError(400, 'las variantes necesitan el agente (--agent)');
    const v = (typeof b.variants === 'object' && b.variants !== null && !Array.isArray(b.variants) ? b.variants : {}) as Record<string, unknown>;
    if (typeof v.sourceId !== 'string') throw new HttpError(400, 'variants.sourceId es el mensaje de la versión fuente');
    const sourceId = v.sourceId;
    const source = this.deps.entry(sourceId);
    if (!source.commit) throw new HttpError(409, `el mensaje ${sourceId} no tiene versión`);
    const count = v.count;
    // 1 a 5, como el selector de Stitch (DesignPage :40080, min 1 max 5).
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_VARIANTS) throw new HttpError(400, `variants.count entre 1 y ${MAX_VARIANTS}`);
    const range = v.creativeRange ?? 'medium';
    if (range !== 'refine' && range !== 'medium' && range !== 'yolo') throw new HttpError(400, 'variants.creativeRange es refine|medium|yolo');
    const keys: string[] = VARIANT_ASPECTS.map((a) => a.key);
    if (v.aspects !== undefined && !(Array.isArray(v.aspects) && v.aspects.every((a) => typeof a === 'string' && keys.includes(a)))) throw new HttpError(400, `variants.aspects de ${keys.join('|')}`);
    if (v.customInstructions !== undefined && (typeof v.customInstructions !== 'string' || v.customInstructions.length > MAX_INSTRUCTION_CHARS)) throw new HttpError(400, `variants.customInstructions hasta ${MAX_INSTRUCTION_CHARS} caracteres`);
    const model = this.deps.parseModel(b.model);
    const imageGeneration = this.deps.parseImageGeneration(b.imageGeneration);
    const thinking = this.deps.parseThinking(b.thinking);
    const basePrompt = variantsPrompt({ variantCount: count, creativeRange: range as CreativeRange, aspects: (v.aspects ?? []) as VariantAspect[], customInstructions: (v.customInstructions ?? '') as string });
    const groupId = crypto.randomUUID().replaceAll('-', '');
    const ids = Array.from({ length: count }, () => crypto.randomUUID().replaceAll('-', ''));
    const mode = source.permissionMode ?? 'ask';
    ids.forEach((id, index) => {
      this.deps.updateEntry(id, { ws: id, parentId: sourceId, title: `Variante ${index + 1}`, prompt: basePrompt, ...(model ? { model } : {}), at: Date.now(), permissionMode: mode, variantOf: { groupId, index, count }, ...(imageGeneration || thinking ? { variantRun: { ...(imageGeneration ? { imageGeneration } : {}), ...(thinking ? { thinking } : {}) } } : {}) });
    });
    this.setGroup(groupId, ids);
    const base: Omit<RunInput, 'prompt'> = { attachments: [], ...(model ? { model } : {}), ...(imageGeneration ? { imageGeneration } : {}), ...(thinking ? { thinking } : {}) };
    this.deps.background('variants', groupId, this.prepareVariants(groupId, sourceId, ids, basePrompt, base).catch((e) => {
      for (const id of ids) if (!this.isQueued(id) && !this.deps.cancels.has(id) && !this.deps.finished.has(id)) this.failVariant(id, e instanceof Error ? e.message : String(e));
    }));
    return { groupId, sourceId, variants: ids.map((messageId, index) => ({ messageId, index })) };
  }
}
