"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ban, Check, ChevronDown, ListTodo, Timer, Wrench, X } from "lucide-react";
import { Button } from "../../button/button";
import { Textarea } from "../../textarea/textarea";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import type { ApprovalRecord, ToolApproval, ToolDecision } from "./agent-run-types";
import { AutoHeight, Collapse } from "./run-motion";
import { useRunSlots } from "./agent-run-slots";
import styles from "./agent-run.module.css";

export { kindInfo } from "./agent-run-slots";

// MediaGenerationApprovalCard de Lovable (transport/lovable/deob/MediaGenerationApprovalCard-HXgdcROo :148-157): título
// por tool, el prompt recortado a 200 caracteres con "View request" y la aclaración de que vale solo para esta imagen.
export const PROMPT_PREVIEW = 200;
export function promptPreview(input: unknown): { full: string; preview: string; clipped: boolean } {
  const full = typeof input === "object" && input !== null && typeof (input as { prompt?: unknown }).prompt === "string" ? (input as { prompt: string }).prompt : "";
  const flat = full.replace(/\s+/g, " ").trim();
  const clipped = flat.length > PROMPT_PREVIEW;
  return { full, preview: clipped ? `${flat.slice(0, PROMPT_PREVIEW).trimEnd()}…` : full, clipped };
}

const appName = (slug: string) => slug.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** `Dynamic(mcp__wt__generate_image)` se lee como `mcp__wt__generate_image`, como el chip de v0 (deobfuscated.js:35898-35955). */
export function patternLabel(pattern: string): string {
  const open = pattern.indexOf("(");
  if (open > 0 && pattern.endsWith(")") && /^\w+$/.test(pattern.slice(0, open)) && pattern.length - open > 2) return pattern.slice(open + 1, -1);
  return pattern;
}

/** El registro de la tarjeta (spec §8.1): mientras carga, o sin registro, no hay botones; la tarjeta no cae al evento de la VM. */
export type ApprovalRecordState = { status: "loading" } | { status: "ready"; record: ApprovalRecord } | { status: "missing"; text: string };

const slugOf = (tool: string) => /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool)?.[1];

/**
 * Una tool de conector que espera dentro del turno, con la anatomía del permission prompt de agent-approvals: la tool,
 * el motivo del agente y sus argumentos, y Omitir / Permitir. El turno sigue corriendo; la decisión que vale es la que
 * llega por el stream (approval.decision), no el clic, así que tras enviar la tarjeta espera en vez de darla por hecha.
 */
export interface LoadedPlan { plan: string; edited?: boolean }

export function ToolApprovalCard({ approval, onDecide, onRevoke, loadPlan, loadApproval, renderMarkdown, turnClosed = true }: { approval: ToolApproval; onDecide: (decision: ToolDecision) => Promise<void>; onRevoke?: (toolName: string) => Promise<void>; loadPlan?: () => Promise<LoadedPlan>; loadApproval?: () => Promise<ApprovalRecord>; renderMarkdown?: (markdown: string) => ReactNode; turnClosed?: boolean }) {
  if (approval.kind === "plan") return <PlanApprovalCard approval={approval} onDecide={onDecide} loadPlan={loadPlan} renderMarkdown={renderMarkdown} turnClosed={turnClosed} />;
  return <ConnectorApprovalCard approval={approval} onDecide={onDecide} onRevoke={onRevoke} loadApproval={loadApproval} />;
}

/** Con `loadApproval` la tarjeta pendiente se pinta desde el registro (una sola fuente con el permiso que se acuña). Una ya decidida
 * no lo pide: su registro vence a los 120 s y el veredicto llega por el stream. Sin `loadApproval` (la simulación de Arc) usa el evento. */
