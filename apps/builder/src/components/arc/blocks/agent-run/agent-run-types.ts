import type { ReactNode } from "react";
import type { ApprovalAnswer, ApprovalRecord, PlanAnswer } from "../../../../lib/run-client";

/** La tarjeta registrada en el orquestador (spec §8.1), el tipo del cliente del proyecto. */
export type { ApprovalRecord };

/** Which small mark a step shows. Real tool marks for real tools, lucide icons for the agent's own tools. */
export type StepMark = "think" | "read" | "search" | "edit" | "terminal" | "review" | "npm" | "typescript" | "github";

/** "failed" is a tool or execution error, distinct from a change someone sent back ("rejected"). */
export type StepStatus = "running" | "waiting" | "done" | "rejected" | "failed";

/** One line of a unified diff. `old` and `new` are line numbers in the old and new file; an added line has no `old`, a removed one no `new`. */
export interface DiffLine { type: "add" | "del" | "ctx"; old?: number; new?: number; text: string }

export interface FileChange {
  path: string;
  /** A new file or an edit to an existing one. */
  status: "added" | "modified";
  lines: DiffLine[];
}

/** A change the agent wants to write. The run stops on it until someone approves or rejects it. */
export interface ProposedChange {
  id: string;
  /** One sentence on what the change does, shown above the diff. */
  summary: string;
  files: FileChange[];
  /** What the agent reports once the change is in and checked. Used as the final summary. */
  outcome?: string;
}

/** A tool call's input and output, shown in mono when the step is opened. */
export interface StepIo { input: string; output: string[] }

export interface RunStep {
  id: string;
  mark: StepMark;
  /** Verb while the step runs, shown with a shimmer: "Reading". */
  verb: string;
  /** Verb once it has finished: "Read". */
  doneVerb: string;
  /** What the step works on: "src/api/routes.ts". */
  target?: string;
  /** Target once done, when it reads differently: "12 passed". */
  doneTarget?: string;
  status: StepStatus;
  /** A live count while the step runs, read as "8 of 12". */
  progress?: { value: number; total: number };
  /** How long the step took, in milliseconds. Shown once done. */
  ms?: number;
  /** Tool input and output. */
  io?: StepIo;
  /** Reasoning text for a thinking step. */
  text?: string;
  /** One line measured by the tool, shown above its images: "Sin desborde horizontal…". */
  note?: string;
  /** Images the tool returned to the agent, such as browser screenshots. */
  shots?: { src: string; alt: string }[];
  /** The proposed change on an approval step. */
  change?: ProposedChange;
  /** The note sent back with a rejected change. */
  reason?: string;
  /** Your own icon, in place of the mark. */
  icon?: ReactNode;
  /** Steps run inside this one (a sub-agent's turn), listed in its details. */
  children?: RunStep[];
}

/** A connector tool waiting inside the turn for someone to allow or skip it. `decision` arrives from the runtime. */
export interface ToolApproval {
  callId: string;
  toolName: string;
  app: string;
  reason?: string;
  input: unknown;
  kind: "read" | "write" | "spend" | "plan";
  decision?: "allow" | "skip" | "timeout";
  /** Plan only: why it closed without a verdict (a new message or Stop), and whether it was edited before approval. */
  cancelReason?: "user-message" | "stopped";
  edited?: boolean;
  /** Plan only: the note sent with a rejection; it also opens the next plan turn. */
  feedback?: string;
  /** Se permitió con "Permitir siempre": la tarjeta resuelta ofrece volver a preguntar. */
  scope?: "always";
}

/** "always" persiste el permiso por chat y tool (approvals.ts); la decisión que llega por el stream es "allow". El tipo es el
 * del cliente del proyecto, no una copia: la tarjeta manda exactamente lo que acepta POST approval (condición 1 de Arq). */
export type ToolDecision = ApprovalAnswer;

/** Plan mode answers: approve as is, reject with optional feedback, or approve an edited plan. */
export type PlanDecision = PlanAnswer;

export type RunStatus = "idle" | "working" | "waiting" | "done" | "stopped";

export interface RunResult {
  /** The agent's closing message. */
  summary: string;
  files: { path: string; additions: number; deletions: number }[];
  tests?: { passed: number; total: number };
  /** Further checks that passed, such as "No type errors". */
  checks?: string[];
}

/** Everything the card renders. Build it from your agent runtime's events for a live run. */
export interface AgentRunState {
  status: RunStatus;
  /** Milliseconds the agent has worked. Time spent waiting for you is not counted. */
  elapsedMs: number;
  steps: RunStep[];
  result?: RunResult;
  /** Tool calls that asked for permission during the run, pending or decided. */
  approvals?: ToolApproval[];
}

export interface AgentModel { name: string; mark?: ReactNode }

/** A pull request opened from the result. */
export interface PullRequest { number: number; url?: string }

/* ---------- The scripted simulation ---------- */

/** A step in a script: how long it runs, and a total when it counts through something such as tests. */
export type ScriptStep = Omit<RunStep, "status" | "progress" | "ms" | "change" | "reason"> & { ms: number; total?: number };

/** A step that stops the run on a change until someone decides. A rejection runs `revise` once and proposes `revise.change`. */
export type ScriptApproval = ScriptStep & {
  change: ProposedChange;
  revise?: { steps: ScriptStep[]; approval: Omit<ScriptApproval, "revise"> };
};

export interface RunScript {
  steps: (ScriptStep | ScriptApproval)[];
  /** Tests and checks reported at the end. Files come from the approved change. */
  result: Omit<RunResult, "files" | "summary"> & { summary: string };
  pullRequest?: PullRequest;
}
