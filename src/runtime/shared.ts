// Tipos, constantes y helpers que comparten Runtime y sus colaboradores (api-handlers, brand-store, direct-edit,
// preview-dist, run-reads, edit-runs, agent-mcp, variants, brand-runs). Sin lógica de corrida: solo lo que más de un
// módulo necesita, para que ningún colaborador importe transport.ts (ADR 0014 regla 2). Movido tal cual de transport.ts.

import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './child-run';
import type { EventLog, FinishReason, Outcome, VariantInfo } from './events';
import { AGENT_STREAM_FILE, agentEnv, type Steer } from './agent-loop';
import type { PermissionMode } from './approvals';
import type { PlanPhase } from './plan-exit';
import type { Upload } from './uploads';
import type { Viewport } from './follow-up-context';
import { StepError } from './step';
import { HttpError, type OriginTrust } from './http';
import type { EngineEvent } from './events';
import type { Allowlist, WorkspaceOptions } from './runner';
import type { ImageGen } from './image-step';
import type { ImageEdit } from './image-tool';
import { cliDescribe, type Describe } from './vision';
import { config, type ComposeProvider } from '../config';
import type { PreviewPool } from './preview';
import type { PreviewChecker } from './preview-check';
import type { Fetcher } from './assets';
import type { Connectors, ConnectorsRun } from './connectors';
import type { AssetRule, FactsSource } from '../brand-facts-source';
import type { FetchBytes } from '../facts-images';
import type { Infer } from './infer';
import type { PublishProvider } from './publish';
import type { TextStream } from './prompt-enhancer';
import type { PageModel } from './runner';
import type { FollowUpHistory } from './follow-up-context';
import type { Attachment } from './uploads';
import type { RegistrySource } from './registry';
import type { BrandFacts } from '../brand-facts';
import type { BrandSkillFiles } from '../skill-brand';
import type { ConnectorMcp } from './connector-mcp';
import type { ApprovalEndpoint } from './approvals';
import type { SessionVerifier } from './session';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof EFFORTS)[number];

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export type ImageModel = ModelOption;

/** El loop del agente (orq). Emite sus propios pasos en el log y devuelve la página verificada. */
export type Composer = (req: ComposeRequest, log: EventLog) => Promise<PageModel>;

