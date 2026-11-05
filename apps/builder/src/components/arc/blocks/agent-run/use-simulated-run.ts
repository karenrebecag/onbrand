"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentRunState, ProposedChange, RunResult, RunScript, RunStep, ScriptApproval, ScriptStep } from "./agent-run-types";

type Phase = AgentRunState["status"];
type Planned = ScriptStep | ScriptApproval;

interface Sim {
  phase: Phase;
  /** The steps still to come, in order. A rejection splices the revision in after the current step. */
  plan: Planned[];
  index: number;
  /** Milliseconds into the current step. */
  clock: number;
  elapsed: number;
  finished: RunStep[];
  revised: boolean;
  approved?: ProposedChange;
  result: RunScript["result"];
}

const isApproval = (step: Planned): step is ScriptApproval => "change" in step;

const fresh = (script: RunScript, phase: Phase = "idle"): Sim => ({ phase, plan: script.steps, index: 0, clock: 0, elapsed: 0, finished: [], revised: false, result: script.result });

/** The parts of a script step that a rendered step keeps. */
function view(step: Planned): RunStep {
  const { id, mark, verb, doneVerb, target, doneTarget, io, text, icon } = step;
  return { id, mark, verb, doneVerb, target, doneTarget, io, text, icon, status: "running", change: isApproval(step) ? step.change : undefined };
}

function tick(sim: Sim, dt: number): Sim {
  if (sim.phase !== "working") return sim;
  let { index, clock, finished } = sim;
  clock += dt;
  const elapsed = sim.elapsed + dt;
  while (index < sim.plan.length) {
    const step = sim.plan[index];
    if (clock < step.ms) break;
    if (isApproval(step)) return { ...sim, finished, index, clock: step.ms, elapsed: elapsed - (clock - step.ms), phase: "waiting" };
    finished = [...finished, { ...view(step), status: "done", ms: step.ms }];
    clock -= step.ms;
    index += 1;
  }
  if (index >= sim.plan.length) return { ...sim, finished, index, clock: 0, elapsed: elapsed - clock, phase: "done" };
  return { ...sim, finished, index, clock, elapsed };
}

function diffstat(change: ProposedChange): RunResult["files"] {
  return change.files.map(file => ({
    path: file.path,
    additions: file.lines.filter(line => line.type === "add").length,
    deletions: file.lines.filter(line => line.type === "del").length,
  }));
}

export interface SimulatedRun {
  state: AgentRunState;
  start: () => void;
  restart: () => void;
  approve: () => void;
  reject: (reason: string) => void;
}

/**
 * Plays a scripted run on one animation frame clock. Time stops while a change waits for a decision, while the card is
 * off screen and while the tab is hidden, so nobody comes back to a run that finished without them.
 */
export function useSimulatedRun(script: RunScript, { running }: { running: boolean }): SimulatedRun {
  const scriptRef = useRef(script);
  useEffect(() => { scriptRef.current = script; });
  const [sim, setSim] = useState<Sim>(() => fresh(script));

  const ticking = running && sim.phase === "working";
  useEffect(() => {
    if (!ticking) return;
    let frame = 0, last = performance.now(), pending = 0;
    const loop = (now: number) => {
      // A long gap (a hidden tab, a busy main thread) counts as one short beat instead of a jump.
      pending += Math.min(now - last, 100);
      last = now;
      // Commit about 25 times a second: enough for counters and the timer, without rendering every frame.
      if (pending >= 40) { const dt = pending; pending = 0; setSim(current => tick(current, dt)); }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [ticking]);

  const start = useCallback(() => setSim(current => current.phase === "idle" ? { ...current, phase: "working" } : current), []);
  const restart = useCallback(() => setSim(fresh(scriptRef.current, "working")), []);

  const approve = useCallback(() => setSim(current => {
    const step = current.plan[current.index];
    if (current.phase !== "waiting" || !step || !isApproval(step)) return current;
    return { ...current, phase: "working", index: current.index + 1, clock: 0, approved: step.change, finished: [...current.finished, { ...view(step), status: "done", ms: step.ms }] };
  }), []);

  const reject = useCallback((reason: string) => setSim(current => {
    const step = current.plan[current.index];
    if (current.phase !== "waiting" || !step || !isApproval(step)) return current;
    const finished = [...current.finished, { ...view(step), status: "rejected" as const, ms: step.ms, reason }];
    if (!step.revise || current.revised) return { ...current, phase: "stopped", finished, index: current.index + 1, clock: 0 };
    // The note travels with the revision, so the agent's next thought quotes it.
    const revision = step.revise.steps.map((planned, i) => i === 0 && planned.text ? { ...planned, text: `“${reason}” ${planned.text}` } : planned);
    const plan = [...current.plan.slice(0, current.index + 1), ...revision, step.revise.approval, ...current.plan.slice(current.index + 1)];
    return { ...current, phase: "working", plan, finished, index: current.index + 1, clock: 0, revised: true };
  }), []);

  const state = useMemo<AgentRunState>(() => {
    const current = sim.plan[sim.index];
    const steps = [...sim.finished];
    if (current && (sim.phase === "working" || sim.phase === "waiting")) {
      const live = view(current);
      if (sim.phase === "waiting") live.status = "waiting";
      else if (current.total) live.progress = { value: Math.min(current.total, 1 + Math.floor(sim.clock / current.ms * current.total)), total: current.total };
      steps.push(live);
    }
    const { result } = sim;
    return {
      status: sim.phase,
      elapsedMs: sim.elapsed,
      steps,
      result: sim.phase === "done" ? { ...result, summary: sim.approved?.outcome ?? result.summary, files: sim.approved ? diffstat(sim.approved) : [] } : undefined,
    };
  }, [sim]);

  return { state, start, restart, approve, reject };
}