function ConnectorApprovalCard({ approval, onDecide, onRevoke, loadApproval }: { approval: ToolApproval; onDecide: (decision: ToolDecision) => Promise<void>; onRevoke?: (toolName: string) => Promise<void>; loadApproval?: () => Promise<ApprovalRecord> }) {
  const [record, setRecord] = useState<ApprovalRecordState | undefined>(loadApproval && !approval.decision ? { status: "loading" } : undefined);
  const load = useRef(loadApproval);
  load.current = loadApproval;
  const pending = !approval.decision;
  useEffect(() => {
    if (!load.current || !pending) return;
    let live = true;
    load.current().then(r => { if (live) setRecord({ status: "ready", record: r }); }, (e: unknown) => { if (live) setRecord({ status: "missing", text: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [pending, approval.callId]);
  return <ConnectorApprovalView approval={approval} record={record} fromEvent={!loadApproval} onDecide={onDecide} onRevoke={onRevoke} />;
}

export function ConnectorApprovalView({ approval, record, fromEvent, onDecide, onRevoke }: { approval: ToolApproval; record?: ApprovalRecordState; fromEvent: boolean; onDecide: (decision: ToolDecision) => Promise<void>; onRevoke?: (toolName: string) => Promise<void> }) {
  const argsId = useId();
  // Sin motivo (el CLI no lo pasa a la permission-prompt-tool) los argumentos son lo único que dice qué va a hacer.
  const [argsOpen, setArgsOpen] = useState(!approval.reason);
  const [sent, setSent] = useState<ToolDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestOpen, setRequestOpen] = useState(false);
  const { kind: kindSlot, copy } = useRunSlots();
  const kind = kindSlot(approval.kind);
  const spend = approval.kind === "spend";
  const rec = record?.status === "ready" ? record.record : undefined;
  // Lo que se muestra y se decide: el registro, o el evento solo cuando no hay registro que pedir (simulación).
  const toolName = rec?.tool ?? approval.toolName;
  const input = rec ? rec.input : fromEvent ? approval.input : undefined;
  const showInput = Boolean(rec) || fromEvent;
  const prompt = spend && showInput ? promptPreview(input) : null;
  const app = appName((rec && slugOf(rec.tool)) ?? approval.app);
  const remember = rec ? rec.rememberPatterns : [];
  const offerAlways = rec ? remember.length > 0 : fromEvent && spend;
  const blocked = record?.status === "loading" || record?.status === "missing" || Boolean(rec?.decision);

  const decide = (decision: ToolDecision) => {
    setSent(decision);
    setError(null);
    // El aviso de Lovable cuando falla el "always" (:186): se puede reintentar o permitir solo esta vez. Un 409 (ya decidida) o un
    // 403 (sin permiso de gasto) no se arreglan reintentando: se muestra el motivo.
    onDecide(decision).catch((e: unknown) => {
      const status = typeof e === "object" && e !== null ? (e as { status?: unknown }).status : undefined;
      setSent(null);
      setError(decision === "always" && status !== 409 && status !== 403 ? copy.alwaysFailed : e instanceof Error ? e.message : String(e));
    });
  };

  return <div className={`${styles.diffCard} ${styles.approvalCard}`} role="group" aria-label={`${app} ${copy.wantsToUse} ${toolName}`} data-approval={record?.status ?? "event"}>
    <div className={styles.approvalBody}>
      <div className={styles.approvalHead}>
        <p className={styles.approvalTitle}>
          <Wrench size={16} strokeWidth={1.75} aria-hidden="true" />
          {spend ? <span>{copy.spendTitle(toolName)}</span> : <span>{app} {copy.wantsToUse} <code className={styles.approvalTool}>{toolName}</code></span>}
        </p>
        <span className={styles.approvalKind} data-kind={approval.kind}>{kind.icon}{kind.label}</span>
      </div>
      {approval.reason && <p className={styles.approvalReason}>{approval.reason}</p>}
      {prompt?.preview && <p className={styles.approvalReason}>{prompt.preview}</p>}
      {prompt?.clipped && <>
        <button type="button" className={styles.approvalArgs} aria-expanded={requestOpen} onClick={() => setRequestOpen((v) => !v)}>
          {copy.viewRequest}
          <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <Collapse open={requestOpen}><pre className={`${styles.io} ${styles.ioInput}`}>{prompt.full}</pre></Collapse>
      </>}
      {!spend && showInput && <><button type="button" className={styles.approvalArgs} aria-expanded={argsOpen} aria-controls={argsId} onClick={() => setArgsOpen((v) => !v)}>
        {copy.args}
        <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <Collapse open={argsOpen} id={argsId}>
        <pre className={`${styles.io} ${styles.ioInput}`}>{JSON.stringify(input, null, 2) ?? copy.noArgs}</pre>
      </Collapse></>}
    </div>
    <AutoHeight className={styles.decideStage}>
      {approval.decision ? <Verdict decision={approval.decision} always={approval.scope === "always"} onRevoke={onRevoke && (() => onRevoke(approval.toolName))} />
        : <div className={styles.decide}>
          {record?.status === "loading" ? <p className={styles.decideNote}><TextShimmer>{copy.loadingApproval}</TextShimmer></p>
            : record?.status === "missing" ? <p className={styles.decideNote} role="alert">{record.text}</p>
            : rec?.decision ? <p className={styles.decideNote} role="status">{copy.alreadyDecided}</p>
            : error ? <p className={styles.decideNote} role="alert">{error}</p>
            : sent ? <p className={styles.decideNote}><TextShimmer>{sent === "skip" ? copy.sendingSkip : copy.sendingAllow}</TextShimmer></p>
            : <p className={styles.decideNote}>{spend ? copy.spendNote(toolName) : approval.kind === "write" ? copy.writeNote(app) : copy.waitingNote}</p>}
          {!blocked && <div className={styles.decideActions}>
            <Button variant="secondary" size="sm" disabled={sent !== null} onClick={() => decide("skip")}>{copy.skip}</Button>
            {offerAlways && <Button variant="secondary" size="sm" disabled={sent !== null} onClick={() => decide("always")}>{copy.allowAlways}{remember.length > 0 && <> <code className={styles.approvalTool}>{remember.map(patternLabel).join(", ")}</code></>}</Button>}
            <Button size="sm" className={styles.accentButton} disabled={sent !== null} onClick={() => decide("allow")}>{spend ? copy.allowOnce : copy.allow}</Button>
          </div>}
        </div>}
    </AutoHeight>
  </div>;
}

// Lovable ofrece "Ask each time" en el menú de la tarjeta cuando la tool ya corre sin preguntar (:1846-1855). Aquí
// "siempre" existe solo para gasto, así que la única salida es esa: un botón y no un menú de una opción.
function Verdict({ decision, always, onRevoke }: { decision: "allow" | "skip" | "timeout"; always?: boolean; onRevoke?: () => Promise<void> }) {
  const { copy } = useRunSlots();
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const revoke = () => {
    if (!onRevoke) return;
    setState("sending");
    setError(null);
    onRevoke().then(() => setState("done"), (e: unknown) => { setState("idle"); setError(e instanceof Error ? e.message : String(e)); });
  };
  if (decision === "allow" && always) return <div className={styles.decide}>
    {error ? <p className={styles.decideNote} role="alert">{error}</p>
      : state === "done" ? <p className={styles.decideNote} role="status">{copy.askAgainDone}</p>
      : <p className={styles.verdict} data-tone="approved"><Check size={16} strokeWidth={1.75} aria-hidden="true" />{copy.allowedAlways}</p>}
    {onRevoke && state !== "done" && <div className={styles.decideActions}>
      <Button variant="secondary" size="sm" disabled={state === "sending"} onClick={revoke}>{copy.askEachTime}</Button>
    </div>}
  </div>;
  const [Icon, text, tone] = decision === "allow" ? [Check, copy.allowed, "approved"] as const
    : decision === "skip" ? [X, copy.skipped, "rejected"] as const
    : [Timer, copy.timedOut, "rejected"] as const;
  return <div className={styles.decide}><p className={styles.verdict} data-tone={tone}><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{text}</p></div>;
}


const field = (input: unknown, key: string): string | undefined => {
  const v = typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v.trim() ? v : undefined;
};

type PlanStage = "idle" | "editing" | "rejecting";

/** El plan que se pinta: el del GET (con el borrador editado si lo hay) manda sobre input.plan del evento, que queda de
 * respaldo mientras carga o si el GET falla. */
export function planText(fetched: LoadedPlan | null, inline: string | undefined): string | null {
  return fetched?.plan ?? inline ?? null;
}

export const statusOf = (error: unknown): number | undefined => {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
};

/** approve o edit que el transport no puede construir AHORA (409 code workspace-busy, 429 tope de corridas) no registra
 * nada y el plan sigue pendiente: la tarjeta se queda donde estaba (el editor conserva el texto) y explica cómo reintentar.
 * Los demás 409 (plan ya decidido, sin sesión, sin plan, sin original) dan 409 en cada reintento: no se invita a reintentar. */
export function planDecisionFailure(error: unknown, decision: ToolDecision, stage: PlanStage): { stage: PlanStage; error: string; status?: number } {
  const status = statusOf(error);
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const kind = typeof decision === "object" ? decision.decision : undefined;
  const retry = kind === "edit" ? "Guarda" : "Aprueba";
  const builds = kind === "edit" || kind === "approve";
  if (builds && status === 409 && code === "workspace-busy") return { stage, error: `Hay otra construcción en curso. ${retry} de nuevo cuando termine.`, status };
  if (builds && status === 429) return { stage, error: `Hay demasiadas construcciones en curso. ${retry} de nuevo en un momento.`, status };
  return { stage, error: error instanceof Error ? error.message : String(error), ...(status === undefined ? {} : { status }) };
}

/** El server guarda el sessionId del turno de plan en message.end: decidir antes responde 409, así que se espera al cierre. */
export const canDecidePlan = (state: { pending: boolean; turnClosed: boolean; sending: boolean }): boolean =>
  state.pending && state.turnClosed && !state.sending;

/**
 * El plan que el agente dejó en `.wt/plans/<id>.md` (exit_plan_mode), con la anatomía del permission prompt: el plan
 * renderizado y Rechazar / Editar / Aprobar a la derecha. Como plan--show de Lovable y ExitPlanMode de Make, el turno ya
 * terminó: aprobar arranca la construcción, rechazar la descarta, y un mensaje nuevo la cancela. No hay "siempre".
 */
function PlanApprovalCard({ approval, onDecide, loadPlan, renderMarkdown, turnClosed }: { approval: ToolApproval; onDecide: (decision: ToolDecision) => Promise<void>; loadPlan?: () => Promise<LoadedPlan>; renderMarkdown?: (markdown: string) => ReactNode; turnClosed: boolean }) {
  const planId = useId();
  const { copy } = useRunSlots();
  const inline = field(approval.input, "plan");
  const summary = field(approval.input, "summary") ?? approval.reason;
  const [fetched, setFetched] = useState<LoadedPlan | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; status?: number } | null>(null);
  const plan = planText(fetched, inline);
  const [open, setOpen] = useState(!approval.decision);
  const [stage, setStage] = useState<PlanStage>("idle");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<ToolDecision | null>(null);
  const [error, setError] = useState<{ text: string; status?: number } | null>(null);

  // Una vez por tarjeta: el host pasa loadPlan nuevo en cada render y no debe relanzar el GET mientras carga.
  const load = useRef(loadPlan);
  load.current = loadPlan;
  const requested = useRef(false);
  useEffect(() => {
    if (!load.current || !open || requested.current) return;
    requested.current = true;
    let live = true;
    load.current().then(p => { if (live) setFetched(p); }, (e: unknown) => { if (live) setLoadError({ text: e instanceof Error ? e.message : String(e), status: statusOf(e) }); });
    return () => { live = false; requested.current = false; };
  }, [open]);

  const decide = (decision: ToolDecision) => {
    setSent(decision);
    setError(null);
    onDecide(decision).then(() => setStage("idle"), (e: unknown) => {
      const failure = planDecisionFailure(e, decision, stage);
      setSent(null);
      setStage(failure.stage);
      setError({ text: failure.error, status: failure.status });
    });
  };
  const startEdit = () => { setDraft(plan ?? ""); setStage("editing"); setOpen(true); };
  const startReject = () => { setDraft(""); setStage("rejecting"); };
  const pending = !approval.decision;
  const busy = !canDecidePlan({ pending, turnClosed, sending: sent !== null });

  return <div className={`${styles.diffCard} ${styles.approvalCard}`} role="group" aria-label={approval.decision ? copy.plan : copy.planToApprove}>
    <div className={styles.approvalBody}>
      <div className={styles.approvalHead}>
        <p className={styles.approvalTitle}>
          <ListTodo size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{pending ? copy.planReady : copy.plan}</span>
        </p>
        {pending && <span className={styles.approvalKind} data-kind="plan">{copy.planNoChanges}</span>}
      </div>
      {summary && <p className={styles.approvalReason}>{summary}</p>}
      {fetched?.edited && pending && <p className={styles.approvalReason}>{copy.planEdited}</p>}
      {stage === "editing"
        ? <Textarea label={copy.plan} value={draft} rows={12} className={styles.planEditor} onChange={e => setDraft(e.target.value)} disabled={busy} />
        : <>
          <button type="button" className={styles.approvalArgs} aria-expanded={open} aria-controls={planId} onClick={() => setOpen(v => !v)}>
            {open ? copy.hidePlan : copy.showPlan}
            <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Collapse open={open} id={planId}>
            <div className={styles.planBody}>
              {plan !== null ? (renderMarkdown ? renderMarkdown(plan) : <pre className={`${styles.io} ${styles.ioInput}`}>{plan}</pre>)
                : loadError ? <p className={styles.decideNote} role="alert" title={loadError.status ? `HTTP ${loadError.status}` : undefined}>{loadError.text}</p>
                : loadPlan ? <p className={styles.decideNote}><TextShimmer>{copy.loadingPlan}</TextShimmer></p>
                : <p className={styles.decideNote}>{field(approval.input, "planPath") ?? copy.noPlanText}</p>}
            </div>
          </Collapse>
        </>}
      {stage === "rejecting" && <Textarea label={copy.rejectLabel} value={draft} rows={3} placeholder={copy.rejectPlaceholder} onChange={e => setDraft(e.target.value)} disabled={busy} />}
    </div>
    <AutoHeight className={styles.decideStage}>
      {!pending ? <PlanVerdict approval={approval} />
        : <div className={styles.decide}>
          {error ? <p className={styles.decideNote} role="alert" title={error.status ? `HTTP ${error.status}` : undefined}>{error.text}</p>
            : sent ? <p className={styles.decideNote}><TextShimmer>{typeof sent === "object" && sent.decision === "reject" ? copy.rejecting : copy.sendingApproval}</TextShimmer></p>
            : !turnClosed ? <p className={styles.decideNote}><TextShimmer>{copy.closingPlan}</TextShimmer></p>
            : stage === "editing" ? <p className={styles.decideNote}>{copy.editNote}</p>
            : stage === "rejecting" ? <p className={styles.decideNote}>{copy.rejectNote}</p>
            : null}
          <div className={styles.decideActions}>
            {stage === "idle" ? <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={startReject}>{copy.reject}</Button>
              <Button variant="secondary" size="sm" disabled={busy || (plan === null && !loadError)} onClick={startEdit}>{copy.edit}</Button>
              <Button size="sm" className={styles.accentButton} disabled={busy} onClick={() => decide({ decision: "approve" })}>{copy.approve}</Button>
            </> : <>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setStage("idle")}>{copy.cancel}</Button>
              {stage === "editing"
                ? <Button size="sm" className={styles.accentButton} disabled={busy || !draft.trim()} onClick={() => decide({ decision: "edit", plan: draft })}>{copy.saveApprove}</Button>
                : <Button size="sm" disabled={busy} onClick={() => decide(draft.trim() ? { decision: "reject", feedback: draft.trim() } : { decision: "reject" })}>{copy.rejectPlan}</Button>}
            </>}
          </div>
        </div>}
    </AutoHeight>
  </div>;
}

function PlanVerdict({ approval }: { approval: ToolApproval }) {
  const { copy } = useRunSlots();
  const [Icon, text, tone, rejected] = approval.decision === "allow" ? [Check, approval.edited ? copy.approvedEdited : copy.approved, "approved", false] as const
    : approval.cancelReason === "user-message" ? [Ban, copy.cancelledByMessage, "rejected", false] as const
    : approval.cancelReason === "stopped" ? [Ban, copy.stoppedWithoutBuild, "rejected", false] as const
    : approval.decision === "timeout" ? [Timer, copy.timedOut, "rejected", false] as const
    : [X, copy.rejected, "rejected", true] as const;
  const feedback = rejected ? approval.feedback : undefined;
  return <div className={styles.decide}>
    <p className={styles.verdict} data-tone={tone}><Icon size={16} strokeWidth={1.75} aria-hidden="true" />{text}</p>
    {feedback && <p className={styles.approvalReason}>{feedback}</p>}
  </div>;
}
