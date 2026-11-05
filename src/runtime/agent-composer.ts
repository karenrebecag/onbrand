// Composer del ADR 0011: un solo agente con herramientas escribe la página en el workspace (src/sections/*.tsx,
// App.tsx, index.html) sobre el skill del DS, como v0. Detrás de `--agent`/WT_COMPOSE_AGENT; el camino de props JSON
// (composer.ts) sigue intacto. Devuelve una PageModel sin secciones y con `agent` (archivos escritos y resumen): el
// transport no emite TSX, solo compila, mide, commitea y sirve el preview.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { identityRequest } from '../brief-tags';
import { IDENTITY_EDIT_FILE } from '../identity-ephemeral';
import type { Composer, ComposeRequest } from './server';
import type { EventLog, Suggestion } from './events';
import type { PageModel } from './runner';
import type { PageDoc, PageLang } from './page-doc';
import { PAGE_LANGS } from './page-doc';
import type { Infer } from './infer';
import { defaultImageGen, type ImageGen } from './image-step';
import { suggestionsFromSummary, turnSuggestions } from './agent-summary';
import type { AgentQuestion } from './ask-user';
import { suggestSection, suggestTurn, type SectionSuggestInput, type SuggestInput } from './suggest';
import { PLAN_FILE, parsePagePlanMd, planInvented, type PagePlanMd } from '../page-plan-md';
import { roleOfSlug } from '../section-slug';
import { planDisclosure, realDataSuggestion, type FactsDisclosure } from '../facts-disclosure';
import { candidatesIn, directionBlockPicks, directionReference, pickDirection, wantsProductImage, type BlockRole } from '../directions';
import { detectLanguage } from './compose-layout';
import { LANG_NAME } from './page-contract';
import { workspaceMcpConfig, workspaceMcpHttpConfig } from './workspace-mcp';
import { agentSystemPrompt, agentUserPrompt, followUpUserPrompt, planBuildPrompt, PROMPT_VERSION } from './agent-prompt';
import { EXIT_PLAN_TOOL_FULL, type PlanExit, type PlanPhase } from './plan-exit';
import { ASK_TOOL_FULL } from './ask-user';
import { writeFollowUpContext } from './follow-up-context';
import { pinnedLost, planLiterals, srcFiles, type Pin, type PinnedLost } from './pinned';
import { APPROVAL_TOOL, mcpConfigFile, withApprovalServer } from './approvals';
import { connectorProxyServers } from './connector-mcp';
import { AUTO_MODEL, CLI_TOOLS, DEFAULT_AGENT_MODEL, PLAN_CLI_TOOLS, runAgent, type RequiredCheck, type RunAgentCli } from './agent-loop';
import { contextTrace, type AgentTurn, type ContextTrace } from './agent-stream';
import { diffCheck, isCopyOnly } from './change-kind';
import { isRepo, treeChanges, worktreeTree } from './git-workspace';

export { AGENT_DIR, AGENT_SKILL_DIR } from '../skill-registry';
import { AGENT_DIR, AGENT_SKILL_DIR } from '../skill-registry';
import { blockTypeDecls, workspaceSource } from '../ds-skill-agent';
import { factsForLang } from '../brand-facts';
import { writeBrandSkill, type BrandSkillFiles } from '../skill-brand';
import { fillMissingImages, previousPending } from './image-fallback';
const SESSION_FILE = `${AGENT_DIR}/agent-session`;

export interface AgentPageInfo {
  files: string[];
  summary: string;
  /** preserve.pinned: texto dictado que el turno perdió (checkPinned); el transport lo suma a la verificación en PR 2. */
  pinnedLost?: PinnedLost[];
  sessionId?: string;
  /** Tokens del turno que reporta el CLI (result.usage): el builder los muestra junto a la duración. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** El CLI murió por una señal ajena y no terminó ni reanudando: la versión guarda lo escrito y cierra como detenida. */
  interrupted?: boolean;
  /** Verificaciones obligatorias que faltaron al terminar (el paso queda en rojo, la versión se guarda igual). */
  missing: RequiredCheck[];
  /** 2-3 siguientes pasos del apartado "Siguientes pasos" del resumen: los del modelo llegan después del commit, en el
   * step.end tardío de agent:suggestions, y estos quedan de respaldo. */
  suggestions: Suggestion[];
  /** El CLI terminó con error: no hay siguiente paso que proponer. */
  failed?: boolean;
  /** La pregunta del turno (tool ask_user): no editó y sus opciones son los chips. */
  question?: AgentQuestion;
  /** El plan que entregó el turno de modo plan (exit_plan_mode): no editó y espera la decisión de la persona. */
  planExit?: PlanExit;
  /** `page-plan.md` parseado, si el agente lo escribió: el builder lo muestra y QA mide plan→DOM. */
  plan?: PagePlanMd;
  /** C4 (S11 por corrida): lo que el plan declara inventado y las clases que el resumen no nombra. Solo si hay inventado. */
  factsDisclosed?: FactsDisclosure;
  /** Id de la dirección del catálogo entregada en references/direction.md (página nueva); el transport la recuerda. */
  direction?: string;
  /** §18: /images/ que el código referencia sin imagen generada; llevan placeholder y el sensor image.pending las marca. */
  images?: { pending: string[] };
  /** Trazabilidad del turno (Make: modelConfigVersion): con qué pin, server, pack, prompt y modelo se generó. */
  trace?: AgentTrace;
}