export interface RuntimeOptions extends Omit<WorkspaceOptions, 'log'> {
  /** generate_image/edit_image del MCP del workspace (POST /mcp/:id), que corre en este proceso: la key u OIDC del gateway
   * no sale de aquí. Default por WT_IMAGE_PROVIDER, como el composer; editar solo con gateway. Los tests pasan uno falso. */
  imageService?: { gen: (modelId: string) => ImageGen; edit?: (modelId: string) => ImageEdit };
  /** Visión de `browser` con `question` en el /mcp. Default agentDescribe; los tests pasan una falsa. */
  agentDescribe?: Describe;
  /** Raíz de estado: ws/<workspace>/ (repos git), logs/ (un NDJSON por mensaje), index.json. */
  root: string;
  /** Zona horaria IANA para la fecha de la memoria de marca (`remember`). El proceso corre en UTC en Sandbox/Vercel, así que
   * sin esto un hecho guardado de noche en CDMX sale con fecha de mañana. Se valida al arrancar; ausente = UTC del proceso
   * (sin default inventado: el default es decisión de producto). */
  timezone?: string;
  /** Identidad (docs/spec/identidad-sesion.md): quién es la persona de cada request. Ausente = `localVerifier` (loopback,
   * dueño 'local'). Con `trust` (deploy) es obligatorio: el secreto prueba el rewrite, no la persona. */
  session?: SessionVerifier;
  allow: Allowlist;
  compose: Composer;
  /** ADR 0011: el composer es el agente que escribe archivos; el transport materializa todo el DS, le pasa el workspace y no emite TSX. */
  agent?: boolean;
  previews?: PreviewPool;
  /** Puerto del listener de previews (R5.5), aparte de la API: cada ws tiene su propio origen `<ws>.<host>:<previewPort>`.
   * Ausente = sin url estable; el preview se abre por el puerto de vite como antes. */
  previewPort?: number;
  /** Origen base del listener de previews (scheme+host[:port]): la url estable de cada ws es `<ws>.<host>` sobre él (R5.5).
   * El host NO puede ser una IP (el subdominio por ws no funciona sobre una IP). Ausente = http://localhost:<previewPort>. */
  previewOrigin?: string;
  /** Origen del builder (`--builder-origin`): el único Origin ajeno que puede escribir en la API. Ausente = ninguno. */
  builderOrigin?: string;
  /** Secreto del token de preview (WT_PREVIEW_SECRET, 32 bytes o más): enciende el gate del listener en modo HMAC local (identidad §9). Ausente = apagado. */
  previewSecret?: Buffer;
  /** Llave pública Ed25519 del preview (WT_PREVIEW_PUBLIC_KEY): enciende el gate en modo asimétrico bajo el orquestador (deploy-sandbox §4). Excluyente con previewSecret. */
  previewPublicKey?: import('node:crypto').KeyObject;
  /** Revisa el preview vivo tras levantarlo (errores de runtime y secciones sin montar). Ausente = no se revisa. */
  previewCheck?: PreviewChecker;
  /** vite build como gate de compilación antes del commit. */
  build?: boolean;
  /** Comando del build (por defecto `bunx vite build --logLevel error`); inyectable para probar el camino de fallo sin vite. */
  buildCommand?: readonly [string, ...string[]];
  /** Modelos del agente que puede elegir el builder (GET /models). Definido, un `model` fuera de la lista es 400 y sin
   * `model` va el primero: en el deploy cada modelo gasta de la misma key. Ausente = cualquier string, como en local. */
  models?: ModelOption[];
  /** Modelos de imagen que el composer sabe usar; vacío = sin generación de imágenes. */
  imageModels?: ImageModel[];
  /** Transcripción de audio del dictado. Ausente = el builder no monta el micrófono: el CLI del core no transcribe, y sin
   * esto la persona grababa para recibir un 415. Lo inyecta la variante que tenga proveedor (AI Gateway sirve whisper). */
  transcribe?: (audio: Uint8Array, type: string) => Promise<string>;
  /** Descarga de imágenes del CDN; inyectable para tests sin red. */
  fetchAsset?: Fetcher;
  /** Fija el registry para una corrida: con pin, ese índice (el de la versión padre); sin pin, el
   * puntero latest. Ausente = vault local. */
  registry?: (pin?: string) => Promise<RegistrySource>;
  /** Pipedream Connect; ausente = /connectors/* da 501 connectors-unavailable (igual que el orquestador) y el builder muestra "no conectado". */
  connectors?: Connectors;
  /** Con orquestador: las corridas piden tools y reenvíos al orquestador con su token; la credencial no entra en la VM. `connectors` (local) manda si está. */
  connectorsRemote?: ConnectorsRun;
  /** Cada cuánto manda una línea vacía un stream sin eventos nuevos. */
  heartbeatMs?: number;
  /** Plazo por tool del /mcp; default el del watchdog del CLI (TOOL_DEADLINES). Solo los tests lo bajan. */
  toolDeadlines?: Readonly<Record<string, number>>;
  /** Tope de generate_image por mensaje, no por página (--product-image-only = 1). Vive en el transport y no en el workspace: el agente
   * tiene Write y Bash en su cwd y podía borrar un tope en archivo (Arq sobre b982009). Ausente = sin tope. */
  imagesPerRun?: number;
  /** Corridas a la vez en todo el proceso; sin valor, MAX_RUNNING. */
  maxRunning?: number;
  /** Interruptor de la demo pública: POST /runs responde 503 sin abrir ninguna corrida. */
  runsDisabled?: boolean;
  /** Arreglo automático tras una versión con errores de runtime o de render (Karen 2026-11-03, estilo figma-make); en
   * false quedan solo el botón y el chip manuales. Sin valor, encendido. */
  autoRepair?: boolean;
  /** Fuera de loopback (Sandbox detrás del rewrite /api del builder): el secreto que Vercel pone en x-origin-secret y
   * el origen del builder. Sin secreto, solo loopback, como siempre. */
  trust?: OriginTrust;
  /** Sin registry, de dónde salen los packs que pide page.brand (carpetas brand-pack-<id>). */
  brandsRoot?: string;
  /** Fuente viva de hechos por id de marca (proxy de Webflow); una marca con fuente falla cerrado si no responde. */
  factsSources?: Record<string, FactsSource>;
  /** Hosts de los que puede venir una imagen de los hechos. Sin lista no se baja ninguna: los hosts son de la fuente, y
   * un default del core sería el CDN de una marca concreta. */
  factsAssets?: readonly AssetRule[];
  /** Descarga de logos y fotos de los hechos; inyectable para tests sin red. */
  fetchFactImage?: FetchBytes;
  /** Tools de conector con `readOnlyHint: true`; las que no están aquí cuentan como escritura y siempre se preguntan. */
  readOnlyTools?: ReadonlySet<string>;
  /** El modelo que escribe el título y el prompt de cada variante; inyectable en tests. Sin él, el CLI con
   * WT_VARIANTS_PLAN_MODEL (haiku por defecto), como las sugerencias. */
  variantsPlan?: Infer;
  /** El modelo que convierte un Editar con IA en ops de parche (H5); inyectable en tests. Sin él, el CLI con
   * WT_PATCH_MODEL (haiku por defecto). */
  patchPlan?: Infer;
  /** El modelo que resume los turnos viejos del hilo en un follow-up largo (H18); inyectable en tests. Sin él, el CLI con
   * WT_THREAD_SUMMARY_MODEL (haiku por defecto). */
  threadSummary?: Infer;
  approvalTimeoutMs?: number;
  /** Stream del enhancer de prompt; inyectable para tests sin red. Sin él, el proveedor de config (cli en core). */
  enhance?: TextStream;
  /** Tope del enhancer (OPTIONAL_TIMEOUT_MS); inyectable en tests. */
  enhanceTimeoutMs?: number;
  /** tsc del workspace para la edición de texto; inyectable para tests sin typescript instalado. */
  tsc?: (dir: string) => string | Promise<string>;
  /** El compilador con el que se ubica un elemento a borrar; por defecto, el typescript del workspace. */
  typescript?: typeof import('typescript');
  /** Destino de POST /runs/:id/publish. El core trae solo el export local; ausente = 501 (publish no habilitado). */
  publish?: PublishProvider;
}

