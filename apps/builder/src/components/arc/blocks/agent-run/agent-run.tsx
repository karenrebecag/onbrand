"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { ChevronDown, Circle, CircleCheck, CircleMinus, Hand, ListChecks, LoaderCircle, Play, RotateCcw } from "lucide-react";
import { Button } from "../../button/button";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import { Tooltip } from "../../tooltip/tooltip";
import type { AgentModel, AgentRunState, ApprovalRecord, ProposedChange, PullRequest, RunScript, RunStatus, ToolDecision } from "./agent-run-types";
import { RunSlotsContext, resolveSlots, type AgentRunSlots } from "./agent-run-slots";
import { ClaudeMark } from "./agent-run-marks";
import { SAMPLE_MODEL_NAME, SAMPLE_TASK, sampleScript } from "./agent-run-data";
import { Collapse, Swap, useMotionPrefs } from "./run-motion";
import { ResultPanel, StoppedPanel, type PrState } from "./run-result";
import { StepRow, stepLabel } from "./run-steps";
import { ToolApprovalCard } from "./tool-approval";
import { useSimulatedRun } from "./use-simulated-run";
import styles from "./agent-run.module.css";

export type * from "./agent-run-types";
export type { AgentRunCopy, AgentRunSlots } from "./agent-run-slots";
export { useSimulatedRun } from "./use-simulated-run";
export { sampleScript } from "./agent-run-data";

export interface AgentRunProps {
  /** What the agent was asked to do. */
  task?: string;
  /** The model doing the work, with its mark. Defaults to Claude Sonnet 5.5. */
  model?: AgentModel;
  /** The scripted run to simulate. Ignored when `run` is set. */
  script?: RunScript;
  /** A live run from your agent runtime. Leave it out to simulate `script`. */
  run?: AgentRunState;
  /** Start the simulation as soon as the card is on screen. Defaults to true. */
  autoPlay?: boolean;
  /** Called when someone approves a proposed change. A simulation then carries on writing it. */
  onApprove?: (change: ProposedChange) => void;
  /** Called with the note when someone rejects a change. A simulation revises once, then stops on a second rejection. */
  onReject?: (change: ProposedChange, reason: string) => void;
  /** Opens a pull request from the result. Without it the preview simulates one. Throw to report a failure. */
  onOpenPullRequest?: () => Promise<PullRequest | void> | PullRequest | void;
  /** Called by Restart run. A simulation restarts on its own. */
  onRestart?: () => void;
  /** Replaces the pull request button, for hosts whose result is not a pull request (a builder publishes instead). Null shows no action. */
  resultAction?: ReactNode;
  /** Allows or skips a tool waiting in `run.approvals`. Throw with a message when the decision did not go through. */
  onDecideTool?: (callId: string, decision: ToolDecision) => Promise<void>;
  /** Plan text for a plan approval whose request does not carry it. */
  onLoadPlan?: (callId: string) => Promise<{ plan: string; edited?: boolean }>;
  /** El registro de una tarjeta de conector (GET approvals/:callId): con él la tarjeta se pinta desde ahí y no desde el evento. */
  onLoadApproval?: (callId: string) => Promise<ApprovalRecord>;
  /** How the plan card renders markdown; without it the plan shows as plain text. */
  renderMarkdown?: (markdown: string) => ReactNode;
  /** Quita el "Permitir siempre" de una tool: las próximas llamadas vuelven a preguntar. */
  onRevokeTool?: (toolName: string) => Promise<void>;
  /** Lo visual que el host cambia (marcas, tipos, modelo, textos); sin slot, el default del proyecto. */
  slots?: AgentRunSlots;
  className?: string;
}

const DEFAULT_MODEL: AgentModel = { name: SAMPLE_MODEL_NAME, mark: <ClaudeMark aria-hidden="true" /> };

/** A ticking clock: 0:07, 1:04. */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** A finished duration: 14s, 1m 04s. */
const total = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function StatusIcon({ status }: { status: RunStatus }) {
  const props = { className: styles.statusIcon, size: 14, strokeWidth: 2, "aria-hidden": true } as const;
  if (status === "working") return <LoaderCircle {...props} className={`${styles.statusIcon} ${styles.spin}`} />;
  if (status === "waiting") return <Hand {...props} />;
  if (status === "done") return <CircleCheck {...props} />;
  if (status === "stopped") return <CircleMinus {...props} />;
  return <Circle {...props} />;
}