export interface AgentTrace {
  pin: string;
  serverCommit: string;
  packHash?: string;
  promptVersion: string;
  model: string;
  /** La persona pidió 'auto': `model` es el que decidió el server, no uno elegido. */
  auto?: boolean;
  effort: string;
  direction?: string;
  /** Modo plan (M1): el turno planeó (`plan`) o ejecutó el plan aprobado (`build`), con la ruta del plan. */
  plan?: { mode: PlanPhase['mode']; path?: string };
  /** Bloque elegido por rol (solo los roles con bloque); la misma elección que la columna Bloque de direction.md. */
  blocks?: { role: BlockRole; id: string; importPath: string; variant?: { prop: string; value: string } }[];
  /** Contexto que ocupó el turno (O2-B): piso de la primera llamada, última llamada y su ratio sobre la ventana. Se
   * registra y no se pinta, como Make (usageInfo descartado en make-chat/deob/3277:40269) y v0 (workMetrics). */
  context?: ContextTrace;
}

export interface AgentComposerOptions {
  model?: string;
  /** Inyectable en tests: el CLI falso que escribe archivos y emite el stream. */
  run?: RunAgentCli;
  imageGen?: (modelId: string) => ImageGen;
  /** El modelo barato del paso de siguientes pasos. Sin él no hay llamada extra: salen del resumen del agente. */
  suggest?: Infer;
  /** Commit del server que corre (serve lo lee con git); va a la traza del turno. */
  serverCommit?: string;
  /** Una sola imagen por página (la del hero). Tope de gasto para QA en vivo (--product-image-only). */
  imageOnly?: boolean;
}

/** `lang`, `title` y `description` salen del index.html que el agente dejó: el contrato de página del transport. */
export function pageDocFromHtml(html: string): PageDoc {
  const lang = /<html[^>]*\slang="([a-z]{2})/i.exec(html)?.[1];
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const description = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1]?.trim();
  return {
    ...(lang && PAGE_LANGS.includes(lang as PageLang) ? { lang: lang as PageLang } : {}),
    ...(title ? { title: title.slice(0, 120) } : {}),
    ...(description ? { description: description.slice(0, 300) } : {}),
  };
}

function readSession(dir: string): string | undefined {
  const p = join(dir, SESSION_FILE);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() || undefined : undefined;
}

const DIRECTION_FILE = 'direction.md';

/** El skill viaja dentro del workspace (como v0 monta el DS en `user_read_only_context`), ignorado por git. */
function placeSkill(skillDir: string, dir: string, brand: BrandSkillFiles = {}): void {
  const out = join(dir, AGENT_SKILL_DIR);
  mkdirSync(join(dir, AGENT_DIR), { recursive: true });
  writeFileSync(join(dir, AGENT_DIR, '.gitignore'), '*\n');
  if (!existsSync(out)) cpSync(skillDir, out, { recursive: true, dereference: true });
  // Aquí y no en el transport: el skill puede ser el del pin (transport) o el de skillDir (esta copia), y la marca va
  // encima de cualquiera de los dos. Sin marca restaura el del pin, para que un follow-up no herede la anterior.
  writeBrandSkill(out, brand);
}

/** Siguientes pasos fuera del turno: el transport los pide después del commit, en paralelo con el preview-check. */
/** `facts`: el agent.factsDisclosed del turno; con inventado, el chip de datos reales va primero (C4). */
export type SuggestHook = (input: SuggestInput, log: EventLog, facts?: FactsDisclosure) => Promise<Suggestion[] | null>;

