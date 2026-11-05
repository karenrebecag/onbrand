// El MCP del workspace del agente y las aprobaciones de una corrida: la permission-prompt-tool (openApprovals/
// approvalRequest), el proxy de conectores (connectorForward), el servidor /mcp del workspace (workspaceMcp/
// workspaceToolContext/cappedImage), la decisión de la tarjeta (approvalDecision) y el ciclo del plan diferido
// (planReady/decidePlan/writePlanEdit/cancelPlan). Es `agent.*`, la capa que atiende al CLI mientras corre; el ciclo de la
// corrida (run/materialize) y lo que arranca una corrida (resumePlanBuild) viven en transport.ts y entran por deps.
// Paso de la modularización de transport.ts: código y comentarios idénticos, solo `this.x` → `this.deps.x`.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { openEventLog, readEvents, type EventLog } from './events';
import { HttpError, readBody } from './http';
import { alwaysRemote } from './always-remote';
import { approvalLink } from './approval-link';
import { Approvals, DecisionError, SPEND_TOOLS, type ApprovalCard, type ApprovalEndpoint, type PermissionAsk, type PermissionMode } from './approvals';
import { EXIT_PLAN_TOOL, EXIT_PLAN_TOOL_DEF, EXIT_PLAN_TOOL_FULL, parsePlanExit, planPathFor, validatePlanFile } from './plan-exit';
import { mergePlanEdit } from './plan-edit';
import { parseJsonRpc, type ConnectorMcp } from './connector-mcp';
import { type ConnectorsRun } from './connectors';
import { runWorkspaceTool, WORKSPACE_TOOL_DEFS, type WorkspaceToolContext } from './workspace-tools';
import { gatewayImageGen, imageProvider } from './image-step';
import { EDIT_IMAGE_DEF, gatewayImageEdit, IMAGE_TOOL_DEF } from './image-tool';
import { MCP_SERVER, toMcpContent } from './workspace-mcp';
import { TOOL_DEADLINES } from './tool-watchdog';
import { REMEMBER_DEF, REMEMBER_TOOL, rememberFact } from './memory-tool';
import type { BrandStore } from './brand-store';
import { agentDescribe, reasonOf, type MessageEntry, type RuntimeOptions } from './shared';
import type { Viewport } from './follow-up-context';
import { parseViewport } from './run-input';
import { LOCAL_OWNER, scopeDenied, type Scope } from './session';

/** JSON con claves ordenadas: el mismo input da la misma clave venga de la tarjeta o del tools/call. */
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null');

const allowanceKey = (tool: string, input: unknown): string => `${tool}\u0000${canonical(input)}`;

const CONNECTOR_METHODS = new Set(['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list', 'tools/call']);

/** Lo que este módulo necesita de transport: las opciones, el store de aprobaciones, el puerto (se fija al escuchar) y
 * los accesos al índice y al workspace. `startPlanBuild` arranca la fase build, que vive en transport porque necesita run(). */
export interface AgentMcpDeps {
  opts: RuntimeOptions;
  logDir: string;
  approvals: Approvals;
  port: () => number | undefined;
  wsDir: (ws: string) => string;
  entry: (id: string) => Readonly<MessageEntry>;
  index: () => Readonly<Record<string, Readonly<MessageEntry>>>;
  cancels: Map<string, AbortController>;
  imageUse: Map<string, { attempts: number; made: number; inFlight: number }>;
  /** Única escritura del índice (ADR 0014 regla 3): Runtime fusiona el patch y guarda. */
  updateEntry: (id: string, patch: Partial<MessageEntry>) => void;
  /** `viewport`: el que trae la aprobación, que gana al guardado con el turno de plan. */
  startPlanBuild: (id: string, edited: boolean, viewport?: Viewport) => void;
  /** Precondiciones de la fase build sin efectos: decidePlan las exige antes de registrar el allow. Lanza 409/429. */
  assertCanBuildPlan: (id: string) => void;
  /** POST /runs: el reject con feedback abre por aquí el mensaje hijo que itera el plan (§5), sin duplicar sus reglas. */
  startTurn: (body: Record<string, unknown>) => Promise<{ messageId: string }>;
  /** Memoria de marca (M2): la tool `remember` lee y escribe por aquí. */
  brands: BrandStore;
  /** Fecha AAAA-MM-DD de la línea que `remember` guarda. */
  today: (messageId: string) => string;
}

type ImageService = NonNullable<RuntimeOptions['imageService']>;
/** Quién genera imágenes en la corrida: el servicio inyectado (puerto image del perfil) o el Gateway. Con cualquier otro proveedor, nadie: caer
 * a un CLI usaría la cuenta de un cliente de la máquina aunque imageProvider sea 'none'. */