const REASON_MAX = 300;

/** El CLI no le pasa a la permission-prompt-tool por qué el agente llama la tool; como v0, el motivo es lo que el agente
 * escribió justo antes: el texto desde la última tool terminada. La tool que espera ya abrió su paso y no cuenta. */
export function reasonOf(events: readonly EngineEvent[]): string | undefined {
  const texts: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'step.end' || e.type === 'message.start') break;
    if (e.type === 'text.delta') texts.unshift(e.text);
  }
  const text = texts.join('').trim();
  return text ? text.slice(-REASON_MAX) : undefined;
}

/** Visión de la tool `browser` del agente. Con el MCP stdio corría con el env filtrado del CLI y por gateway fallaba sin
 * key; servida por el transport tendría la key y gastaría sin tarjeta ni tope (security-reviewer 2026-11-02, H1). Se
 * mantiene lo de antes: por la sesión de Claude Code con cli, y sin visión con gateway. */
export const agentDescribe = (provider: ComposeProvider = config().composeProvider): Describe =>
  provider === 'gateway' ? async () => { throw new Error('la visión no está disponible para el agente con el gateway'); } : cliDescribe();

export interface ComposeRequest {
  prompt: string;
  /** Token de gasto de la corrida para el proxy de Gateway (agentEnv). Credencial: requestRecord lo quita de request.json y no
   * se emite en eventos. */
  runToken?: string;
  model?: string;
  messageId: string;
  parentId?: string;
  /** La página del mensaje padre, para que un follow-up edite en vez de empezar de cero. */
  parentPage?: PageModel;
  /** Historial del hilo para un follow-up en sesión nueva: el composer lo vuelca a `.wt/context/` (follow-up-context.ts). */
  history?: FollowUpHistory;
  /** Reglas del usuario ya resueltas: las del mensaje o, si no trae, las heredadas del padre. */
  instructions?: string[];
  /** Adjuntos ya copiados al workspace (rutas relativas a él). */
  attachments?: Attachment[];
  imageGeneration?: { modelId: string };
  /** Razonamiento extendido; ausente = apagado (v0: modelConfiguration.thinking + thinkingEffort). */
  thinking?: { effort: ThinkingEffort };
  /** Preferencia de página, no del mensaje (v0: toolConfiguration.webSearch). */
  tools?: { webSearch: boolean };
  /** Registry fijado para esta corrida; el mismo que usará el runner. */
  registry?: RegistrySource;
  /** Slugs de apps conectadas que el composer puede usar (solo herramientas de lectura). */
  connectors?: string[];
  /** Secciones elegidas por la persona (data-wt-slug), como selectedNodeIds de Stitch (DesignPage wakaru l.43216) y
   * selectedElements de Lovable (visual-edits wakaru l.233-257): viajan como campo, no solo como texto del pedido. */
  selectedSections?: string[];
  /** Marca ya aplicada al workspace (identity.css, fuentes, logo): la de la petición, la heredada o la detectada en el
   * brief. `facts` son los hechos reales del pack (facts.json), si los trae. `memory` son los hechos que el agente guardó
   * con `remember` en turnos anteriores de esta marca (M2), para el bloque MEMORIA DE LA MARCA del prompt. */
  brand?: { id: string; name: string; logoSrc?: string; facts?: BrandFacts; styleSet?: string; hash?: string; instructions?: string[]; memory?: string[] };
  /** Colores, logos y variantes de esa marca para el skill montado; ausente = el skill vuelve al del pin. */
  brandSkill?: BrandSkillFiles;
  /** Página nueva: entrada de pickDirection (catálogo de direcciones). Semilla = id del mensaje; sector y tono del brief;
   * `recent` = últimas direcciones de la misma marca o del mismo brief, la más reciente al final. */
  direction?: { seed: string; sector: string[]; tone: string[]; recent: string[]; styleSet?: string };
  /** Servidores MCP de las apps conectadas del request (uno por slug) y sus tools de solo lectura. */
  connectorMcp?: ConnectorMcp;
  /** ADR 0011 (`--agent`): el composer escribe en este workspace; `previewUrl` es el dev server vivo para la tool browser. */
  workspace?: { dir: string; previewUrl?: string; installError?: string };
  /** Endpoint de la permission-prompt-tool para esta corrida; ausente = lo que no está permitido se deniega sin preguntar. */
  approval?: ApprovalEndpoint;
  /** Se aborta con POST /runs/:id/cancel: el composer corta al agente y devuelve lo que haya escrito. */
  signal?: AbortSignal;
  /** Continuar (R2.6): reanuda esta sesión del CLI en vez de abrir una nueva. */
  resume?: string;
  /** Modo plan (H6): el composer arma allowedTools y el system prompt según la fase; en `build` reanuda `resume`. */
  plan?: PlanPhase;
  /** Mensajes que la persona manda con el turno en curso; solo el composer del agente los lee. */
  steer?: Steer;
}