/** Ideas de una sección a pedido (POST /runs/:id/sections/:slug/suggestions): fuera de cualquier turno, sin log. */
export type SectionSuggestHook = (input: SectionSuggestInput) => Promise<Suggestion[]>;

const imageGenOf = (req: Pick<ComposeRequest, 'imageGeneration'>, opts: AgentComposerOptions): ImageGen | undefined =>
  req.imageGeneration ? (opts.imageGen ? opts.imageGen(req.imageGeneration.modelId) : defaultImageGen(req.imageGeneration.modelId)) : undefined;

const TYPES_PRELOAD_MAX = 14_000;

// Tipos de los bloques del catálogo (props y data), extraídos de su fuente en el workspace. Cierra la brecha medida en
// las T1 #398 (f1bc7ab4, 024b517c, 9cab1be0): ~30 llamadas de exploración (`grep "^export interface"`, cat de `*-data.ts`)
// buscando las props. Respaldo: Stitch pasa el `designSystem` (I18nStore:16417-16443) y v0 monta el skill con sus archivos
// (task-skill-v1, fileCount 9, ZAP 606). El índice ya trae los NOMBRES de prop; aquí van las FORMAS (los tipos anidados
// como `Stat`).
function blockTypesPreload(dir: string, indexMd: string): string | undefined {
  const section = indexMd.split('## Secciones de landing')[1];
  if (!section) return undefined;
  const imports = [...section.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const parts: string[] = [];
  let total = 0;
  for (const importPath of imports) {
    if (seen.has(importPath)) continue;
    seen.add(importPath);
    const srcFile = join(dir, workspaceSource(importPath));
    const bdir = srcFile.slice(0, srcFile.lastIndexOf('/'));
    if (!existsSync(bdir)) continue;
    const decls = readdirSync(bdir)
      .filter((n) => n.endsWith('.ts') || n.endsWith('.tsx'))
      .sort()
      .flatMap((n) => blockTypeDecls(readFileSync(join(bdir, n), 'utf8')));
    const uniq = [...new Map(decls.map((d) => [d.split(/[\s{=]/).slice(0, 3).join(' '), d])).values()];
    if (!uniq.length) continue;
    const block = `### ${importPath}\n\`\`\`ts\n${uniq.join('\n')}\n\`\`\``;
    if (total + block.length > TYPES_PRELOAD_MAX) break;
    total += block.length;
    parts.push(block);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

// Palanca D: bloque fijo del skill para embeber en el prompt. Solo lo SIEMPRE necesario (SKILL.md + foundations +
// índice de componentes + tipos de los bloques del catálogo); las referencias por categoría (data.md, inputs.md…) siguen
// leyéndose a demanda. Cada archivo con una cabecera de ruta para que el agente lo cite igual que si lo hubiera leído.
function readSkillPreload(dir: string): string | undefined {
  const skillRoot = join(dir, AGENT_SKILL_DIR);
  const rel = (p: string): string => `${AGENT_SKILL_DIR}/${p}`;
  const parts: string[] = [];
  const add = (p: string): void => { const f = join(skillRoot, p); if (existsSync(f)) parts.push(`### ${rel(p)}\n${readFileSync(f, 'utf8').trim()}`); };
  add('SKILL.md');
  const fdir = join(skillRoot, 'references', 'foundations');
  if (existsSync(fdir)) for (const f of readdirSync(fdir).filter((n) => n.endsWith('.md')).sort()) add(join('references', 'foundations', f));
  const indexFile = join(skillRoot, 'references', 'components', 'index.md');
  add(join('references', 'components', 'index.md'));
  if (existsSync(indexFile)) {
    const types = blockTypesPreload(dir, readFileSync(indexFile, 'utf8'));
    if (types) parts.push(`### Tipos de los bloques del catálogo (props y data)\nSon la forma exacta de lo que pasas a cada bloque; no leas su fuente en \`src/components/\` para esto.\n\n${types}`);
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

export function createAgentComposer(skillDir: string, opts: AgentComposerOptions = {}): Composer & { suggest?: SuggestHook; suggestSection?: SectionSuggestHook } {
  if (!existsSync(join(skillDir, 'SKILL.md'))) throw new Error(`agent-composer: ${skillDir} no es un skill (falta SKILL.md)`);
  const compose = async (req: ComposeRequest, log: EventLog): Promise<PageModel> => {
    const workspace = req.workspace;
    if (!workspace?.dir) throw new Error('agent-composer: la petición no trae workspace.dir (el transport corre sin --agent)');
    const dir = workspace.dir;
    placeSkill(skillDir, dir, req.brandSkill);
    const followUp = Boolean(req.parentId);
    // `plan` lo pone el transport (ComposeRequest.plan, Secondary): sin él, el turno es el de siempre.
    const planPhase = (req as { plan?: PlanPhase }).plan;
    const planning = planPhase?.mode === 'plan';
    const lang = (req.parentPage?.page?.lang as PageLang | undefined) ?? langOf(req.prompt);

    // Dirección (catálogo de direcciones): elegida fuera del modelo con la semilla y entregada como referencia del skill,
    // antes del turno; el paso 3 del SKILL.md la lee si existe. Un follow-up no la vuelve a elegir.
    const direction = req.direction && !followUp ? pickDirection(req.direction) : undefined;
    if (direction && req.direction) {
      log.emit({ type: 'step.start', stepId: 'agent:direction', kind: 'action', label: 'Eligiendo dirección' });
      mkdirSync(join(dir, AGENT_SKILL_DIR, 'references'), { recursive: true });
      writeFileSync(join(dir, AGENT_SKILL_DIR, 'references', DIRECTION_FILE), directionReference(direction, undefined, req.direction.seed, candidatesIn(join(dir, 'src')), undefined, { metrics: Boolean(req.brand?.facts?.metrics?.length), prices: Boolean(req.brand?.facts?.prices?.length) }));
      const why = req.direction.styleSet ? ' (fijada por la marca)' : req.direction.recent.length ? `, sin repetir ${req.direction.recent.slice(-2).join(' ni ')}` : '';
      log.emit({ type: 'step.end', stepId: 'agent:direction', label: 'Dirección elegida', status: 'ok', detail: { kind: 'action', name: 'direction', summary: `${direction.id}${why}` } });
    }

    // La imagen es una tool del agente, como Lovable (registry-CmMIU-Jy :4836-4866): reemplaza al paso previo de imagen
    // de producto (S5, decisión de Karen). Sus args quedan en el stream del turno como rastro (S5 regla 11), en lugar de
    // .wt/image-plan.json. Es la única vía de imagen, como v0, Lovable y Make: sin la tool (o sin aprobación) la página
    // no lleva imágenes de sección generadas.
    const gen = imageGenOf(req, opts);
    const imageTool = Boolean(gen && req.imageGeneration && req.approval);
    // El tope de una imagen lo aplica el transport por mensaje (imagesPerRun); el prompt solo avisa al agente para que
    // no gaste la llamada.
    const imageOnly = imageTool && opts.imageOnly === true;
    // La dirección sigue decidiendo si el hero lleva foto (S5 regla 7): ya no apaga un paso, va como señal al prompt.
    const heroImage = !direction || wantsProductImage(direction);
    const attachments = (req.attachments ?? []).flatMap((a) => (a.asset ? [{ path: `/images/${a.asset.file}`, name: a.name, width: a.asset.width, height: a.asset.height }] : []));
    // Con endpoint de aprobación el servidor `wt` es el del transport (/mcp/:id): ahí generate_image y edit_image tienen la
    // key, que el env del CLI no lleva (agentEnv). El proceso hijo queda para el transport sin puerto, sin tools de imagen.
    const mcp = workspace.previewUrl
      ? req.approval
        ? workspaceMcpHttpConfig(`${new URL(req.approval.url).origin}/mcp/${encodeURIComponent(req.messageId)}`, req.approval.token)
        : workspaceMcpConfig(dir, workspace.previewUrl)
      : undefined;
    const hasBrowser = Boolean(mcp);
    // Conectores: un proxy stdio por app en el mismo --mcp-config que wt y la aprobación; el token de Pipedream se queda
    // en el transport. Sin endpoint de aprobación no hay conectores: sus tools no están en allowedTools y se denegarían.
    const connectors = req.approval ? (req.connectorMcp?.apps ?? []) : [];
    const baseConfig = connectors.length && req.approval ? JSON.stringify({ mcpServers: { ...(mcp ? (JSON.parse(mcp.config) as { mcpServers: object }).mcpServers : {}), ...connectorProxyServers(connectors, req.approval) } }) : mcp?.config;
    // Palanca D (AUDIT-COSTO): el bloque fijo del skill (SKILL.md + foundations + índice + tipos de los bloques del
    // catálogo) se embebe en el prompt para que el agente no gaste llamadas leyéndolo ni buscando las props en la fuente.
    const skillPreload = followUp ? undefined : readSkillPreload(dir);
    const system = agentSystemPrompt({ skillDir: AGENT_SKILL_DIR, ...(req.brand ? { brand: { name: req.brand.name, ...(req.brand.logoSrc ? { logoSrc: req.brand.logoSrc } : {}), ...(req.brand.facts ? { facts: factsForLang(req.brand.facts, lang) } : {}), ...(req.brand.instructions?.length ? { instructions: req.brand.instructions } : {}), ...(req.brand.memory?.length ? { memory: req.brand.memory } : {}) } } : {}), ...(attachments.length ? { attachments } : {}), ...(imageTool && mcp ? { imageTool: true, ...(imageOnly ? { imageOnly: true } : {}), heroImage } : {}), ...(direction ? { direction: { id: direction.id } } : {}), ...(connectors.length ? { connectors } : {}), hasBrowser, followUp, ...(skillPreload ? { skillPreload } : {}), ...(req.instructions?.length ? { instructions: req.instructions } : {}), ...(planning ? { planMessageId: req.messageId } : {}) });
    // Con preview, typecheck también compila la página en el dev server (C4): sustituye a `vite build`. Las capturas no son
    // obligatorias: en las T1 medidas el ciclo que las repetía tras corregir nunca encontró nada y la reanudación por una
    // captura que no llegó al final costó un turno entero sin cambios (planes/ec.md §Ciclos). Lovable verifica con el log
    // del dev server y un curl, sin capturas ni build (ZAP 1854); Make, con build y grep (livegraph canal 17).
    const full: RequiredCheck[] = hasBrowser ? ['typecheck'] : ['typecheck', 'build'];
    // Un follow-up que solo cambió texto en una sección lo cubre el preview-check (desborde, CTA partido, contraste, clics).
    // Un follow-up que preguntó en vez de editar no dejó nada que verificar: como el turno de pregunta de v0 (sin read-back).
    const required = (t: AgentTurn): readonly RequiredCheck[] => (planning ? [] : followUp && !t.writes.length ? [] : followUp && isCopyOnly(dir, t.writes) ? ['typecheck'] : full);
    // gen7 (plan aprobado por Karen): si tras el turno falta una verificación, una reanudación que la pida; antes 0 y la
    // página salía "sin verificar" aunque el agente pudiera arreglarlo en un paso.
    const MAX_RESUMES = 1;
    const auto = req.model === AUTO_MODEL;
    const model = (auto ? undefined : req.model) ?? opts.model ?? process.env.WT_AGENT_MODEL ?? DEFAULT_AGENT_MODEL;
    // Traza del turno antes de escribir: con qué se generó esta versión, para comparar corridas y pins.
    // Sin thinking en la petición el CLI usa su propio esfuerzo: 'default', no 'none' (fac2bce5).
    const trace: AgentTrace = {
      pin: req.registry?.pin ?? 'local', serverCommit: opts.serverCommit ?? process.env.WT_SERVER_COMMIT ?? 'unknown', ...(req.brand?.hash ? { packHash: req.brand.hash } : {}),
      promptVersion: PROMPT_VERSION, model, ...(auto ? { auto: true } : {}), effort: req.thinking?.effort ?? 'default', ...(direction ? { direction: direction.id } : {}), ...(planPhase ? { plan: { mode: planPhase.mode, ...(planPhase.mode === 'build' ? { path: planPhase.path } : {}) } } : {}),
      ...(direction && req.direction ? { blocks: directionBlockPicks(direction, undefined, req.direction.seed, candidatesIn(join(dir, 'src'))).flatMap(({ role, block }) => (block ? [{ role, id: block.id, importPath: block.importPath, ...(block.variant ? { variant: block.variant } : {}) }] : [])) } : {}),
    };
    log.emit({ type: 'step.start', stepId: 'agent:trace', kind: 'action', label: 'Traza del turno' });
    log.emit({ type: 'step.end', stepId: 'agent:trace', label: 'Traza del turno', status: 'ok', detail: { kind: 'action', name: 'trace', summary: `pin ${trace.pin} · server ${trace.serverCommit}${trace.packHash ? ` · pack ${trace.packHash}` : ''} · prompt ${trace.promptVersion} · ${trace.model}${trace.auto ? ' (auto)' : ''}/${trace.effort}${trace.direction ? ` · ${trace.direction}` : ''}${trace.blocks?.length ? ` · bloques ${trace.blocks.map((b) => `${b.role}:${b.id.replace(/^[^/]+\//, '')}`).join(', ')}` : ''}` } });
    const stepId = 'agent:write';
    log.emit({ type: 'step.start', stepId, kind: 'action', label: followUp ? 'Editando la página' : 'Escribiendo la página' });
    // Ola 2 E: el follow-up arranca en sesión nueva; reanudar pagaba 200-380 k de caché por llamada (AUDIT-COSTO-SINTESIS §3).
    // WT_FOLLOWUP_RESUME=1 vuelve a reanudar, para medir uno contra otro en el bench.
    // El permiso vale solo para este turno: el siguiente follow-up vuelve a proteger la marca salvo que lo pida también.
    if (followUp && identityRequest(req.prompt)) { mkdirSync(join(dir, '.wt'), { recursive: true }); writeFileSync(join(dir, IDENTITY_EDIT_FILE), req.messageId); }
    else rmSync(join(dir, IDENTITY_EDIT_FILE), { force: true });
    // Continuar (R2.6) reanuda la sesión de la corrida interrumpida aunque el follow-up abra sesión nueva por defecto.
    const resume = req.resume ?? (followUp && process.env.WT_FOLLOWUP_RESUME === '1' ? readSession(dir) : undefined);
    const fresh = followUp && !resume;
    const secretConfig = req.approval ? mcpConfigFile(withApprovalServer(baseConfig, req.approval)) : undefined;
    const treeBefore = followUp && isRepo(dir) ? worktreeTree(dir) : undefined;
    const { turn, missing } = await runAgent({
      dir, system, prompt: planPhase?.mode === 'build' ? planBuildPrompt(planPhase.path, planPhase.edited) : fresh ? followUpUserPrompt(req.prompt, { contextFiles: writeFollowUpContext(dir, req.history ?? { thread: [], tools: [], lastFiles: [] }), ...(req.selectedSections?.length ? { selectedSections: req.selectedSections } : {}), ...(req.history?.pinned?.length ? { pinned: req.history.pinned } : {}) }, attachments) : agentUserPrompt(req.prompt, attachments), model,
      ...(req.thinking?.effort ? { effort: req.thinking.effort } : {}),
      allowedTools: planning ? [...PLAN_CLI_TOOLS, ASK_TOOL_FULL, EXIT_PLAN_TOOL_FULL] : [...CLI_TOOLS, ...(mcp?.allowedTools ?? [])],
      ...(secretConfig ? { mcpConfig: secretConfig.path, permissionPromptTool: APPROVAL_TOOL } : mcp ? { mcpConfig: mcp.config } : {}),
      ...(resume ? { resume } : {}),
      ...(opts.run ? { run: opts.run } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.steer ? { steer: req.steer } : {}),
      ...(req.runToken ? { runToken: req.runToken } : {}),
      parentStepId: stepId,
    }, log, required, MAX_RESUMES).finally(() => secretConfig?.dispose());
    if (turn.sessionId) writeFileSync(join(dir, SESSION_FILE), turn.sessionId);
    // Antes de medir el árbol: el placeholder entra en la versión igual que una imagen generada.
    // Un turno de plan no escribe: lo pendiente heredado pasa tal cual en vez de perderse.
    const inherited = previousPending(req.parentPage?.agent?.images?.pending);
    const fallback = planning ? { pending: inherited, errors: [] } : fillMissingImages(dir, inherited);
    const pendingImages = fallback.pending;
    if (fallback.errors.length) {
      log.emit({ type: 'step.start', stepId: 'agent:image-fallback', kind: 'tool', label: 'Placeholder de imágenes' });
      log.emit({ type: 'step.end', stepId: 'agent:image-fallback', label: 'Imágenes sin placeholder', status: 'error', error: { type: 'image-fallback', message: fallback.errors.join('\n').slice(0, 500) } });
    }
    // Lo que cambió el turno sale del árbol, como la versión (transport materialize): generate_image y edit_image
    // escriben public/images sin Write/Edit, y una variante que solo cambió fotos cerraba "Pregunta antes de editar"
    // con 0 archivos (QA ee252db7).
    const changed = treeBefore ? treeChanges(dir, treeBefore, worktreeTree(dir)) : turn.writes;
    const detail = { kind: 'action' as const, name: 'agent', summary: `${changed.length} archivos${turn.usage.durationMs ? `, ${Math.round(turn.usage.durationMs / 1000)} s` : ''}${turn.denials ? `, ${turn.denials} Bash denegados` : ''}` };
    // La corrida se detuvo desde fuera: Stop de la persona, cancel de variantes o cierre del transport (transport.ts stopReasons;
    // el motivo no viaja en req.signal). Ni "Pregunta antes de editar" ni un error del agente, que mentían en QA caso 2
    // ("Pregunta antes de editar · 0 archivos" en una corrida stopped). Lo escrito se conserva.
    if (req.signal?.aborted) log.emit({ type: 'step.end', stepId, label: `Detenido · ${changed.length} ${changed.length === 1 ? 'archivo' : 'archivos'}`, status: 'ok', detail });
    else if (turn.interrupted) log.emit({ type: 'step.end', stepId, label: 'El agente se cortó: queda lo que alcanzó a escribir', status: 'error', detail, error: { type: 'agent-interrupted', message: 'el CLI murió por una señal externa y la reanudación tampoco terminó' } });
    else if (turn.isError) log.emit({ type: 'step.end', stepId, label: 'El agente no terminó', status: 'error', detail, error: { type: 'agent', message: turn.summary.slice(0, 500) || 'sin resultado' } });
    else if (planning) log.emit({ type: 'step.end', stepId, ...(turn.planExit ? { label: 'Plan enviado', status: 'ok' as const } : turn.question ? { label: 'Pregunta antes de planear', status: 'ok' as const } : { label: 'El plan no se envió', status: 'error' as const, error: { type: 'plan-missing', message: 'el turno terminó sin llamar a exit_plan_mode' } }), detail });
    else if (missing.length) log.emit({ type: 'step.end', stepId, label: `Página escrita sin verificar: ${missing.join(', ')}`, status: 'error', detail, error: { type: 'agent-verify', message: `faltaron después de la última escritura: ${missing.join(', ')}` } });
    else log.emit({ type: 'step.end', stepId, label: followUp ? (changed.length ? 'Página editada' : 'Pregunta antes de editar') : 'Página escrita', status: 'ok', detail });
    // Propio, no de Make (Make corre formatter + build: net-t4-figmake.network-response:1445): marcadores de conflicto y
    // espacios sobrantes en lo que dejó el turno. Queda a la vista, no bloquea.
    if (followUp) {
      const ws = diffCheck(dir);
      log.emit({ type: 'step.start', stepId: 'agent:diff-check', kind: 'tool', label: 'git diff --check' });
      if (ws) log.emit({ type: 'step.end', stepId: 'agent:diff-check', label: 'git diff --check con avisos', status: 'error', error: { type: 'diff-check', message: ws } });
      else log.emit({ type: 'step.end', stepId: 'agent:diff-check', label: 'git diff --check limpio', status: 'ok' });
    }
    const pinnedLost = !planning && !req.signal?.aborted ? checkPinned(dir, req, planPhase, log) : [];
    const htmlPath = join(dir, 'index.html');
    const doc = existsSync(htmlPath) ? pageDocFromHtml(readFileSync(htmlPath, 'utf8')) : {};
    const page: PageDoc = { ...(req.parentPage?.page ?? {}), lang, ...doc };
    const planPath = join(dir, PLAN_FILE);
    const plan = existsSync(planPath) ? parsePagePlanMd(readFileSync(planPath, 'utf8')) : undefined;
    const tokens = { ...(turn.usage.inputTokens !== undefined ? { inputTokens: turn.usage.inputTokens } : {}), ...(turn.usage.outputTokens !== undefined ? { outputTokens: turn.usage.outputTokens } : {}) };
    // Una pregunta trae sus respuestas como chips; sin la tool, las del resumen, nunca las del turno anterior.
    const base = turn.question ? turn.question.options : followUp && !turn.writes.length ? suggestionsFromSummary(turn.summary) : turnSuggestions(turn.summary, req.parentPage?.agent?.suggestions, req.prompt);
    // Como Lovable, lo inventado de la página se lista y lleva su chip de datos reales (s3-sugerencias §1). Solo en un turno
    // que escribió: una pregunta o un plan esperan a la persona y sus chips son las opciones.
    const wrote = !turn.question && !turn.planExit && turn.writes.length > 0;
    const factsDisclosed = wrote && plan ? planDisclosure(planInvented(plan), turn.summary) : undefined;
    const realData = factsDisclosed ? realDataSuggestion(factsDisclosed.invented, page.lang ?? lang) : undefined;
    const suggestions = realData ? [realData, ...base.filter((x) => x.title !== realData.title)].slice(0, 3) : base;
    const context = contextTrace(turn.usage);
    const agent: AgentPageInfo = { files: turn.writes, summary: turn.summary, ...(turn.question ? { question: turn.question } : {}), ...(turn.planExit ? { planExit: turn.planExit } : {}), ...(turn.interrupted ? { interrupted: true } : {}), ...(turn.isError ? { failed: true } : {}), ...(turn.sessionId ? { sessionId: turn.sessionId } : {}), ...(Object.keys(tokens).length ? { usage: tokens } : {}), missing, suggestions, ...(direction ? { direction: direction.id } : {}), trace: context ? { ...trace, context } : trace, ...(plan?.sections.length ? { plan } : {}), ...(factsDisclosed ? { factsDisclosed } : {}), ...(pinnedLost.length ? { pinnedLost } : {}), ...(pendingImages.length ? { images: { pending: pendingImages } } : {}) };
    return { page, sections: [], agent };
  };
  const suggest = opts.suggest;
  return Object.assign(compose, { ...(suggest ? { suggest: ((input, log, facts) => suggestTurn(suggest, input, log, undefined, facts ? realDataSuggestion(facts.invented, input.lang) : undefined)) satisfies SuggestHook, suggestSection: ((input) => suggestSection(suggest, input)) satisfies SectionSuggestHook } : {}) });
}

/** preserve.pinned: lo dictado en pedidos anteriores (req.history.pinned) y, en la fase build de un plan, lo que la persona
 * escribió en él (líneas `usuario:`) sigue literal en src/. Si no, defecto `pinned.lost` con archivo y texto en el log. */
export function checkPinned(dir: string, req: Pick<ComposeRequest, 'history' | 'prompt' | 'messageId'>, planPhase: PlanPhase | undefined, log: EventLog): PinnedLost[] {
  const planPath = planPhase?.mode === 'build' ? planPhase.path : undefined;
  const fromPlan: Pin[] = planPath && existsSync(join(dir, planPath)) ? planLiterals(readFileSync(join(dir, planPath), 'utf8')).map((text) => ({ text, file: planPath, messageId: req.messageId })) : [];
  const pins = [...(req.history?.pinned ?? []), ...fromPlan];
  if (!pins.length) return [];
  const lost = pinnedLost(pins, srcFiles(dir), req.prompt);
  const stepId = 'agent:pinned';
  const defects = lost.map((l) => ({ field: 'pinned.lost', file: l.file, text: l.text, messageId: l.messageId }));
  log.emit({ type: 'step.start', stepId, kind: 'tool', label: 'Texto fijo' });
  if (lost.length) log.emit({ type: 'step.end', stepId, label: `Se perdió texto fijo (${lost.length} de ${pins.length})`, status: 'error', detail: { kind: 'tool', name: 'pinned', output: { defects } }, error: { type: 'pinned-lost', message: lost.map((l) => `${l.file}: "${l.text}"`).join('; ').slice(0, 500) } });
  else log.emit({ type: 'step.end', stepId, label: `Texto fijo intacto (${pins.length})`, status: 'ok', detail: { kind: 'tool', name: 'pinned', output: { defects: [] } } });
  return lost;
}

/** Las secciones que escribió el agente, por su archivo `NN-<rol>[-N]`: los slugs de data-wt-slug a los que se ata cada
 *  sugerencia, en el orden de la página. Desde #723 el prefijo no es el orden (una copia es `04-casos-2` y mover no
 *  renumera): manda la posición del componente en App.tsx; lo que App.tsx no monta va al final por slug. */
export function mountedSections(dir: string): { slug: string; role: string }[] {
  const at = join(dir, 'src', 'sections');
  if (!existsSync(at)) return [];
  const slugs = readdirSync(at).flatMap((f) => { const m = /^(\d{2}-[a-z0-9-]+)\.tsx$/.exec(f); return m ? [m[1]!] : []; });
  const appPath = join(dir, 'src', 'App.tsx');
  const app = existsSync(appPath) ? readFileSync(appPath, 'utf8') : '';
  const body = app.slice(Math.max(0, app.indexOf('export default')));
  const firstUse = new Map<string, number>();
  for (const m of app.matchAll(/^import\s+(\w+)\s+from\s+['"](?:\.\/|@\/)sections\/([a-z0-9-]+)['"]/gm)) {
    const i = body.search(new RegExp(`<${m[1]}[\\s/>]`));
    if (i >= 0) firstUse.set(m[2]!, i);
  }
  const pos = (slug: string): number => firstUse.get(slug) ?? Number.MAX_SAFE_INTEGER;
  return slugs.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b)).map((slug) => ({ slug, role: roleOfSlug(slug) }));
}

const langOf = (text: string): PageLang => {
  const name = detectLanguage(text);
  return (Object.entries(LANG_NAME).find(([, n]) => n === name)?.[0] as PageLang | undefined) ?? 'es';
};
