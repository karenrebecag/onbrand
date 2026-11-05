// Corridas de marca sin turno de agente: aplicar la marca a una versión, aplicar el tema del panel, actualizar el DS y los
// hechos vivos de la marca que alimentan al compose. No saben de la cola ni del router; el transport les pasa por `deps`
// lo que comparten con el resto de corridas. Modularización de transport.ts: movimiento mecánico.

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrandPack, applyBrand, applyThemeToIdentity, brandAaTables, logoSrc, parseBrandPack, withThemeParams, writeBrandVariants } from '../brand';
import { packAaErrors } from '../brand-aa';
import { config } from '../config';
import { readBrandFacts } from '../brand-facts';
import { loadFacts, mergeFacts } from '../brand-facts-source';
import { brandItemSha, isBrandId, readBrandPackItem } from '../brand-registry';
import { type ExtensionPoints } from '../extension-points';
import { localizeFactImages } from '../facts-images';
import { DESIGN_FILE } from '../identity-design';
import { packDesignFrontmatter } from '../identity-ephemeral';
import { type EventLog, type FinishReason, openEventLog } from './events';
import { memoryFacts } from './memory-edit';
import { commitAll, headSha, listFiles, restoreTree, rewindTo, showFile } from './git-workspace';
import { HttpError } from './http';
import { openPinned } from './run-checks';
import { LOCAL_OWNER } from './session';
import { type RegistrySource } from './registry';
import { type Allowlist, type PageModel } from './runner';
import { step } from './step';
import { MESSAGE_ID, PAGE_FILE, PAGE_PATHS, REQUEST_FILE, sh, stepAsync, VERSION_BUILD, type ComposeRequest, type MessageEntry } from './shared';
import type { AssetRule, FactsSource } from '../brand-facts-source';
import type { FetchBytes } from '../facts-images';
import type { BrandStore } from './brand-store';

export interface BrandRunsDeps {
  /** Lo que estas corridas leen de RuntimeOptions, sin importar transport.ts (ADR 0014 regla 2). */
  opts: { agent?: boolean; build?: boolean; buildCommand?: readonly [string, ...string[]]; factsAssets?: readonly AssetRule[]; factsSources?: Record<string, FactsSource>; fetchFactImage?: FetchBytes; registry?: (pin?: string) => Promise<RegistrySource>; root: string };
  logDir: string;
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  running: ReadonlySet<string>;
  allowByPin: Map<string, Allowlist>;
  brands: BrandStore;
  maxRunning: () => number;
  wsDir: (ws: string) => string;
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  end: (messageId: string, log: EventLog, finishReason: FinishReason) => void;
  supersede: (ws: string) => void;
  pinOf: (dir: string, commit: string) => string | undefined;
  /** El skill del DS con que se construyó la versión (request.json dsSkill, o Arc si es anterior a B9 paso 4). */
  dsSkillOf: (dir: string, commit: string) => string | undefined;
  brandOf: (ws: string, commit: string) => string | undefined;
  agentWorkspace: (dir: string, log: EventLog, registry: RegistrySource | undefined, points?: ExtensionPoints, pack?: BrandPack, signal?: AbortSignal) => Promise<NonNullable<ComposeRequest['workspace']>>;
  entry: (id: string) => Readonly<MessageEntry>;
  claim: (ws: string) => void;
  background: (what: string, messageId: string, work: Promise<unknown>) => void;
  release: (messageId: string, ws: string) => void;
}

export class BrandRuns {
  constructor(private deps: BrandRunsDeps) {}