export interface RunInput {
  prompt: string;
  /** Ver ComposeRequest.runToken. */
  runToken?: string;
  model?: string;
  instructions?: string[];
  attachments: Upload[];
  imageGeneration?: { modelId: string };
  thinking?: { effort: ThinkingEffort };
  tools?: { webSearch: boolean };
  connectors?: string[];
  /** Secciones elegidas por la persona (data-wt-slug), como selectedNodeIds de Stitch (DesignPage wakaru l.43216) y
   * selectedElements de Lovable (visual-edits wakaru l.233-257): viajan como campo, no solo como texto del pedido. */
  selectedSections?: string[];
  /** Tamaño del preview que la persona mira al mandar el mensaje; va a `.wt/context/preview_state/` del follow-up. */
  viewport?: Viewport;
  /** Arreglo de errores de runtime: si el agente no escribe nada, el mensaje cierra sin versión. */
  runtimeRepair?: boolean;
  brand?: string;
  /** Esta corrida es una variante de un grupo (S5): su título y su prompt salen del plan del grupo. */
  variant?: VariantInfo;
  /** Continuar (R2.6): la sesión del CLI de la corrida interrumpida, reanudada con --resume. */
  resume?: string;
  /** Modo plan (H6): `plan` planea sin versión; `build` ejecuta el plan aprobado reanudando la sesión del plan. */
  plan?: PlanPhase;
}

export interface VersionStats {
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
}