/**
 * One AI coding agent working through a task: steps stream in with the live one shimmering, tool calls open in place,
 * the agent stops on a diff for your approval before it writes, and the run folds into a result with a pull request.
 * With no props it plays a simulated run; nothing is read, written or executed.
 */
export function AgentRun({ task = SAMPLE_TASK, model = DEFAULT_MODEL, script = sampleScript, run, autoPlay = true, onApprove, onReject, onOpenPullRequest, onRestart, resultAction, onDecideTool, onRevokeTool, onLoadPlan, onLoadApproval, renderMarkdown, slots, className }: AgentRunProps) {
  const resolved = useMemo(() => resolveSlots(slots), [slots]);
  const { copy } = resolved;
  const ids = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const root = useRef<HTMLElement>(null);
  const inView = useInView(root, { amount: .2 });
  const { reduce, height } = useMotionPrefs();
  const sim = useSimulatedRun(script, { running: !run && inView });
  const { start } = sim;
  const state = run ?? sim.state;
  const { status, steps, result } = state;
  const finished = status === "done" || status === "stopped";

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [stepsOpen, setStepsOpen] = useState(false);
  const [pr, setPr] = useState<{ state: PrState; number?: number; url?: string }>({ state: "idle" });
  const [notice, setNotice] = useState("");
  const prTimer = useRef<number | undefined>(undefined);

  useEffect(() => { if (!run && autoPlay && inView) start(); }, [run, autoPlay, inView, start]);
  useEffect(() => () => window.clearTimeout(prTimer.current), []);

  const headId = useCallback((stepId: string) => `${ids}-step-${stepId}`, [ids]);
  const focusStep = useCallback((stepId: string) => requestAnimationFrame(() => document.getElementById(headId(stepId))?.focus({ preventScroll: true })), [headId]);
  const toggle = useCallback((stepId: string) => setOpen(current => ({ ...current, [stepId]: !current[stepId] })), []);

  const waiting = steps.find(step => step.status === "waiting" && step.change);
  const waitingRef = useRef(waiting);
  useEffect(() => { waitingRef.current = waiting; });

  const { approve: simApprove, reject: simReject, restart: simRestart } = sim;
  const live = Boolean(run);
  const approve = useCallback(() => {
    const step = waitingRef.current;
    if (!step?.change) return;
    onApprove?.(step.change);
    if (!live) simApprove();
    focusStep(step.id);
  }, [onApprove, live, simApprove, focusStep]);
  const reject = useCallback((reason: string) => {
    const step = waitingRef.current;
    if (!step?.change) return;
    onReject?.(step.change, reason);
    if (!live) simReject(reason);
    focusStep(step.id);
  }, [onReject, live, simReject, focusStep]);
  const gate = useMemo(() => ({ onApprove: approve, onReject: reject }), [approve, reject]);

  // En vivo, sin onRestart no hay a dónde repetir: el botón no se muestra en vez de no hacer nada.
  const canRestart = !live || Boolean(onRestart);
  const restart = () => {
    window.clearTimeout(prTimer.current);
    setOpen({});
    setStepsOpen(false);
    setPr({ state: "idle" });
    setNotice("");
    onRestart?.();
    if (!live) simRestart();
  };

  const openPr = async () => {
    if (pr.state === "opened" && pr.url) { window.open(pr.url, "_blank", "noopener,noreferrer"); return; }
    if (pr.state !== "idle") return;
    setPr({ state: "opening" });
    setNotice("");
    if (!onOpenPullRequest) {
      prTimer.current = window.setTimeout(() => {
        const number = script.pullRequest?.number ?? 482;
        setPr({ state: "opened", number });
        setNotice(`Simulated: pull request #${number} opened. Nothing was sent to GitHub.`);
      }, 900);
      return;
    }
    try {
      const opened = await onOpenPullRequest();
      const number = opened?.number ?? script.pullRequest?.number;
      setPr({ state: "opened", number, url: opened?.url });
      setNotice(`Pull request${number ? ` #${number}` : ""} opened.`);
    } catch {
      setPr({ state: "idle" });
      setNotice(copy.prFailed);
    }
  };

  const current = steps[steps.length - 1];
  const announce = status === "working" && current?.status === "running" ? (() => { const { verb, target } = stepLabel(current, copy); return [verb, target].filter(Boolean).join(" "); })()
    : status === "waiting" && waiting?.change ? copy.announceWaiting(waiting.change.files.length)
    : status === "done" ? copy.announceDone(total(state.elapsedMs), result?.tests)
    : status === "stopped" ? copy.announceStopped(total(state.elapsedMs))
    : "";

  const listOpen = !finished || stepsOpen;
  const listId = `${ids}-steps`;

  return <RunSlotsContext.Provider value={resolved}><section ref={root} className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={`${ids}-task`}>
    <header className={styles.header}>
      <div className={styles.titleRow}>
        <h3 id={`${ids}-task`} className={styles.task}>{task}</h3>
        {canRestart && <Tooltip content={copy.restart}>
          <Button variant="ghost" size="sm" className={styles.iconButton} aria-label={copy.restart} onClick={restart}>
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </Tooltip>}
      </div>
      <div className={styles.metaRow}>
        <span className={styles.model}>{(resolved.model ?? model.mark) && <span className={styles.modelMark}>{resolved.model ?? model.mark}</span>}<span className={styles.modelName}>{model.name}</span></span>
        <span className={styles.statusLine}>
          <span className={styles.status} data-status={status}>
            <Swap swapKey={status}><StatusIcon status={status} />{status === "working" ? <TextShimmer>{copy.status.working}</TextShimmer> : copy.status[status]}</Swap>
          </span>
          <span className={styles.timer} role="timer" aria-label={copy.workedFor(clock(state.elapsedMs))}>{clock(state.elapsedMs)}</span>
        </span>
      </div>
    </header>

    <div className={styles.stepsArea}>
      <Collapse open={finished}>
        <button type="button" className={styles.fold} aria-expanded={stepsOpen} aria-controls={listId} onClick={() => setStepsOpen(value => !value)}>
          <ListChecks className={styles.stepIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{copy.stepCount(steps.length, total(state.elapsedMs))}</span>
          <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Collapse>
      <motion.div id={listId} className={styles.listWrap} initial={false} inert={!listOpen}
        animate={{ height: listOpen ? "auto" : 0, opacity: listOpen ? 1 : 0 }}
        transition={{ height, opacity: { duration: reduce ? 0 : listOpen ? .16 : .1 } }}>
        <ol className={styles.steps} aria-label={copy.stepsLabel}>
          <AnimatePresence initial={false}>
            {steps.map(step => <StepRow key={step.id} step={step} open={Boolean(open[step.id])} headId={headId(step.id)} onToggle={toggle} gate={step.status === "waiting" ? gate : undefined} />)}
          </AnimatePresence>
        </ol>
      </motion.div>
      {/* Terminado, solo quedan las resueltas: ya no tienen botones, así que no hace falta onDecideTool. */}
      {(finished || onDecideTool) && state.approvals?.filter(a => !finished || a.decision || a.kind === "plan").map(a => <ToolApprovalCard key={a.callId} approval={a} onDecide={decision => onDecideTool ? onDecideTool(a.callId, decision) : Promise.reject(new Error(copy.turnOver))} onRevoke={onRevokeTool} loadPlan={onLoadPlan && (() => onLoadPlan(a.callId))} loadApproval={onLoadApproval && (() => onLoadApproval(a.callId))} renderMarkdown={renderMarkdown} turnClosed={finished} />)}
      {status === "idle" && !autoPlay && !run && <div className={styles.ready}>
        <p>{copy.ready}</p>
        <Button size="sm" className={styles.accentButton} onClick={start}><Play size={16} strokeWidth={1.75} aria-hidden="true" />{copy.startRun}</Button>
      </div>}
    </div>

    <Collapse open={status === "done" && Boolean(result)} label={copy.resultLabel}>
      {result && <ResultPanel result={result} pr={pr.state} prNumber={pr.number} onOpenPr={openPr} action={resultAction} />}
    </Collapse>
    <Collapse open={status === "stopped"} label={copy.stoppedLabel}>
      <StoppedPanel onRestart={canRestart ? restart : undefined} summary={result?.summary} />
    </Collapse>

    <p className={styles.srOnly} aria-live="polite">{announce}</p>
    <p className={styles.srOnly} aria-live="polite">{notice}</p>
  </section></RunSlotsContext.Provider>;
}

export default AgentRun;