  /** Hechos vivos de la marca, encima de los de facts.json. Va después de aplicar la marca y antes del preflight de
   * imagen y del compose: la imagen, el prompt y direction.md leen los mismos. Sin fuente para esa marca, nada cambia. */
  async liveFacts(brand: NonNullable<ComposeRequest['brand']>, dir: string, log: EventLog, parentVersion: string | undefined): Promise<{ brand: NonNullable<ComposeRequest['brand']>; version?: string }> {
    const source = this.deps.opts.factsSources?.[brand.id];
    if (!source) return { brand };
    const live = await stepAsync(log, 'transport:facts', ['Leyendo datos de la marca', 'Leyó datos de la marca'], async () => {
      const loaded = await loadFacts(source, brand.id, { cacheDir: join(this.deps.opts.root, 'facts'), assets: this.deps.opts.factsAssets ?? [], ...(parentVersion ? { version: parentVersion } : {}) });
      const images = await localizeFactImages(loaded.facts, dir, this.deps.opts.fetchFactImage);
      const r = { ...loaded, facts: images.facts };
      const f = r.facts;
      const counts = [[f.clients, 'clientes'], [f.metrics, 'métricas'], [f.prices, 'planes'], [f.testimonials, 'reseñas']].map(([l, n]) => `${(l as unknown[] | undefined)?.length ?? 0} ${n}`).join(' · ');
      return { value: r, detail: { kind: 'action' as const, name: 'facts', summary: `${brand.id}@${r.version}${r.stale ? ' (la fuente no respondió: última versión guardada)' : r.cached ? ' (caché)' : ''} · ${counts}${r.overCap ? ` · ${r.overCap} fuera del tope` : ''}${r.skipped ? ` · ${r.skipped} inválidos` : ''}${images.written.length ? ` · ${images.written.length} imágenes` : ''}${images.dropped ? ` · ${images.dropped} imágenes sin bajar` : ''}${r.trackingIssue ? ` · sin tracking: ${r.trackingIssue}` : ''}`, ...(r.stale ? { notes: [`La fuente de datos de la marca no respondió: la página usa la última versión guardada (${r.version}), que puede no ser la vigente.`] } : {}) } };
    });
    return { brand: { ...brand, facts: mergeFacts(brand.facts, live.facts) }, version: live.version };
  }

  /** El dueño del chat de este mensaje: la marca que lee la corrida es la de quien abrió el chat, no la de quien la pidió. */
  private ownerOf(messageId: string): string {
    return this.deps.index()[messageId]?.owner ?? LOCAL_OWNER;
  }

  /** Aplica la marca de la página al workspace: el pack del mismo pin que los componentes, o sin registry el
   * local de brandsRoot. Una marca pedida que no se encuentra rompe la corrida en vez de salir sin marca. */
  async applyPageBrand(id: string, owner: string, dir: string, log: EventLog, registry: RegistrySource | undefined, points: ExtensionPoints | undefined, detected = false, followUp = false): Promise<{ brand: NonNullable<ComposeRequest['brand']>; pack: BrandPack }> {
    // El pack se valida contra las ranuras del mismo pin que los componentes; sin ellas un pack con components falla.
    const opts = { ...(points ? { extensionPoints: points } : {}), ...(registry ? { pin: registry.pin } : {}) };
    return stepAsync(log, 'transport:brand', ['Applying brand', 'Applied brand'], async () => {
      const packDir = registry?.brandPack ? await registry.brandPack(id) : this.deps.brands.localDir(id);
      const brand = applyBrand(dir, packDir, { ...opts, keepIdentity: followUp });
      const src = logoSrc(brand);
      const facts = readBrandFacts(packDir);
      const styleSet = brand.composition?.styleSet;
      // Hash del pack para la traza del turno: el mismo que publica build-registry.
      const hash = brandItemSha(readBrandPackItem(id, packDir, opts));
      const instructions = this.deps.brands.instructions(owner, id);
      // Memoria de la marca (M2): los hechos que el agente guardó con `remember` entran al prompt del siguiente turno.
      const memory = memoryFacts(this.deps.brands.memory(owner, id));
      return { value: { pack: brand, brand: { id, name: brand.name, ...(src ? { logoSrc: src } : {}), ...(facts ? { facts } : {}), ...(styleSet ? { styleSet } : {}), hash, ...(instructions.length ? { instructions } : {}), ...(memory.length ? { memory } : {}) } }, detail: { kind: 'action' as const, name: 'brand', summary: `${id}${registry ? `@${registry.pin}` : ''}${detected ? ' (detectada en el brief)' : ''}${facts ? ', con hechos' : ''}` } };
    });
  }

