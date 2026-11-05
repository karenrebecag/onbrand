"use client";

import type { ReactNode } from "react";
import { CircleCheck, FileCode2, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "../../button/button";
import type { RunResult } from "./agent-run-types";
import { GithubMark } from "./agent-run-marks";
import { DiffCount } from "./diff-card";
import { useRunSlots } from "./agent-run-slots";
import { StreamedText } from "./streamed-text";
import styles from "./agent-run.module.css";

export type PrState = "idle" | "opening" | "opened";

/** Five blocks split by the share of added and removed lines, the way a code host shows a diffstat. */
function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions || 1;
  const add = Math.round(5 * additions / total);
  const del = Math.min(5 - add, Math.round(5 * deletions / total));
  return <span className={styles.diffBar} aria-hidden="true">
    {Array.from({ length: 5 }, (_, i) => <span key={i} data-kind={i < add ? "add" : i < add + del ? "del" : undefined} />)}
  </span>;
}

/** Every label sits in one grid cell, so the button is always as wide as its longest label and never resizes. */
function PrLabel({ state, number }: { state: PrState; number?: number }) {
  const { copy } = useRunSlots();
  return <span className={styles.labelStack}>
    <span data-on={state === "idle" || undefined} aria-hidden={state !== "idle" || undefined}><GithubMark className={styles.ghMark} aria-hidden="true" />{copy.prOpen}</span>
    <span data-on={state === "opening" || undefined} aria-hidden={state !== "opening" || undefined}><LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-hidden="true" />{copy.prOpening}</span>
    <span data-on={state === "opened" || undefined} aria-hidden={state !== "opened" || undefined}><GithubMark className={styles.ghMark} aria-hidden="true" />{copy.prOpened(number)}</span>
  </span>;
}

export function ResultPanel({ result, pr, prNumber, onOpenPr, action }: { result: RunResult; pr: PrState; prNumber?: number; onOpenPr: () => void; action?: ReactNode }) {
  const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);
  const files = result.files.length;
  const { copy } = useRunSlots();
  return <div className={styles.result}>
    <StreamedText className={styles.summary} text={result.summary} />
    {files > 0 && <div className={styles.files}>
      <p className={styles.filesHead}>
        <span>{files} {copy.filesChanged(files)}</span>
        <DiffCount additions={additions} deletions={deletions} />
      </p>
      <ul className={styles.fileList} aria-label={copy.filesLabel}>
        {result.files.map(file => <li key={file.path} className={styles.fileRow}>
          <FileCode2 className={styles.fileIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.filePath} title={file.path}>{file.path}</span>
          <DiffCount additions={file.additions} deletions={file.deletions} />
          <DiffBar additions={file.additions} deletions={file.deletions} />
        </li>)}
      </ul>
    </div>}
    {(result.tests || Boolean(result.checks?.length)) && <ul className={styles.checks} aria-label={copy.checksLabel}>
      {result.tests && <li><CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />{copy.testsPassed(result.tests.passed, result.tests.total)}</li>}
      {result.checks?.map(check => <li key={check}><CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />{check}</li>)}
    </ul>}
    <div className={styles.resultActions}>
      {action !== undefined ? action : <Button size="sm" className={styles.prButton} data-pr={pr} aria-disabled={pr !== "idle" || undefined} onClick={onOpenPr}>
        <PrLabel state={pr} number={prNumber} />
      </Button>}
    </div>
  </div>;
}

export function StoppedPanel({ onRestart, summary }: { onRestart?: () => void; summary?: string }) {
  const { copy } = useRunSlots();
  return <div className={styles.result}>
    <p className={styles.summary}>{summary || copy.stoppedSummary}</p>
    {onRestart && <div className={styles.resultActions}>
      <Button size="sm" variant="secondary" onClick={onRestart}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />{copy.repeat}</Button>
    </div>}
  </div>;
}