export const imageServiceOf = (injected: ImageService | undefined, provider: string): ImageService | undefined =>
  injected ?? (provider === 'gateway' ? { gen: gatewayImageGen, edit: gatewayImageEdit } : undefined);

export class AgentMcp {
  private approvalRuns = new Map<string, { chat: string; messageId: string; mode: PermissionMode; phase: 'plan' | 'build'; log: EventLog; readOnly: ReadonlySet<string>; apps: ReadonlySet<string>; allowed: Map<string, number>; sessions: Map<string, string>; grants: Map<string, { callId: string; grant: string }>; firstTurn: boolean; imageModel?: string; viewport?: { width: number; height: number }; brand?: string; runToken?: string; closed?: boolean; toolChain?: Promise<unknown>; tools: AbortController }>();

  /** Feedback del reject en curso por mensaje del plan: start() cancela el plan pendiente vía cancelPlan, y con esto ese
   * cierre queda como el rechazo de la persona (con su texto) y no como un mensaje nuevo que lo reemplazó. */
  private rejecting = new Map<string, string>();

  constructor(private deps: AgentMcpDeps) {}

  /** Registra la corrida para la permission-prompt-tool. Sin puerto conocido (transport sin listen, tests) no hay a
   * dónde pedir y el agente corre sin aprobación: lo que no está permitido se deniega como siempre. */
  /** `readOnly`: las lecturas que declararon las apps de ESTA corrida. Por corrida y no del proceso: una tool que dejó de
   * marcarse como lectura, o una app desconectada, no queda aprobada para otros chats. */
  openApprovals(messageId: string, chat: string, log: EventLog, connected: ConnectorMcp, firstTurn: boolean, imageModel?: string, phase: 'plan' | 'build' = 'build', viewport?: { width: number; height: number }, brand?: string, runToken?: string): { endpoint: ApprovalEndpoint; close: () => void } | undefined {
    if (this.deps.port() === undefined) return undefined;
    const token = crypto.randomUUID();
    // La señal de las tools in-process: cae con el cancel de la corrida y con el cierre del turno (close), así una tool del
    // /mcp no sigue gastando ni escribiendo detrás de un CLI que ya no la espera (auditoría #5).
    const tools = new AbortController();
    const cancel = this.deps.cancels.get(messageId)?.signal;
    const onCancel = (): void => tools.abort();
    cancel?.addEventListener('abort', onCancel, { once: true });
    this.approvalRuns.set(token, { chat, messageId, mode: this.deps.index()[messageId].permissionMode ?? 'ask', phase, log, readOnly: new Set([...(this.deps.opts.readOnlyTools ?? []), ...connected.readOnlyTools]), apps: new Set(connected.apps), allowed: new Map(), sessions: new Map(), grants: new Map(), firstTurn, ...(imageModel ? { imageModel } : {}), ...(viewport ? { viewport } : {}), ...(brand ? { brand } : {}), ...(runToken ? { runToken } : {}), tools });
    return {
      endpoint: { url: `http://127.0.0.1:${this.deps.port()}/approval-requests`, token },
      close: () => {
        // Una tool del /mcp en vuelo (generar imagen tarda segundos) no escribe en el workspace de una corrida cerrada.
        const run = this.approvalRuns.get(token);
        if (run) run.closed = true;
        tools.abort();
        cancel?.removeEventListener('abort', onCancel);
        this.approvalRuns.delete(token);
        this.deps.approvals.cancelChat(chat);
      },
    };
  }

  /** POST /approval-requests: lo llama approval-mcp desde el CLI y espera la decisión. */
  async approvalRequest(req: IncomingMessage): Promise<unknown> {
    const token = req.headers['x-wt-approval-token'];
    const run = typeof token === 'string' ? this.approvalRuns.get(token) : undefined;
    if (!run) throw new HttpError(403, 'token de aprobación inválido');
    const b = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    if (typeof b.tool_name !== 'string' || typeof b.tool_use_id !== 'string' || !b.tool_use_id) throw new HttpError(400, 'faltan tool_name y tool_use_id');
    const ask: PermissionAsk = { tool_name: b.tool_name, input: b.input ?? {}, tool_use_id: b.tool_use_id };
    const reply = await this.deps.approvals.ask(run.chat, run.mode, run.readOnly, ask, {
      request: (r) => run.log.emit({ type: 'approval.request', ...r }),
      decision: (callId, decision, scope) => run.log.emit({ type: 'approval.decision', callId, decision, ...(scope ? { scope } : {}) }),
    }, reasonOf(readEvents(this.deps.logDir, run.messageId).events), run.firstTurn, run.phase === 'plan' ? { dir: this.deps.wsDir(run.chat), path: planPathFor(run.messageId) } : undefined, alwaysRemote(process.env, run.runToken), approvalLink(process.env, run.runToken));
    if (reply.behavior === 'allow') {
      const key = allowanceKey(ask.tool_name, ask.input);
      run.allowed.set(key, (run.allowed.get(key) ?? 0) + 1);
      // El permiso firmado de esta llamada viaja con ella hasta el orquestador (spec §8.1).
      const grant = this.deps.approvals.takeGrantFor(ask.tool_use_id);
      if (grant) run.grants.set(key, { callId: ask.tool_use_id, grant });
    }
    return reply;
  }