  async runUpdateDs(messageId: string, parentCommit: string, registry: RegistrySource): Promise<void> {
    const { ws, parentId, title } = this.deps.index()[messageId];
    const dir = this.deps.wsDir(ws);
    this.deps.supersede(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    // El montaje del DS commitea por su cuenta (base: ds@pin): si algo falla después, la rama vuelve a donde estaba.
    const before = headSha(dir);
    try {
      if (before !== parentCommit) {
        step(log, 'transport:restore', 'action', ['Restoring version', 'Restored version'], () => {
          restoreTree(dir, parentCommit);
          return { value: undefined, detail: { kind: 'action', name: 'restore', summary: parentCommit } };
        });
      }
      if (registry.loadIndex && !this.deps.allowByPin.has(registry.pin)) this.deps.allowByPin.set(registry.pin, await registry.loadIndex());
      const parentPage = JSON.parse(showFile(dir, parentCommit, PAGE_FILE)) as PageModel;
      const brandId = typeof parentPage.page?.brand === 'string' ? parentPage.page.brand : undefined;
      const points = registry.extensionPoints ? await registry.extensionPoints() : undefined;
      const applied = brandId ? await this.applyPageBrand(brandId, this.ownerOf(messageId), dir, log, registry, points, false, true) : undefined;
      // HACK: los archivos que el pin nuevo ya no publica quedan en el árbol (el marcador ds@<pin> viejo los lista). Limpiarlos
      // cuando un DS retire componentes y haya un chat que los importe.
      await this.deps.agentWorkspace(dir, log, registry, points, applied?.pack);
      const requestPath = join(dir, REQUEST_FILE);
      const prev = existsSync(requestPath) ? (JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>) : {};
      writeFileSync(requestPath, JSON.stringify({ ...prev, registryPin: registry.pin, dsSkill: config().agentSkillId }, null, 2));
      // Un DS nuevo que rompe la página se ve ahora y no cuando la persona la abra: si el build falla, el pin queda en el anterior.
      if (this.deps.opts.build !== false) {
        const [cmd, ...args] = this.deps.opts.buildCommand ?? VERSION_BUILD;
        await sh(log, 'transport:build', ['Building', 'Built'], cmd, args, dir);
      }
      const commit = commitAll(dir, title as string);
      this.deps.updateEntry(messageId, { commit });
      this.deps.end(messageId, log, 'restore');
      log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    } catch (e) {
      // Un montaje a medias no deja el árbol sucio ni un commit "base: ds@nuevo" que lastBaseCommit tomaría como base de la
      // siguiente versión; los marcadores se borran para que un reintento vuelva a montar en vez de saltarse el DS.
      // Con commit ya registrado la versión existe: un fallo posterior (snapshot, end) no debe tirarla con el rewind.
      if (!this.deps.index()[messageId].commit) {
        try {
          rewindTo(dir, before);
          for (const m of [`ds@${registry.pin}`, `skill@${registry.pin}`]) rmSync(join(dir, '.wt', m), { force: true });
        } catch { /* el error que importa es el de abajo */ }
      }
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.deps.end(messageId, log, 'error');
    }
  }

  async runApplyBrand(messageId: string, parentCommit: string, brandId: string): Promise<void> {
    const { ws, parentId, title } = this.deps.index()[messageId];
    const dir = this.deps.wsDir(ws);
    this.deps.supersede(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    const before = headSha(dir);
    try {
      if (before !== parentCommit) {
        step(log, 'transport:restore', 'action', ['Restoring version', 'Restored version'], () => {
          restoreTree(dir, parentCommit);
          return { value: undefined, detail: { kind: 'action', name: 'restore', summary: parentCommit } };
        });
      }
      // El pin de la versión, no el último: aplicar la marca no es actualizar el DS.
      const pin = this.deps.pinOf(dir, parentCommit);
      const registry = this.deps.opts.registry ? await openPinned(this.deps.opts.registry, pin, this.deps.dsSkillOf(dir, parentCommit)) : undefined;
      const points = registry?.extensionPoints ? await registry.extensionPoints() : undefined;
      const applied = await this.applyPageBrand(brandId, this.ownerOf(messageId), dir, log, registry, points, false, false);
      if (points) writeBrandVariants(dir, points, applied.pack);
      const page = JSON.parse(readFileSync(join(dir, PAGE_FILE), 'utf8')) as PageModel;
      writeFileSync(join(dir, PAGE_FILE), JSON.stringify({ ...page, page: { ...(page.page ?? {}), brand: brandId } }, null, 2));
      if (this.deps.opts.build !== false) {
        const [cmd, ...args] = this.deps.opts.buildCommand ?? VERSION_BUILD;
        await sh(log, 'transport:build', ['Building', 'Built'], cmd, args, dir);
      }
      const commit = commitAll(dir, title as string);
      this.deps.updateEntry(messageId, { commit });
      this.deps.end(messageId, log, 'restore');
      log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    } catch (e) {
      // Sin commit la versión no existe: el árbol vuelve al padre para que la marca a medias no la herede el siguiente turno.
      if (!this.deps.index()[messageId].commit) {
        try { rewindTo(dir, before); } catch { /* el error que importa es el de abajo */ }
      }
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.deps.end(messageId, log, 'error');
    }
  }

  /** POST /runs {parentId, applyTheme: {theme, overrides?, overridesDark?}}: el "Aplicar" del panel Tema
   * (specs/panel-tema-params.md:54). Corrida sin modelo como applyBrand: la marca de la versión con el tema del panel,
   * por applyBrand para que valga el mismo gate AA, y versión nueva para que historia y restore salgan gratis. */
  startApplyTheme(b: Record<string, unknown>): { messageId: string } {
    if (b.parentId === undefined) throw new HttpError(400, 'applyTheme necesita parentId');
    // Antes de registrar el mensaje, como patch: un tema inválido o ilegible da 422 y no crea versión. El pack real se
    // vuelve a medir al aplicar, con sus overrides de siempre.
    try {
      const pack = parseBrandPack(withThemeParams({ name: 'Tema' }, b.applyTheme), { skipComponents: true });
      const { tables, touched } = brandAaTables(pack);
      const aa = packAaErrors(tables, touched);
      if (aa.length) throw new Error(`contraste insuficiente\n${aa.map((e) => `- ${e}`).join('\n')}`);
    } catch (e) {
      throw new HttpError(422, e instanceof Error ? e.message : String(e));
    }
    const parentId = String(b.parentId);
    const parent = this.deps.entry(parentId);
    if (!parent.commit) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws, commit } = parent;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning()) throw new HttpError(429, `ya hay ${this.deps.maxRunning()} corridas en curso`);
    const params = b.applyTheme as Record<string, unknown>;
    this.deps.updateEntry(messageId, { ws, parentId, title: 'Aplicar tema', at: Date.now(), appliedTheme: params });
    this.deps.claim(ws);
    this.deps.background('apply-theme', messageId, this.runApplyTheme(messageId, commit, params).finally(() => this.deps.release(messageId, ws)));
    return { messageId };
  }

