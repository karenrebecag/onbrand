"use client";

import { memo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ChevronDown, CircleAlert, CornerUpLeft } from "lucide-react";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import type { RunStep } from "./agent-run-types";
import { DEFAULT_COPY, useRunSlots, type AgentRunCopy } from "./agent-run-slots";
import { ApprovalCard, SettledChange } from "./diff-card";
import { Collapse, DrawCheck, Swap, easeOut, useMotionPrefs } from "./run-motion";
import styles from "./agent-run.module.css";

/** Seconds with one decimal under ten seconds, whole seconds above. */
export const stepTime = (ms: number) => ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

/** The words a step reads as, for its current status. */
export function stepLabel(step: RunStep, copy: AgentRunCopy = DEFAULT_COPY): { verb: string; target?: string } {
  if (step.status === "running") return { verb: step.verb, target: step.target };
  if (step.status === "waiting") return { verb: copy.review, target: step.doneTarget ?? step.target };
  if (step.status === "rejected") return { verb: copy.returned, target: step.doneTarget ?? step.target };
  if (step.status === "failed") return { verb: step.doneVerb, target: step.reason ?? step.doneTarget ?? step.target };
  return { verb: step.doneVerb, target: step.doneTarget ?? step.target };
}

function SubSteps({ steps, headId }: { steps: RunStep[]; headId: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen(prev => ({ ...prev, [id]: !prev[id] }));
  return <ol className={styles.substeps} aria-label="Steps">
    {steps.map(child => <StepRow key={child.id} step={child} open={Boolean(open[child.id])} headId={`${headId}-${child.id}`} onToggle={toggle} />)}
  </ol>;
}

function Details({ step, headId }: { step: RunStep; headId: string }) {
  if (step.change) return <SettledChange change={step.change} rejected={step.status === "rejected"} reason={step.reason} />;
  return <div className={styles.details}>
    {step.children?.length ? <SubSteps steps={step.children} headId={headId} /> : null}
    {step.text && <p className={styles.thought}>{step.text}</p>}
    {step.note && <p className={styles.thought}>{step.note}</p>}
    {step.shots?.map(shot => <figure key={shot.src} className={styles.shot}>
      <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
      <figcaption>{shot.alt}</figcaption>
    </figure>)}
    {step.io && <div className={styles.io}>
      <code className={styles.ioInput}>{step.io.input}</code>
      <div className={styles.ioOutput}>{step.io.output.map((line, i) => <code key={i}>{line}</code>)}</div>
    </div>}
  </div>;
}

type RowProps = {
  step: RunStep;
  open: boolean;
  headId: string;
  onToggle: (id: string) => void;
  /** Shown in place of the details while the step waits for a decision. */
  gate?: { onApprove: () => void; onReject: (reason: string) => void };
};

/** Memoized: a finished step keeps the same object while the clock ticks, so only the live step renders on each beat. */
export const StepRow = memo(function StepRow({ step, open, headId, onToggle, gate }: RowProps) {
  const { reduce, height } = useMotionPrefs();
  const slots = useRunSlots();
  const { verb, target } = stepLabel(step, slots.copy);
  const waiting = step.status === "waiting" && gate && step.change;
  const expandable = !waiting && Boolean(step.text || step.io || step.change || step.children?.length || step.shots?.length);
  const panelId = `${headId}-details`;

  const content: ReactNode = <>
    <span className={styles.stepIcon}>{step.icon ?? slots.mark(step.mark)}</span>
    <span className={styles.stepLabel}>
      <Swap swapKey={`${step.status}:${verb}`} className={styles.verb}>
        {step.status === "running" ? <TextShimmer>{verb}</TextShimmer> : verb}
      </Swap>
      {target && <span className={styles.target}>{step.status === "rejected" ? <q>{step.reason ?? target}</q> : target}</span>}
      {step.status === "running" && step.progress && <span className={styles.count}>
        <span className={styles.countValue} style={{ minWidth: `${String(step.progress.total).length}ch` }}>{step.progress.value}</span> {slots.copy.progressOf} {step.progress.total}
      </span>}
    </span>
    <span className={styles.stepTime}>{step.status === "done" && step.ms ? stepTime(step.ms) : ""}</span>
    <span className={styles.stepState} aria-hidden="true">
      {step.status === "done" && <DrawCheck />}
      {step.status === "rejected" && <CornerUpLeft size={14} strokeWidth={2} />}
      {step.status === "failed" && <CircleAlert size={14} strokeWidth={2} />}
    </span>
    <span className={styles.chevronSlot} aria-hidden="true">{expandable && <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} />}</span>
  </>;

  return <motion.li className={styles.step} data-status={step.status}
    initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { height, opacity: { duration: .1 } } }}
    transition={{ height, opacity: { duration: reduce ? 0 : .16, ease: easeOut } }}>
    {expandable
      ? <button type="button" id={headId} className={styles.stepHead} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => onToggle(step.id)}>{content}</button>
      : <div id={headId} className={styles.stepHead} tabIndex={-1}>{content}</div>}
    <Collapse open={Boolean(waiting) || (expandable && open)} id={panelId}>
      <div className={styles.stepBody}>
        {waiting && gate && step.change ? <ApprovalCard key={step.id} change={step.change} onApprove={gate.onApprove} onReject={gate.onReject} /> : <Details step={step} headId={headId} />}
      </div>
    </Collapse>
  </motion.li>;
});
