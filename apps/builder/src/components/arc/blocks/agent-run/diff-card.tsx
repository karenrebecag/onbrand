"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import type { FileChange, ProposedChange } from "./agent-run-types";
import { AutoHeight, easeOut, useMotionPrefs } from "./run-motion";
import styles from "./agent-run.module.css";

export const countLines = (file: FileChange) => ({
  additions: file.lines.filter(line => line.type === "add").length,
  deletions: file.lines.filter(line => line.type === "del").length,
});
const basename = (path: string) => path.split("/").pop() ?? path;

/** Additions and deletions as signed counts. Deletions are left out when there are none. */
export function DiffCount({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className={styles.diffCount}>
    <span className={styles.add}><span className={styles.srOnly}>{additions} added</span><span aria-hidden="true">+{additions}</span></span>
    {deletions > 0 && <span className={styles.del}><span className={styles.srOnly}>, {deletions} removed</span><span aria-hidden="true">−{deletions}</span></span>}
  </span>;
}

/**
 * A compact unified diff with one tab per file. Every file's panel shares one grid cell, so the card is always as tall as
 * the longest file and switching tabs only crossfades: nothing below it moves.
 */
export function DiffView({ change }: { change: ProposedChange }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const files = change.files;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = files.length - 1;
    const next = event.key === "ArrowRight" ? (active === last ? 0 : active + 1) : event.key === "ArrowLeft" ? (active === 0 ? last : active - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return <div className={styles.diff}>
    <div className={styles.fileTabs} role="tablist" aria-label="Changed files">
      {files.map((file, i) => <button key={file.path} ref={node => { tabs.current[i] = node; }} type="button" role="tab" id={`${id}-tab-${i}`}
        className={styles.fileTab} aria-selected={i === active} aria-controls={`${id}-panel-${i}`} tabIndex={i === active ? 0 : -1}
        title={file.path} onClick={() => setActive(i)} onKeyDown={onKeyDown}>
        <span className={styles.fileName}>{basename(file.path)}</span>
        <DiffCount {...countLines(file)} />
      </button>)}
    </div>
    <div className={styles.panels}>
      {files.map((file, i) => <div key={file.path} role="tabpanel" id={`${id}-panel-${i}`} aria-labelledby={`${id}-tab-${i}`} aria-label={file.path}
        className={styles.panel} data-active={i === active || undefined} inert={i !== active} tabIndex={i === active ? 0 : -1}>
        <div className={styles.code}>
          {file.lines.map((line, n) => <div key={n} className={styles.line} data-type={line.type}>
            <span className={styles.num} aria-hidden="true">{line.type === "del" ? line.old : line.new}</span>
            <span className={styles.marker} aria-hidden="true">{line.type === "add" ? "+" : line.type === "del" ? "−" : ""}</span>
            <code className={styles.src}>{line.type !== "ctx" && <span className={styles.srOnly}>{line.type === "add" ? "Added: " : "Removed: "}</span>}{line.text || " "}</code>
          </div>)}
        </div>
      </div>)}
    </div>
  </div>;
}

/** The decision on a change that is already settled, shown when its step is opened again. */
export function SettledChange({ change, rejected, reason }: { change: ProposedChange; rejected: boolean; reason?: string }) {
  return <div className={styles.changeBody}>
    <p className={styles.changeSummary}>{change.summary}</p>
    <div className={styles.diffCard}><DiffView change={change} /></div>
    <p className={styles.verdict} data-tone={rejected ? "rejected" : "approved"}>
      {rejected ? <X size={14} strokeWidth={2} aria-hidden="true" /> : <Check size={14} strokeWidth={2} aria-hidden="true" />}
      {rejected ? <>Sent back{reason ? <>: <q>{reason}</q></> : null}</> : "Approved by you"}
    </p>
  </div>;
}

/**
 * The approval gate: the diff, then Approve and Reject. Reject swaps the footer for a short note in place; the footer's
 * height follows on the smooth spring.
 */
export function ApprovalCard({ change, onApprove, onReject }: { change: ProposedChange; onApprove: () => void; onReject: (reason: string) => void }) {
  const { reduce } = useMotionPrefs();
  const [mode, setMode] = useState<"ask" | "reason">("ask");
  const [reason, setReason] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const rejectButton = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);

  useEffect(() => {
    if (mode === "reason") input.current?.focus({ preventScroll: true });
    else if (returning.current) { returning.current = false; rejectButton.current?.focus({ preventScroll: true }); }
  }, [mode]);

  const cancel = () => { returning.current = true; setMode("ask"); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const note = reason.trim();
    if (note) onReject(note);
  };
  const fade = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 2 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, transition: { duration: reduce ? 0 : .1 } },
    transition: { duration: reduce ? 0 : .16, ease: easeOut },
  };

  return <div className={styles.changeBody}>
    <p className={styles.changeSummary}>{change.summary}</p>
    <div className={styles.diffCard}>
      <DiffView change={change} />
      <AutoHeight className={styles.decideStage}>
        <AnimatePresence mode="popLayout" initial={false}>
          {mode === "ask"
            ? <motion.div key="ask" className={styles.decide} {...fade}>
              <p className={styles.decideNote}>Nothing is written until you approve.</p>
              <div className={styles.decideActions}>
                <Button ref={rejectButton} variant="secondary" size="sm" onClick={() => setMode("reason")}>Reject</Button>
                <Button size="sm" className={styles.accentButton} onClick={onApprove}>Approve</Button>
              </div>
            </motion.div>
            : <motion.form key="reason" className={styles.reasonForm} onSubmit={submit} {...fade}
              onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
              <Input ref={input} label="What should change?" placeholder="For example, make the limit configurable" value={reason}
                onChange={event => setReason(event.target.value)} autoComplete="off" />
              <div className={styles.decideActions}>
                <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
                <Button type="submit" size="sm" className={styles.accentButton} disabled={!reason.trim()}>Send back</Button>
              </div>
            </motion.form>}
        </AnimatePresence>
      </AutoHeight>
    </div>
  </div>;
}