  private async runApplyTheme(messageId: string, parentCommit: string, params: Record<string, unknown>): Promise<void> {
    const { ws, parentId, title } = this.deps.index()[messageId];
    const dir = this.deps.wsDir(ws);
    this.deps.supersede(ws);
    const log = openEventLog(this.deps.logDir, messageId);
    log.emit({ type: 'message.start', ...(parentId ? { parentId } : {}) });
    const before = headSha(dir);
    const pack = mkdtempSync(join(tmpdir(), 'wt-theme-'));
    try {
      if (before !== parentCommit) {
        step(log, 'transport:restore', 'action', ['Restoring version', 'Restored version'], () => {
          restoreTree(dir, parentCommit);
          return { value: undefined, detail: { kind: 'action', name: 'restore', summary: parentCommit } };
        });
      }
      const pin = this.deps.pinOf(dir, parentCommit);
      const registry = this.deps.opts.registry ? await openPinned(this.deps.opts.registry, pin, this.deps.dsSkillOf(dir, parentCommit)) : undefined;
      const points = registry?.extensionPoints ? await registry.extensionPoints() : undefined;
      const opts = { ...(points ? { extensionPoints: points } : {}), ...(registry ? { pin: registry.pin } : {}) };
      const brandId = this.deps.brandOf(ws, parentCommit);
      await stepAsync(log, 'transport:theme', ['Applying theme', 'Applied theme'], async () => {
        // Sin pack la identidad es la del agente: el tema va encima de ella, no a una marca vacía (QA vivo D1).
        if (!brandId) {
          const written = applyThemeToIdentity(dir, params);
          return { value: undefined, detail: { kind: 'action' as const, name: 'theme', summary: `sin marca: ${written.length ? written.join(', ') : 'sin cambios'}` } };
        }
        // Copia del pack de la versión (logo, fuentes, DESIGN.md, components): el panel cambia el tema, no la marca.
        if (brandId) cpSync(registry?.brandPack ? await registry.brandPack(brandId) : this.deps.brands.localDir(brandId), pack, { recursive: true });
        const raw = brandId ? JSON.parse(readFileSync(join(pack, 'brand.json'), 'utf8')) as Record<string, unknown> : { name: 'Tema' };
        const next = withThemeParams(raw, params);
        writeFileSync(join(pack, 'brand.json'), JSON.stringify(next, null, 2));
        // El frontmatter de DESIGN.md copia los valores de brand.json y se valida contra ellos: con el tema nuevo, el
        // del pack ya no coincide. Se reescribe desde el tema; la prosa de la marca queda.
        const design = join(pack, DESIGN_FILE);
        if (existsSync(design)) writeFileSync(design, packDesignFrontmatter(parseBrandPack(next, { skipComponents: true })) + readFileSync(design, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, ''));
        const applied = applyBrand(dir, pack, opts);
        if (points) writeBrandVariants(dir, points, applied);
        return { value: undefined, detail: { kind: 'action' as const, name: 'theme', summary: brandId ?? 'sin marca' } };
      });
      if (this.deps.opts.build !== false) {
        const [cmd, ...args] = this.deps.opts.buildCommand ?? VERSION_BUILD;
        await sh(log, 'transport:build', ['Building', 'Built'], cmd, args, dir);
      }
      const commit = commitAll(dir, title as string);
      this.deps.updateEntry(messageId, { commit });
      this.deps.end(messageId, log, 'restore');
      log.emit({ type: 'snapshot', dir, files: listFiles(dir, commit, PAGE_PATHS), commit });
    } catch (e) {
      if (!this.deps.index()[messageId].commit) {
        try { rewindTo(dir, before); } catch { /* el error que importa es el de abajo */ }
      }
      log.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.deps.end(messageId, log, 'error');
    } finally {
      rmSync(pack, { recursive: true, force: true });
    }
  }