export interface MessageEntry {
  ws: string;
  /** Dueño del chat (session.owner, docs/spec/identidad-sesion.md §5). Lo escribe run-cycle en el mensaje raíz y los hijos
   * lo heredan en `updateEntry`; ausente = 'local' (opción c de §6). */
  owner?: string;
  parentId?: string;
  commit?: string;
  /** Título de la versión para el picker: primera línea del prompt o "Restored …". */
  title?: string;
  /** El pedido completo y su modelo: GET /chats/:id los devuelve para que el builder rehidrate el hilo al recargar. */
  prompt?: string;
  model?: string;
  /** El effort con que arrancó el turno: Continuar tras un kill -9 lo hereda si el pedido no trae thinking (QA fila 1). */
  thinking?: { effort: ThinkingEffort };
  /** Zona IANA del navegador en este turno (Lovable: user_timezone en cada POST /chat); gana a opts.timezone en `today()`. */
  timezone?: string;
  at?: number;
  restoreFrom?: string;
  /** Corrida "actualizar DS": el pin del que venía el chat y el `latest` al que pasó. */
  updatedDs?: { from?: string; to: string };
  appliedBrand?: { from?: string; to: string };
  /** Corrida "Aplicar" del panel Tema: los params que fijó sobre la marca de la versión. */
  appliedTheme?: Record<string, unknown>;
  /** Turno de arreglo de runtime, lanzado por la persona con "Arreglar" (como "Fix with v0") o por el auto-repair. */
  runtimeRepair?: boolean;
  /** Este arreglo lo lanzó el sistema y no la persona: el builder lo pinta como "Arreglando errores…", no como turno suyo. */
  autoRepair?: AutoRepairKind;
  /** Hijo que el auto-repair ya lanzó sobre esta versión: el tope es uno por versión. */
  autoRepaired?: string;
  /** Modo de aprobación del chat al lanzar este mensaje; el siguiente lo hereda si no trae otro. */
  permissionMode?: PermissionMode;
  /** Modo plan (H6): este turno planea en vez de construir. No se hereda del padre. */
  mode?: 'plan';
  /** El plan entregado a Approvals y su estado. `sessionId` es la sesión del CLI del turno de plan, para reanudar la fase
   * build en el mismo mensaje. Vive en el índice (no en memoria) para sobrevivir al reinicio con el plan pendiente. */
  plan?: { callId: string; path: string; summary: string; sessionId?: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled' };
  /** El viewport de la persona al pedir un turno de plan: el turno de plan no verifica nada, y la fase build, que se lanza
   * desde la aprobación, lo necesita para verificar al ancho que miraba (Q6; v0 previewViewport por mensaje). */
  viewport?: Viewport;
  /** La pregunta de un follow-up que no editó (#402): su `commit` es el del padre y no hay versión propia. */
  asked?: string;
  /** Variante de un grupo (S5): chat propio (ws = su id) bifurcado de la versión `parentId`. */
  variantOf?: { groupId: string; index: number; count: number };
  /** Lo que la variante en cola necesita para relanzarse tras reiniciar y no está en el resto de la entrada (R3.2). */
  variantRun?: Pick<RunInput, 'imageGeneration' | 'thinking'>;
  /** Desenlace (ADR 0013, regla común 3), el mismo que lleva su message.end. */
  outcome?: Outcome;
  /** Cuándo end() escribió ese desenlace: recover lo reemite tal cual si el proceso cayó entre el índice y el message.end,
   * y solo si es posterior al último message.start (un plan asked cuyo build cayó no cuenta). */
  endedAt?: number;
  /** La cerró recover: estaba viva cuando cayó el transport (ADR 0013 D2). */
  interrupted?: true;
  /** Tiene versión y sesión del CLI: POST /runs {parentId, continue: true} la sigue (R2.6). */
  continuable?: boolean;
  /** Solo del server, nunca sale al builder: la sesión del CLI con que se continúa. Se fija una vez (al cerrar o en recover):
   * `.wt` la reescribe la siguiente corrida del workspace. */
  sessionId?: string;
  /** Esta corrida continúa a `continueOf`; `continued`, la continuación ya lanzada (una por interrupción). */
  continueOf?: string;
  continued?: string;
  /** Corridas sin agente: recover las descarta a medio aplicar en vez de guardar lo escrito (nosotros.md §7.9). */
  kind?: 'patch' | 'direct-edit' | 'restore';
  /** Editar con IA por la vía de parche (H5): si se resolvió con ops o por qué volvió al turno, para medir la tasa. */
  patchAi?: { route: 'patch' | 'full'; reason?: string };
}

export type AutoRepairKind = 'runtime';
export const isRepairEntry = (e: MessageEntry): boolean => Boolean(e.runtimeRepair);

export const TITLE_MAX = 72;
export const titleOf = (prompt: string): string => {
  const line = prompt.trim().split('\n')[0];
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

export function isIanaZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-CA', { timeZone }); return true; } catch { return false; }
}

/** AAAA-MM-DD de una fecha en una zona IANA. Sin zona, UTC del proceso, que es el comportamiento anterior (toISOString). El
 * llamador valida la zona al arrancar; aquí una zona inválida lanzaría RangeError. Se arma desde las partes y no del formato de
 * un locale (en-CA daba AAAA-MM-DD, pero ICU no lo garantiza); si algo no cuadra, cae a UTC y no a una fecha mal formada. */
export function isoDateInTz(date: Date, timeZone?: string): string {
  const utc = date.toISOString().slice(0, 10);
  if (!timeZone) return utc;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const iso = `${part('year')}-${part('month')}-${part('day')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : utc;
}

// El messageId es el ws, y el ws es el subdominio del origen del preview (R5.5): tiene que ser una etiqueta DNS válida
// (minúsculas, dígitos y guion, hasta 63; RFC 1035 §2.3.4), o su Host no resolvería al workspace.
export const MESSAGE_ID = /^[a-z0-9-]{1,63}$/;
/** Marcador de install (R1.3): existe cuando `bun install` terminó, para no arrancar vite a mitad del pre-bundle. Aquí y no
 * en preview-dist para que run-checks no dependa de un colaborador. */
// Vive en el plugin de reinicio: el config de vite del preview lo importa y no puede cargar este módulo (deps del transport).
export { INSTALLED_MARK } from './wt-deps-restart-plugin';
/** Config de vite del transport (puentes del scaffold actual): la usan el preview y el build de versión. */
export const PREVIEW_VITE_CONFIG = fileURLToPath(new URL('./preview-vite.config.ts', import.meta.url));
/** El build de una versión: con el config del transport, el dist estático lleva los mismos puentes que el preview. */
export const VERSION_BUILD: readonly string[] = ['bunx', 'vite', 'build', '--config', PREVIEW_VITE_CONFIG, '--logLevel', 'error'];
export const PAGE_FILE = 'page.json';
// Las reglas viajan con la versión: un follow-up las hereda del commit del padre y quedan en el diff.
/** Un turno de plan lleva el commit del padre (keepPlan) y no es versión propia hasta que su fase build commitea: ni el
 * picker ni el padre de un restore lo cuentan. Contra el commit del padre y no con una marca `built`: así cubre también
 * el build que falló, el Stop y la caída, donde nadie escribiría la marca. */
export const planOnly = (e: Pick<MessageEntry, 'plan' | 'commit'>, parentCommit: string | undefined): boolean =>
  e.plan !== undefined && (e.plan.status !== 'approved' || e.commit === parentCommit);

export const INSTRUCTIONS_FILE = 'instructions.json';
// El pedido completo de cada versión, para poder re-correr una página: el título del índice va
// truncado y el prompt no quedaba en ningún otro lado. Sin credenciales: solo lo que mandó el cliente
// y el pin del registry.
export const REQUEST_FILE = 'request.json';
export const MAX_INSTRUCTIONS = 10;
export const MAX_INSTRUCTION_CHARS = 4000;
export const PAGE_PATHS = ['src/sections', 'src/App.tsx', PAGE_FILE];

/** Desenlace por defecto de cada cierre; los que no siguen esta tabla (pregunta, failed con versión) lo dicen explícito. */
export const OUTCOME_OF: Record<FinishReason, Outcome> = { stop: 'ok', patch: 'ok', restore: 'ok', stopped: 'stopped', error: 'failed' };

/** La sesión del CLI de la corrida que arrancó en `since`: el último system.init del stream crudo (.wt). Se lee una sola vez,
 * al cerrar o en recover: la corrida siguiente del workspace agrega el suyo al mismo archivo (Arq, R2.6). */
export function lastSessionId(dir: string, since: number): string | undefined {
  const file = join(dir, AGENT_STREAM_FILE);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const e = JSON.parse(lines[i] as string) as { type?: unknown; subtype?: unknown; session_id?: unknown; wt_at?: unknown };
      if (typeof e.wt_at === 'number' && e.wt_at < since) return undefined;
      if (e.type === 'system' && e.subtype === 'init' && typeof e.session_id === 'string') return e.session_id;
    } catch {
      // una línea cortada por la caída no corta la búsqueda
    }
  }
  return undefined;
}

export interface LiveTurn { messageId: string; steer: Steer; log: EventLog; steers: number }

// HACK: un techo fijo para install y build. Antes no había ninguno (spawnSync sin timeout, auditoría #9); un techo por
// comando cuando el banco mida installs o builds que lo rocen.
export const SH_TIMEOUT_MS = 300_000;

/** Un paso bash del transport (install, build) sin bloquear el event loop de los demás chats (auditoría #9). */
export async function sh(log: EventLog, stepId: string, labels: [string, string], cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  const command = [cmd, ...args].join(' ');
  log.emit({ type: 'step.start', stepId, kind: 'bash', label: labels[0] });
  try {
    // `vite build` corre el vite.config que escribió el agente: sin filtrar, leería las credenciales del transport.
    const r = await runCommand(cmd, args, { cwd, env: agentEnv(process.env), timeoutMs: SH_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    const detail = { kind: 'bash' as const, command, exitCode: r.code ?? -1 };
    if (r.aborted) throw new StepError(`${command}: la corrida se detuvo`, detail);
    if (r.timedOut) throw new StepError(`${command}: sin terminar en ${SH_TIMEOUT_MS / 1000} s`, detail);
    if (r.code !== 0) throw new StepError(`${command} falló (exit ${r.code}): ${r.stderr.slice(-400)}`, detail);
    log.emit({ type: 'step.end', stepId, label: labels[1], status: 'ok', detail });
  } catch (e) {
    log.emit({ type: 'step.end', stepId, label: labels[1], status: 'error', ...(e instanceof StepError ? { detail: e.detail } : {}), error: { type: 'execution-error', message: e instanceof Error ? e.message : String(e) } });
    throw e;
  }
}

/** Paso asíncrono del transport. Sin `shown`, el paso siempre existe y su step.start sale ANTES de correr `fn`: con un tsc
 * de 13 s dentro (replaceImage, sectionOp), emitir los dos al final dejaba al builder sin nada que pintar (QA unidad 3).
 * Con `shown`, solo aparece si dice que hizo algo, así que no hay start hasta el final: una página sin imágenes del CDN
 * no debe pintar un "Saved images" vacío. Un fallo se muestra siempre. */
export async function stepAsync<T>(log: EventLog, stepId: string, [start, end]: [string, string], fn: () => Promise<{ value: T; detail: { kind: 'action'; name: string; summary: string } }>, shown?: (v: T) => boolean): Promise<T> {
  const eager = shown === undefined;
  if (eager) log.emit({ type: 'step.start', stepId, kind: 'action', label: start });
  try {
    const { value, detail } = await fn();
    if (eager || shown(value)) {
      if (!eager) log.emit({ type: 'step.start', stepId, kind: 'action', label: start });
      log.emit({ type: 'step.end', stepId, label: end, status: 'ok', detail });
    }
    return value;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!eager) log.emit({ type: 'step.start', stepId, kind: 'action', label: start });
    log.emit({ type: 'step.end', stepId, label: `${start} failed`, status: 'error', error: { type: 'execution-error', message } });
    throw e;
  }
}

export function parseInstructions(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_INSTRUCTIONS) throw new HttpError(400, `instructions debe ser un array de hasta ${MAX_INSTRUCTIONS} strings`);
  return v.map((r) => {
    if (typeof r !== 'string' || !r.trim() || r.length > MAX_INSTRUCTION_CHARS) throw new HttpError(400, `cada instruction es un string no vacío de hasta ${MAX_INSTRUCTION_CHARS} caracteres`);
    return r;
  });
}