  /** POST /connector-mcp/:slug: lo llama el proxy stdio del agente. El token de Pipedream solo existe aquí. Un tools/call
   * pasa solo si el guard de esta corrida lo aprobó: el token de la corrida no basta para saltarse la tarjeta. */
  async connectorForward(req: IncomingMessage, slug: string): Promise<unknown> {
    const token = req.headers['x-wt-approval-token'];
    const run = typeof token === 'string' ? this.approvalRuns.get(token) : undefined;
    if (!run) throw new HttpError(403, 'token de corrida inválido');
    const connectors = this.deps.opts.connectors ?? this.deps.opts.connectorsRemote;
    if (!run.apps.has(slug) || !connectors) throw new HttpError(403, 'app no conectada en esta corrida');
    const msg = (await readBody(req)) as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') throw new HttpError(400, 'mensaje JSON-RPC inválido');
    const id = msg.id;
    // resources/*, prompts/*, completion y demás no pasan por la tarjeta: solo lo que el CLI necesita para listar y llamar.
    if (!CONNECTOR_METHODS.has(msg.method)) return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `método ${msg.method} no permitido` } };
    let proof: { callId: string; grant: string } | undefined;
    if (msg.method === 'tools/call') {
      const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = typeof params.name === 'string' ? `mcp__${slug}__${params.name}` : '';
      // La aprobación es de esa tool CON esos argumentos: una tarjeta inocua no autoriza otra llamada.
      const key = allowanceKey(tool, params.arguments ?? {});
      const left = tool ? (run.allowed.get(key) ?? 0) : 0;
      if (!left) return { jsonrpc: '2.0', id, error: { code: -32001, message: `${tool || 'tool'} sin aprobación en esta corrida` } };
      run.allowed.set(key, left - 1);
      proof = run.grants.get(key);
      run.grants.delete(key);
    }
    let r: Awaited<ReturnType<ConnectorsRun['forward']>>;
    try {
      r = await connectors.forward(slug, msg, run.sessions.get(slug), run.runToken, proof);
    } catch (e) {
      return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32603, message: `conector ${slug}: ${e instanceof Error ? e.message : 'sin respuesta'}` } };
    }
    if (r.status === 404 || r.status === 410) run.sessions.delete(slug);
    else if (r.session) run.sessions.set(slug, r.session);
    if (id === undefined) return undefined;
    const raw: unknown = r.status >= 200 && r.status < 300 ? parseJsonRpc(r.text) : undefined;
    const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    // Solo result o error: lo demás que mande el upstream (method, params) no llega al CLI.
    if (parsed && 'result' in parsed) return { jsonrpc: '2.0', id, result: parsed.result };
    if (parsed && 'error' in parsed) return { jsonrpc: '2.0', id, error: parsed.error };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: `conector ${slug}: respondió ${r.status}` } };
  }

  /** /mcp/:messageId: el MCP del workspace del agente por Streamable HTTP, servido aquí y no en un proceso hijo con el env
   * del CLI. Como Lovable, donde cada tool es de una integración del backend que corre con las credenciales de la cuenta y
   * no en el sandbox (registry-CmMIU-Jy :4835-4866, integration "imagegen"): generate_image y edit_image usan la key u
   * OIDC de este proceso, que agentEnv le quita al CLI (#385). El token es el de la corrida y vale solo para su mensaje: si
   * el agente lo lee, puede lo mismo que ya puede (su workspace, con la tarjeta de siempre). Solo respuestas JSON: el GET
   * del stream SSE es 405, que la spec de Streamable HTTP permite al servidor que no lo ofrece. */
  async workspaceMcp(req: IncomingMessage, messageId: string): Promise<unknown> {
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const run = token ? this.approvalRuns.get(token) : undefined;
    if (!run || run.messageId !== messageId) throw new HttpError(401, 'token de corrida inválido');
    if (req.method !== 'POST') throw new HttpError(405, 'solo POST');
    const msg = (await readBody(req)) as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') throw new HttpError(400, 'mensaje JSON-RPC inválido');
    const id = msg.id;
    if (id === undefined) return undefined;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const ctx = this.workspaceToolContext(run);
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web-transformer-workspace', version: '1' } });
      case 'ping':
        return reply({});
      case 'tools/list': {
        // exit_plan_mode solo existe en la fase plan de ESTA corrida (no en la fase build del mismo mensaje, donde
        // index.mode sigue siendo 'plan'): la fase la lleva la corrida, no la entrada del índice.
        const planDef = run.phase === 'plan' ? [EXIT_PLAN_TOOL_DEF] : [];
        // remember solo existe con marca y FUERA de la fase plan: el plan es de solo lectura (escribe únicamente en
        // `.wt/plans/`), así que guardar memoria de marca es un efecto que no toca hasta la fase build.
        const brandDef = run.brand && run.phase !== 'plan' ? [REMEMBER_DEF] : [];
        const defs = [...WORKSPACE_TOOL_DEFS, ...planDef, ...brandDef, ...(ctx.imageGen ? [IMAGE_TOOL_DEF] : []), ...(ctx.imageEdit ? [EDIT_IMAGE_DEF] : [])];
        return reply({ tools: defs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = params.arguments ?? {};
        // Detenida la corrida, nada entra a la cola ni consume una aprobación.
        if (run.tools.signal.aborted) return reply({ content: [{ type: 'text', text: `${name}: la corrida se detuvo` }], isError: true });
        // exit_plan_mode (H6, §3): diferida. Valida contra el workspace, entrega el plan a Approvals y responde sin bloquear;
        // la decisión llega aparte. No pasa por runWorkspaceTool.
        if (name === EXIT_PLAN_TOOL) {
          if (run.phase !== 'plan') return reply({ content: [{ type: 'text', text: `${EXIT_PLAN_TOOL}: solo existe en modo plan` }], isError: true });
          const parsed = parsePlanExit(args);
          if (!parsed.ok) return reply({ content: [{ type: 'text', text: parsed.error }], isError: true });
          const valid = validatePlanFile(parsed.value, { dir: this.deps.wsDir(run.chat), messageId });
          if (!valid.ok) return reply({ content: [{ type: 'text', text: valid.error }], isError: true });
          return reply(this.planReady(run, parsed.value));
        }
        // remember (M2, §1): escribe la memoria de la marca de la corrida y emite memory.write. No gasta ni pasa por la
        // tarjeta (solo toca el archivo de la marca), así que no entra a runWorkspaceTool; los topes y el filtro de datos
        // personales los aplica rememberFact con memory-edit. Sin marca no se ofrece en tools/list, pero se cubre igual;
        // en fase plan tampoco escribe (read-only). withMemory serializa contra el PUT y otras corridas de la misma marca.
        if (name === REMEMBER_TOOL) {
          if (!run.brand) return reply({ content: [{ type: 'text', text: `${REMEMBER_TOOL}: solo existe con una marca` }], isError: true });
          if (run.phase === 'plan') return reply({ content: [{ type: 'text', text: `${REMEMBER_TOOL}: no disponible en modo plan; la memoria se guarda al ejecutar el plan` }], isError: true });
          const brand = run.brand;
          // La memoria que escribe el agente es la del dueño del chat, no la de la sesión: el CLI llama sin sesión.
          const owner = this.deps.index()[run.messageId]?.owner ?? LOCAL_OWNER;
          let outcome: ReturnType<typeof rememberFact>;
          try {
            outcome = await this.deps.brands.withMemory(owner, brand, (current) => {
              const o = rememberFact(current, args, { messageId: run.messageId, date: this.deps.today(run.messageId) });
              if (o.ok && o.added) this.deps.brands.writeMemory(owner, brand, o.text);
              return o;
            });
          } catch (e) {
            // Un fallo al escribir (disco lleno, permisos) sale como error de tool, no como error HTTP del /mcp: el CLI lo
            // trata como los demás fallos de tool en vez de cortar el turno. Al modelo solo el errno (ENOSPC, EACCES…), no
            // la ruta absoluta del .tmp; el detalle completo va al log del proceso.
            console.error(`remember: fallo al escribir la memoria de ${brand}:`, e);
            const code = (e as { code?: string }).code ?? 'error de disco';
            return reply({ content: [{ type: 'text', text: `${REMEMBER_TOOL}: no se pudo guardar la memoria (${code})` }], isError: true });
          }
          if (!outcome.ok) return reply({ content: [{ type: 'text', text: outcome.reply }], isError: true });
          if (outcome.added) run.log.emit({ type: 'memory.write', fact: outcome.fact, ...(outcome.replaced ? { replaced: outcome.replaced } : {}) });
          return reply({ content: [{ type: 'text', text: outcome.reply }] });
        }
        // Lo que gasta pasa solo con la aprobación de esa tool con esos argumentos, y la consume: el token no alcanza para
        // llamar aquí sin la tarjeta (mismo criterio que connectorForward).
        const tool = `mcp__${MCP_SERVER}__${name}`;
        if (SPEND_TOOLS.has(tool)) {
          const key = allowanceKey(tool, args);
          const left = run.allowed.get(key) ?? 0;
          if (!left) return reply({ content: [{ type: 'text', text: `${name} sin aprobación en esta corrida` }], isError: true });
          run.allowed.set(key, left - 1);
        }
        // Una tool a la vez por corrida, como el servidor stdio que atendía línea por línea: el CLI puede pedir varias en
        // paralelo y aquí cada una es tsc, chromium o el proveedor de imagen dentro del proceso que sirve todos los chats.
        // Tope por llamada con el mismo plazo que el watchdog del CLI (tool-watchdog.ts TOOL_DEADLINES), contado desde que
        // llega como el del CLI cuenta desde el tool_use. En modo HTTP no hay servidor `wt` que matar (killWorkspaceMcp sin
        // pidfile no hace nada, auditoría #7): la tool se corta por su señal y el CLI recibe un error de tool en vez de que
        // el watchdog termine cortando el turno entero.
        const call = new AbortController();
        const cut = (): void => call.abort();
        run.tools.signal.addEventListener('abort', cut, { once: true });
        const limit = (this.deps.opts.toolDeadlines ?? TOOL_DEADLINES)[tool];
        let late = false;
        const timer = limit ? setTimeout(() => { late = true; cut(); }, limit) : undefined;
        try {
          const prev = run.toolChain ?? Promise.resolve();
          const current = prev.catch(() => undefined).then(() => runWorkspaceTool(name, args, { ...ctx, signal: call.signal }));
          run.toolChain = current;
          // La respuesta no espera a una tool que no atiende su señal: el CLI recibe el error al vencer el plazo.
          const stopped = new Promise<null>((r) => { if (call.signal.aborted) r(null); else call.signal.addEventListener('abort', () => r(null), { once: true }); });
          const r = await Promise.race([current, stopped]);
          if (late) return reply({ content: [{ type: 'text', text: `${name}: sin respuesta en ${Math.round((limit as number) / 1000)} s; se cortó, vuelve a llamar` }], isError: true });
          if (!r) return reply({ content: [{ type: 'text', text: `${name}: la corrida se detuvo` }], isError: true });
          return reply(r.ok ? { content: toMcpContent(r.content) } : { content: [{ type: 'text', text: r.error }], isError: true });
        } finally {
          clearTimeout(timer);
          run.tools.signal.removeEventListener('abort', cut);
        }
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `método ${msg.method} no soportado` } };
    }
  }

  /** Lo mismo que el workspace-mcp stdio le daba a cada tool, resuelto con el workspace de la corrida. */
  private workspaceToolContext(run: { chat: string; messageId: string; imageModel?: string; closed?: boolean; tools?: AbortController; viewport?: { width: number; height: number } }): WorkspaceToolContext {
    const dir = this.deps.wsDir(run.chat);
    const previews = this.deps.opts.previews;
    const service = imageServiceOf(this.deps.opts.imageService, imageProvider());
    const open = <T>(v: T): T => { if (run.closed) throw new Error('la corrida terminó: la imagen no se guarda'); return v; };
    const gen = run.imageModel && service ? service.gen(run.imageModel) : undefined;
    const edit = run.imageModel && service?.edit ? service.edit(run.imageModel) : undefined;
    return {
      dir,
      previews: { ensure: async (d) => { if (!previews) throw new Error('este transport no tiene preview'); return previews.ensure(d); }, ...(previews ? { drainErrors: (d: string) => previews.drainErrors(d) } : {}) },
      ...(this.deps.opts.tsc ? { tsc: this.deps.opts.tsc } : {}),
      describe: this.deps.opts.agentDescribe ?? agentDescribe(),
      ...(gen ? { imageGen: async (prompt, size, signal) => open(await this.cappedImage(run.messageId, () => gen(prompt, size, signal))) } : {}),
      ...(edit ? { imageEdit: async (req) => open(await edit(req)) } : {}),
      ...(run.tools ? { signal: run.tools.signal } : {}),
      // Q6: `browser` sin viewport mide a lo que la persona mira; el viewport viaja con el request de la corrida.
      ...(run.viewport ? { viewport: run.viewport } : {}),
    };
  }

  /** Con imagesPerRun, cada mensaje (turno, no página: un follow-up cuenta aparte) admite ese número de imágenes y un solo
   * reintento si una llamada falló (cuota, red). Se decide antes de llamar al generador: una llamada rechazada no gasta.
   * inFlight cubre los tool_use paralelos del CLI: dos generate_image a la vez no pasan las dos con cap 1. */
  private async cappedImage<T>(messageId: string, call: () => Promise<T>): Promise<T> {
    const cap = this.deps.opts.imagesPerRun;
    if (cap === undefined) return call();
    const use = this.deps.imageUse.get(messageId) ?? { attempts: 0, made: 0, inFlight: 0 };
    if (use.made + use.inFlight >= cap || use.attempts > cap) throw new Error(`este mensaje admite ${cap} imagen${cap === 1 ? '' : 'es'} generada${cap === 1 ? '' : 's'} y ya se usó; esta sección va con el producto en código, sin <img>`);
    this.deps.imageUse.set(messageId, { ...use, attempts: use.attempts + 1, inFlight: use.inFlight + 1 });
    let ok = false;
    try {
      const out = await call();
      ok = true;
      return out;
    } finally {
      const now = this.deps.imageUse.get(messageId);
      if (now) this.deps.imageUse.set(messageId, { ...now, inFlight: now.inFlight - 1, made: now.made + (ok ? 1 : 0) });
    }
  }

  /** Los ws de un chat: el suyo y el de cada variante cuyo origen es de ese chat (mismo criterio que server.ts inChat). */
  private chatWs(ws: string): ReadonlySet<string> {
    const index = this.deps.index();
    return new Set([ws, ...Object.values(index).filter((e) => e.variantOf && e.parentId !== undefined && index[e.parentId]?.ws === ws).map((e) => e.ws)]);
  }

  /** POST /chats/:id/approvals/:callId. `:id` es cualquier mensaje del hilo: el chat es su workspace. La decisión del plan
   * (H6) entra por aquí con approve|reject|edit y va a decidePlan; el resto son las tarjetas de siempre (allow|always|skip). */
  async approvalDecision(req: IncomingMessage, id: string, callId: string, scopes: ReadonlySet<Scope>): Promise<unknown> {
    if (!this.deps.opts.agent) throw new HttpError(404, 'este transport no pide aprobaciones');
    const entry = this.deps.entry(id);
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    // El builder manda el chat como :id (la base /chats/:id, spec §1.1), no el mensaje del plan, que en un follow-up o en una
    // variante es otro. El plan se ubica por callId entre los ws del chat (el suyo y los de sus variantes); :id solo fija el
    // chat. Sin esto, la decisión de un plan de follow-up caía a la rama de tarjetas y daba 400.
    const wss = this.chatWs(entry.ws);
    const planHit = Object.entries(this.deps.index()).find(([, e]) => wss.has(e.ws) && e.plan?.callId === callId);
    if (planHit) return this.decidePlan(planHit[0], planHit[1], planHit[1].plan as NonNullable<MessageEntry['plan']>, body);
    // Ni plan ni tarjeta con ese callId en este chat: 404 explícito, en vez de caer a la validación del cuerpo y devolver
    // un 400 "decision debe ser allow|always|skip" engañoso (p. ej. un callId de plan de otro chat).
    const ws = [...wss].find((w) => this.deps.approvals.knows(w, callId));
    if (ws === undefined) throw new HttpError(404, `no hay plan ni aprobación con callId ${callId} en este chat`);
    const { decision } = body as { decision?: unknown };
    if (decision !== 'allow' && decision !== 'always' && decision !== 'skip') throw new HttpError(400, 'decision debe ser allow|always|skip');
    // Aprobar una tool de gasto (allow o "siempre", que además queda pre-autorizado para las sesiones con spend del dueño) exige spend.
    const tool = this.deps.approvals.pendingTool(ws, callId);
    if (decision !== 'skip' && tool !== undefined && SPEND_TOOLS.has(tool) && !scopes.has('spend')) throw scopeDenied();
    try {
      const { always } = this.deps.approvals.decide(ws, callId, decision);
      return { ok: true, ...(always ? { always } : {}) };
    } catch (e) {
      if (e instanceof DecisionError) throw new HttpError(e.status, e.message);
      throw e;
    }
  }

  /** GET /chats/:id/approvals/:callId: la tarjeta de aprobación, una sola fuente para el builder (misma forma que el
   * orquestador, routes.ts pendingView), también en local. callId se ubica entre los ws del chat (el suyo y sus variantes,
   * como approvalDecision); 404 con el mismo texto que un callId inexistente si no está, es de otro chat o venció. */
  approvalCard(id: string, callId: string): ApprovalCard {
    const missing = (): never => { throw new HttpError(404, `no hay aprobación con callId ${callId} en este chat`, { code: 'not-found' }); };
    if (!this.deps.opts.agent) return missing();
    for (const ws of this.chatWs(this.deps.entry(id).ws)) {
      const card = this.deps.approvals.pendingView(ws, callId);
      if (card) return card;
    }
    return missing();
  }

  /** GET /chats/:chat/plans/:messageId: el plan vivo de un mensaje (el `.wt/plans/<id>.md`, que un PUT de borrador puede
   * haber editado) y si difiere del original congelado del agente (`edited`). El builder lo pide para pintar la tarjeta y
   * recuperar el borrador al recargar (run-client fetchPlan). 404 si ese mensaje no tiene plan o si :chat es de otro ws. */
  getPlan(chat: string, id: string): { plan: string; edited?: true } {
    if (!this.deps.opts.agent) throw new HttpError(404, 'este transport no tiene modo plan');
    const entry = this.deps.entry(id);
    // :chat tiene que ser del mismo workspace que el mensaje del plan; si no, es otro chat y no ve este plan.
    // El mismo texto que un id inexistente: el id de otro chat no se confirma (identidad §5).
    if (!this.chatWs(this.deps.entry(chat).ws).has(entry.ws)) throw new HttpError(404, `no hay mensaje ${id}`);
    const plan = entry.plan;
    if (!plan) throw new HttpError(404, `el mensaje ${id} no tiene plan`);
    const dir = this.deps.wsDir(entry.ws);
    const live = existsSync(join(dir, plan.path)) ? readFileSync(join(dir, plan.path), 'utf8') : '';
    const agentCopy = join(dir, planPathFor(id).replace(/\.md$/, '.agent.md'));
    const edited = existsSync(agentCopy) && readFileSync(agentCopy, 'utf8') !== live;
    return { plan: live, ...(edited ? { edited: true as const } : {}) };
  }

  /** `exit_plan_mode` (diferida, §3): la llama workspaceMcp al validar el plan. Congela el original del agente para el diff
   * de la edición, emite la tarjeta del plan y lo deja pendiente en el índice. Devuelve el content con el callId, que el
   * composer lee para cerrar el turno. No bloquea: la decisión llega aparte por POST /chats/:chat/approvals/:callId. */
  private planReady(run: { chat: string; messageId: string; log: EventLog }, value: { planPath: string; summary: string }): { content: { type: 'text'; text: string }[] } {
    const dir = this.deps.wsDir(run.chat);
    // El original del agente sobrevive a los borradores de la edición: el diff es siempre contra él (spec §3 Edición).
    copyFileSync(join(dir, value.planPath), join(dir, planPathFor(run.messageId).replace(/\.md$/, '.agent.md')));
    const callId = crypto.randomUUID();
    const reason = reasonOf(readEvents(this.deps.logDir, run.messageId).events);
    const planText = readFileSync(join(dir, value.planPath), 'utf8');
    // El pendiente antes del aviso: si el proceso cae entre los dos, el log no anuncia un plan que el índice no tiene y la
    // decisión de la tarjeta encuentra su plan al reiniciar.
    this.deps.updateEntry(run.messageId, { plan: { callId, path: value.planPath, summary: value.summary, status: 'pending' } });
    run.log.emit({ type: 'approval.request', callId, toolName: EXIT_PLAN_TOOL_FULL, app: 'wt', kind: 'plan', ...(reason ? { reason } : {}), input: { planPath: value.planPath, summary: value.summary, plan: planText } });
    run.log.emit({ type: 'plan.ready', callId, path: value.planPath, summary: value.summary });
    return { content: [{ type: 'text', text: `Plan enviado: la persona lo aprueba, lo edita o lo rechaza. Termina el turno sin escribir nada más.\ncallId: ${callId}` }] };
  }

  /** Cancela un plan pendiente sin decisión de la persona: un mensaje nuevo (§5) o POST /runs/:id/cancel. Deja el estado en
   * `cancelled` y registra la decisión omitida con su motivo. */
  cancelPlan(id: string, entry: Readonly<MessageEntry>, reason: 'user-message' | 'stopped', log = openEventLog(this.deps.logDir, id)): void {
    const plan = entry.plan;
    if (!plan || plan.status !== 'pending') return;
    const feedback = reason === 'user-message' ? this.rejecting.get(id) : undefined;
    if (feedback !== undefined) return this.reject(id, plan, log, feedback);
    this.deps.updateEntry(id, { plan: { ...plan, status: 'cancelled' } });
    log.emit({ type: 'approval.decision', callId: plan.callId, decision: 'skip', reason });
    log.emit({ type: 'plan.cancelled', callId: plan.callId, reason });
  }

  private reject(id: string, plan: NonNullable<MessageEntry['plan']>, log: EventLog, feedback?: string): void {
    this.deps.updateEntry(id, { plan: { ...plan, status: 'rejected' } });
    log.emit({ type: 'approval.decision', callId: plan.callId, decision: 'skip' });
    log.emit({ type: 'plan.cancelled', callId: plan.callId, reason: 'rejected', ...(feedback ? { feedback } : {}) });
  }

  /** Decisión del plan (§3), por la misma ruta que las aprobaciones. approve/edit reanudan la sesión en fase build sobre el
   * mismo mensaje; reject lo cierra sin versión y, con feedback, abre un mensaje hijo en plan que reanuda la sesión del
   * plan con ese texto. edit fusiona el texto con las líneas `usuario:` (ec) y lo escribe antes. */
  private async decidePlan(id: string, entry: Readonly<MessageEntry>, plan: NonNullable<MessageEntry['plan']>, body: Record<string, unknown>): Promise<{ ok: true; messageId?: string }> {
    if (plan.status !== 'pending') throw new HttpError(409, `el plan de ${id} ya se ${plan.status}`, { code: 'plan-decided' });
    const decision = body.decision;
    if (decision === 'reject') {
      if (body.feedback !== undefined && typeof body.feedback !== 'string') throw new HttpError(400, 'feedback tiene que ser texto');
      const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
      if (!feedback) {
        this.reject(id, plan, openEventLog(this.deps.logDir, id));
        return { ok: true };
      }
      // Si el hijo no puede arrancar, 409/429 como approve y el plan sigue pendiente: no se rechaza perdiendo el feedback
      // (docs/spec/plan-mode.md "Rechazar con feedback", paso 2).
      this.deps.assertCanBuildPlan(id);
      this.rejecting.set(id, feedback);
      try {
        const { messageId } = await this.deps.startTurn({ parentId: id, prompt: feedback, mode: 'plan', ...(entry.model ? { model: entry.model } : {}) });
        return { ok: true, messageId };
      } finally {
        this.rejecting.delete(id);
      }
    }
    const log = openEventLog(this.deps.logDir, id);
    // La fase build se valida ANTES de registrar el allow: si no puede arrancar (sin sesión que reanudar, workspace ocupado
    // 409, tope de corridas 429), el plan sigue `pending`, el texto editado no se escribe y el log no anuncia un allow que no ejecutó nada. El emit va antes
    // de startPlanBuild a propósito: la fase build abre su propio EventLog del mismo mensaje, y emitir después colisionaría
    // el seq (su `next` se calcula del archivo antes de que este emit llegue a disco).
    if (decision === 'edit') {
      if (typeof body.plan !== 'string') throw new HttpError(400, 'edit necesita el plan editado (texto)');
      const viewport = parseViewport(body.viewport);
      this.deps.assertCanBuildPlan(id);
      this.writePlanEdit(id, entry, plan, body.plan);
      log.emit({ type: 'approval.decision', callId: plan.callId, decision: 'allow' });
      this.deps.startPlanBuild(id, true, viewport);
      return { ok: true };
    }
    if (decision === 'approve') {
      const viewport = parseViewport(body.viewport);
      this.deps.assertCanBuildPlan(id);
      log.emit({ type: 'approval.decision', callId: plan.callId, decision: 'allow' });
      this.deps.startPlanBuild(id, false, viewport);
      return { ok: true };
    }
    throw new HttpError(400, 'decision debe ser approve|reject|edit');
  }

  /** Fusiona el texto editado con el original congelado y lo escribe en el plan vivo. El diff es contra `.agent.md`. */
  writePlanEdit(id: string, entry: Readonly<MessageEntry>, plan: NonNullable<MessageEntry['plan']>, edited: string): number {
    const dir = this.deps.wsDir(entry.ws);
    const agentCopy = join(dir, planPathFor(id).replace(/\.md$/, '.agent.md'));
    if (!existsSync(agentCopy)) throw new HttpError(409, `el plan de ${id} no tiene original congelado`, { code: 'plan-no-original' });
    const merged = mergePlanEdit(readFileSync(agentCopy, 'utf8'), edited);
    // Error tipado (spec §3): el `code` va en el cuerpo (details), para que la UI distinga too_large de duplicate_slug sin parsear el texto.
    if (!merged.ok) throw new HttpError(400, merged.message, { code: merged.code });
    writeFileSync(join(dir, plan.path), merged.plan);
    return merged.userLines;
  }
}