  /** POST /runs {updateDs: true, parentId}: el chat conserva su pin (reproducibilidad) y esta acción explícita lo mueve al
   * `latest` en una corrida tipo restore, sin modelo (Stitch actualiza el DS con un follow-up global; síntesis
   * re-contexto §2.3). El DS nuevo va en su commit base y la versión queda con el pin nuevo en request.json, que es de
   * donde lo heredan los follow-ups. */
  async startUpdateDs(b: Record<string, unknown>): Promise<{ messageId: string; from?: string; to: string }> {
    if (b.updateDs !== true) throw new HttpError(400, 'updateDs debe ser true');
    if (b.parentId === undefined) throw new HttpError(400, 'updateDs necesita parentId');
    const open = this.deps.opts.registry;
    if (!open || !this.deps.opts.agent) throw new HttpError(400, 'actualizar el DS necesita registry y --agent');
    const parentId = String(b.parentId);
    const parent = this.deps.entry(parentId);
    if (!parent.commit) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws } = parent;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning()) throw new HttpError(429, `ya hay ${this.deps.maxRunning()} corridas en curso`);
    const from = this.deps.pinOf(this.deps.wsDir(ws), parent.commit);
    // El latest es el del DS del perfil: si el chat es de otro DS (un chat de Arc tras pasar el core al base), actualizar
    // pisaría su layout y dejaría secciones importando componentes que el pin nuevo no trae. Ese cambio no es un update.
    const fromSkill = this.deps.dsSkillOf(this.deps.wsDir(ws), parent.commit);
    const skill = config().agentSkillId;
    if (fromSkill && fromSkill !== skill) throw new HttpError(409, `el DS de este chat es ${fromSkill} y el registry publica ${skill}: Actualizar DS no cambia de DS`);
    let registry: RegistrySource;
    try {
      registry = await open(undefined);
    } catch (e) {
      throw new HttpError(502, `registry no disponible: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (registry.pin === from) throw new HttpError(409, `el DS ya está en ${from}`);
    // Otra petición pudo tomar el workspace, el id o el último cupo mientras se abría el registry.
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning()) throw new HttpError(429, `ya hay ${this.deps.maxRunning()} corridas en curso`);
    this.deps.updateEntry(messageId, { ws, parentId, title: `Actualizar DS a ${registry.pin.slice(0, 8)}`, at: Date.now(), updatedDs: { ...(from ? { from } : {}), to: registry.pin } });
    this.deps.claim(ws);
    this.deps.background('update-ds', messageId, this.runUpdateDs(messageId, parent.commit, registry).finally(() => this.deps.release(messageId, ws)));
    return { messageId, ...(from ? { from } : {}), to: registry.pin };
  }

  /** POST /runs {parentId, applyBrand: <id>}: la versión pasa a la marca <id> sin turno de agente. Las secciones consumen
   * var(--token), así que reescribir la identidad (identity.css, DESIGN.md, data-accent, logo, src/brand.ts) tiñe toda la
   * página; Stitch lo hace con una sesión de LLM por pantalla (APPLY_DESIGN_SYSTEM). Mismo ciclo que updateDs: construye
   * antes de commitear y vuelve al padre si algo falla. */
  async startApplyBrand(b: Record<string, unknown>): Promise<{ messageId: string; from?: string; to: string }> {
    if (!isBrandId(b.applyBrand)) throw new HttpError(400, 'applyBrand debe ser un id de marca en kebab-case');
    if (b.parentId === undefined) throw new HttpError(400, 'applyBrand necesita parentId');
    const to = b.applyBrand;
    const parentId = String(b.parentId);
    const parent = this.deps.entry(parentId);
    if (!parent.commit) throw new HttpError(409, `el mensaje padre ${parentId} no tiene versión`);
    const messageId = b.messageId === undefined ? crypto.randomUUID().replaceAll('-', '') : String(b.messageId);
    if (!MESSAGE_ID.test(messageId)) throw new HttpError(400, `messageId inválido "${messageId}"`);
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    const { ws, commit } = parent;
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning()) throw new HttpError(429, `ya hay ${this.deps.maxRunning()} corridas en curso`);
    const from = this.deps.brandOf(ws, commit);
    if (from === to) throw new HttpError(409, `la versión ya es de la marca "${to}"`);
    if (!(await this.deps.brands.ids()).includes(to)) throw new HttpError(404, `la marca "${to}" no existe`);
    // Otra petición pudo tomar el workspace, el id o el último cupo mientras se leían las marcas.
    if (Object.hasOwn(this.deps.index(), messageId)) throw new HttpError(409, `el mensaje ${messageId} ya existe`);
    if (this.deps.running.has(ws)) throw new HttpError(409, 'el workspace ya tiene una corrida en curso');
    if (this.deps.running.size >= this.deps.maxRunning()) throw new HttpError(429, `ya hay ${this.deps.maxRunning()} corridas en curso`);
    this.deps.updateEntry(messageId, { ws, parentId, title: `Aplicar marca ${to}`, at: Date.now(), appliedBrand: { ...(from ? { from } : {}), to } });
    this.deps.claim(ws);
    this.deps.background('apply-brand', messageId, this.runApplyBrand(messageId, commit, to).finally(() => this.deps.release(messageId, ws)));
    return { messageId, ...(from ? { from } : {}), to };
  }
}
