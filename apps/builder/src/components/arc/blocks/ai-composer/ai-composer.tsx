"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Brain, Bug, CircleAlert, FileText, Globe, PenLine, RotateCcw, Square, SquarePen, Upload } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { CopyButton } from "../../copy-button/copy-button";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import { Tooltip } from "../../tooltip/tooltip";
import { Composer, tokenRanges, type ComposerDraft, type ComposerHandle } from "./composer";
import { AttachmentGlyph, ModelMark, cx, type ComposerAttachment } from "./composer-parts";
import { effortLabel, sampleModels, sampleReply, sampleSuggestions, type ComposerModel, type Effort, type Suggestion } from "./composer-data";
import styles from "./ai-composer.module.css";

export type { ComposerAttachment } from "./composer-parts";
export type { ComposerModel, Effort, Suggestion } from "./composer-data";

const { spring, duration, ease } = motionTokens;

/** Moves, resizes and swaps settle without overshoot, so nothing wobbles. */
const settle = { type: "spring", visualDuration: 0.24, bounce: 0 } as const;
export interface ComposerMessage {
  /** The message as typed, with commands and mentions inline. */
  text: string;
  /** Commands and mentions in the text, for example "/summarize" or "@Q4 launch plan". */
  tokens: string[];
  attachments: ComposerAttachment[];
  /** Attachment names, kept for the earlier `onSend({ text, files })` shape. */
  files: string[];
  /** The chosen model's id. */
  model: string;
  effort: Effort;
  webSearch: boolean;
  thinking: boolean;
}

export interface AiComposerProps {
  /**
   * Called with every sent message. Return an async iterable of text deltas to stream a real reply into the thread
   * (Stop aborts `signal`). Return nothing and the preview plays a simulated reply.
   */
  onSend?: (message: ComposerMessage, options: { signal: AbortSignal }) => void | Promise<void> | AsyncIterable<string>;
  /** Display heading of the empty state. */
  greeting?: string;
  /** Up to three starters under the composer. Choosing one fills the composer. */
  suggestions?: Suggestion[];
  models?: ComposerModel[];
  /** Id of the model selected at first. Defaults to the first model. */
  defaultModel?: string;
  placeholder?: string;
  /** Character limit. A counter appears at 80 percent and sending stops above it. */
  maxLength?: number;
  className?: string;
}

/** waiting: the short moment before the first token. thinking and searching only run when their tool is on. */
type Phase = "waiting" | "thinking" | "searching" | "writing" | "done" | "stopped" | "error";
interface Turn {
  id: number;
  message: ComposerMessage;
  model: ComposerModel;
  phase: Phase;
  /** Reply text received so far: all of it for the simulation, growing for a live stream. */
  source: string;
  sourceDone: boolean;
  /** Characters on screen. */
  shown: number;
  /** Start offset of every revealed chunk; the newest few fade in, the rest is settled text. */
  chunks: number[];
  streamed: boolean;
  thoughtMs?: number;
  searched?: number;
  error?: string;
}

/* Timing. The pre-token moment is short; extended thinking runs a little longer at higher effort. */
const WAIT_MS = 650;
const THINK_MS: Record<Effort, number> = { low: 900, medium: 1200, high: 1500, xhigh: 1800, max: 2200 };
const SEARCH_MS = 1100;
/* Reveal clock: a chunk of whole words every ~34ms at about 80 words a second. */
const TICK_MS = 34;
const REVEAL_CPS = 480;
const MIN_CHUNK = 12;
/** How many of the newest chunks are still fading; older text renders as one settled string. */
const LIVE_CHUNKS = 6;

const running = (phase: Phase) => phase === "waiting" || phase === "thinking" || phase === "searching" || phase === "writing";
const suggestionIcon = { summary: FileText, draft: PenLine, bug: Bug } as const;

function isStream(value: unknown): value is AsyncIterable<string> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** Advance the reveal by one tick. Chunks end after a whole word and its space, so a word never fades in two halves. */
function revealStep(turn: Turn, dt: number): Turn {
  const { source, shown } = turn;
  const backlog = source.length - shown;
  if (backlog <= 0) return turn.sourceDone ? { ...turn, phase: "done" } : turn;
  // A steady rate; when a live stream runs ahead, the reveal catches up within about a third of a second.
  const rate = turn.streamed ? Math.max(REVEAL_CPS, backlog / .3) : REVEAL_CPS;
  let end = Math.min(source.length, shown + Math.max(MIN_CHUNK, Math.round((rate * dt) / 1000)));
  if (end < source.length) {
    const rest = source.slice(end).search(/\s/);
    if (rest >= 0) {
      end += rest;
      while (end < source.length && /\s/.test(source[end] ?? "")) end += 1;
    } else if (turn.sourceDone) end = source.length;
    else {
      // The last word is still arriving: show up to the space before it.
      const head = source.slice(0, end);
      end = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n")) + 1;
    }
  }
  if (end <= shown) return turn;
  const finished = end >= source.length && turn.sourceDone;
  return { ...turn, shown: end, chunks: [...turn.chunks, shown], phase: finished ? "done" : "writing" };
}

/** Ring progress for the send button: the steps before the first token fill the first part, the text fills the rest. */
function ringProgress(turn: Turn | undefined): { progress: number | null; seconds: number } {
  if (!turn) return { progress: 0, seconds: 0 };
  if (turn.streamed) return { progress: running(turn.phase) ? null : 1, seconds: .12 };
  const pre = turn.message.thinking || turn.message.webSearch ? .25 : .1;
  switch (turn.phase) {
    case "waiting": return { progress: pre, seconds: WAIT_MS / 1000 };
    case "thinking": return { progress: turn.message.webSearch ? .14 : pre, seconds: THINK_MS[turn.message.effort] / 1000 };
    case "searching": return { progress: pre, seconds: SEARCH_MS / 1000 };
    case "writing": return { progress: pre + (1 - pre) * (turn.source.length ? turn.shown / turn.source.length : 0), seconds: TICK_MS / 1000 };
    default: return { progress: 1, seconds: .1 };
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * Thread pieces
 * ------------------------------------------------------------------------------------------------------------- */

function TokenText({ text, tokens }: { text: string; tokens: string[] }) {
  const nodes: ReactNode[] = [];
  let pos = 0;
  for (const range of tokenRanges(text, tokens)) {
    if (range.start > pos) nodes.push(text.slice(pos, range.start));
    nodes.push(<span key={range.start} className={styles.sentToken}>{range.text}</span>);
    pos = range.end;
  }
  if (pos < text.length) nodes.push(text.slice(pos));
  return <>{nodes}</>;
}

function SentMessage({ turn, reduced }: { turn: Turn; reduced: boolean }) {
  const { message } = turn;
  // The message lifts out of the composer below into its bubble: one short, crisp move.
  return <motion.div className={styles.sent}
    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }}
    transition={reduced ? { duration: duration.instant } : { ...settle, opacity: { duration: duration.fast, ease: [...ease.standard] } }}>
    {message.attachments.length > 0 && <ul className={styles.sentFiles} aria-label="Attachments">
      {message.attachments.map(item => <li key={item.id} className={styles.sentFile} title={item.name}>
        <span className={styles.sentGlyph}><AttachmentGlyph item={item} size="sm" /></span>
        <span className={styles.sentName}>{item.name}</span>
      </li>)}
    </ul>}
    {message.text && <p className={styles.bubble}><TokenText text={message.text} tokens={message.tokens} /></p>}
  </motion.div>;
}

/** Follows its content's height on a short ease-out, so each new line opens up instead of jumping in. */
function Grow({ children, reduced, reserve }: { children: ReactNode; reduced: boolean; reserve: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.grow} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : { duration: duration.fast, ease: "easeOut" }}>
    <div ref={inner} className={styles.growInner} data-reserve={reserve || undefined}>{children}</div>
  </motion.div>;
}

/** Settled text is one plain string; only the newest chunks carry a short opacity fade. */
function ReplyText({ turn, reduced }: { turn: Turn; reduced: boolean }) {
  const text = turn.source.slice(0, turn.shown);
  const first = Math.max(0, turn.chunks.length - LIVE_CHUNKS);
  const settled = turn.chunks.length ? turn.chunks[first] ?? text.length : text.length;
  return <p className={styles.replyText} aria-busy={turn.phase === "writing" || undefined}>
    {text.slice(0, settled)}
    {turn.chunks.slice(first).map((start, i) => {
      const end = turn.chunks[first + i + 1] ?? text.length;
      return <span key={start} className={reduced ? undefined : styles.chunk}>{text.slice(start, end)}</span>;
    })}
  </p>;
}

function Reply({ turn, last, reduced, onRetry }: { turn: Turn; last: boolean; reduced: boolean; onRetry: () => void }) {
  const { phase, message } = turn;
  const steps: { id: string; icon: typeof Brain; label: string; active: boolean }[] = [];
  if (message.thinking && !turn.streamed) {
    steps.push({ id: "think", icon: Brain, active: phase === "thinking",
      label: phase === "thinking" ? "Thinking" : turn.thoughtMs ? `Thought for ${Math.max(1, Math.round(turn.thoughtMs / 1000))}s` : "Thinking stopped" });
  }
  if (message.webSearch && !turn.streamed) {
    const pending = phase === "thinking";
    steps.push({ id: "search", icon: Globe, active: phase === "searching",
      label: phase === "searching" || pending ? "Searching the web" : turn.searched ? `Searched ${turn.searched} sites` : "Search stopped" });
  }
  const plain = turn.source.slice(0, turn.shown).trim();
  const live = running(phase);
  return <motion.div className={styles.reply} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? duration.instant : duration.fast, ease: "easeOut" }}>
    <div className={styles.replyHead}><ModelMark mark={turn.model.mark} /><span>{turn.model.name}</span></div>
    {steps.length > 0 && <div className={styles.steps}>
      {steps.map(step => <span key={step.id} className={styles.step} data-active={step.active || undefined} data-pending={step.id === "search" && phase === "thinking" || undefined}>
        <step.icon className={styles.stepIcon} aria-hidden="true" />
        <TextShimmer active={step.active}>{step.label}</TextShimmer>
      </span>)}
    </div>}
    <Grow reduced={reduced} reserve={live}>
      {phase === "waiting"
        ? <span className={styles.pending}><TextShimmer>Thinking</TextShimmer></span>
        : turn.shown > 0 ? <ReplyText turn={turn} reduced={reduced} /> : null}
    </Grow>
    <AnimatePresence initial={false}>
      {!live && <motion.div key="foot" className={styles.replyFoot} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: reduced ? duration.instant : duration.fast, ease: "easeOut" }}>
        {phase === "stopped" && <span className={styles.footStatus}><Square className={styles.footIcon} aria-hidden="true" />Stopped</span>}
        {phase === "error" && <span className={styles.footStatus} data-tone="error"><CircleAlert className={styles.footIcon} aria-hidden="true" />{turn.error ?? "The reply did not finish"}</span>}
        {plain && <CopyButton value={plain} iconOnly variant="plain" label="Copy reply" />}
        {last && <Tooltip content="Run this message again">
          <button type="button" className={styles.footButton} onClick={onRetry}><RotateCcw aria-hidden="true" />Retry</button>
        </Tooltip>}
      </motion.div>}
    </AnimatePresence>
  </motion.div>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * The block
 * ------------------------------------------------------------------------------------------------------------- */

export function AiComposer({
  onSend,
  greeting = "What should we work on?",
  suggestions = sampleSuggestions,
  models = sampleModels,
  defaultModel,
  placeholder = "Ask anything, / for commands, @ to add context",
  maxLength = 4000,
  className,
}: AiComposerProps) {
  const reduced = Boolean(useReducedMotion());
  const [modelId, setModelId] = useState(defaultModel ?? models[0]?.id ?? "");
  const model = models.find(m => m.id === modelId) ?? models[0] ?? sampleModels[0]!;
  const [effort, setEffort] = useState<Effort>(model.defaultEffort);
  const [webSearch, setWebSearch] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const nextTurn = useRef(1);

  const announce = useCallback((message: string) => setStatus(current => (current === message ? `${message} ` : message)), []);
  const patch = useCallback((id: number, change: (turn: Turn) => Turn) => setTurns(list => list.map(t => (t.id === id ? change(t) : t))), []);

  const active = turns[turns.length - 1];
  const busy = Boolean(active && running(active.phase));
  const ring = ringProgress(active);
  const mode = turns.length ? "thread" : "new";

  /* Simulated steps before the first token: a short wait, or thinking and searching when those tools are on. */
  const stepKey = active && !active.streamed && running(active.phase) && active.phase !== "writing" ? `${active.id}:${active.phase}` : "";
  useEffect(() => {
    if (!active || !stepKey) return;
    const { id, phase, message } = active;
    const ms = phase === "thinking" ? THINK_MS[message.effort] : phase === "searching" ? SEARCH_MS : WAIT_MS;
    const timer = window.setTimeout(() => patch(id, t => {
      if (t.phase !== phase) return t;
      if (phase === "thinking") return { ...t, phase: message.webSearch ? "searching" : "writing", thoughtMs: ms };
      if (phase === "searching") return { ...t, phase: "writing", searched: 6 };
      return { ...t, phase: "writing" };
    }), ms);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one schedule per turn phase
  }, [stepKey]);

  /* The reveal clock: on animation frames, a chunk of whole words every ~34ms. */
  const writingId = active?.phase === "writing" ? active.id : 0;
  useEffect(() => {
    if (!writingId) return;
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (last && now - last < TICK_MS) return;
      const dt = last ? Math.min(now - last, 100) : TICK_MS;
      last = now;
      setTurns(list => {
        const at = list.findIndex(t => t.id === writingId);
        const turn = list[at];
        if (!turn || turn.phase !== "writing") return list;
        const next = revealStep(turn, dt);
        if (next === turn) return list;
        const copy = list.slice();
        copy[at] = next;
        return copy;
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [writingId]);

  const lastPhase = active?.phase;
  useEffect(() => {
    if (lastPhase === "done") announce("Reply finished");
    else if (lastPhase === "stopped") announce("Reply stopped");
    else if (lastPhase === "error") announce("The reply did not finish");
  }, [lastPhase, announce]);

  /* Stick to the newest line while the reply grows, unless someone scrolled up to read. */
  useEffect(() => {
    const thread = threadRef.current;
    const content = thread?.firstElementChild;
    if (!thread || !content) return;
    const observer = new ResizeObserver(() => { if (follow.current) thread.scrollTop = thread.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [mode]);

  async function consume(id: number, stream: AsyncIterable<string>, signal: AbortSignal) {
    try {
      for await (const delta of stream) {
        if (signal.aborted) return;
        patch(id, t => ({ ...t, source: t.source + delta, phase: t.phase === "waiting" ? "writing" : t.phase }));
      }
      if (!signal.aborted) patch(id, t => ({ ...t, sourceDone: true, phase: t.phase === "waiting" ? "done" : t.phase }));
    } catch (error) {
      if (!signal.aborted) patch(id, t => ({ ...t, phase: "error", sourceDone: true, shown: t.source.length, error: error instanceof Error && error.message ? error.message : undefined }));
    }
  }

  function start(message: ComposerMessage, replaceId?: number) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    let result: ReturnType<NonNullable<AiComposerProps["onSend"]>>;
    try {
      result = onSend?.(message, { signal: controller.signal });
    } catch {
      result = undefined;
    }
    const stream = isStream(result) ? result : null;
    const turnModel = models.find(m => m.id === message.model) ?? model;
    const turn: Turn = {
      id: nextTurn.current++, message, model: turnModel, streamed: Boolean(stream),
      phase: stream ? "waiting" : message.thinking ? "thinking" : message.webSearch ? "searching" : "waiting",
      source: stream ? "" : sampleReply(message.text), sourceDone: !stream, shown: 0, chunks: [],
    };
    follow.current = true;
    setTurns(list => (replaceId ? list.map(t => (t.id === replaceId ? turn : t)) : [...list, turn]));
    announce(stream ? `Sent. ${turnModel.name} is replying` : `Sent. Simulated reply from ${turnModel.name}`);
    if (stream) void consume(turn.id, stream, controller.signal);
  }

  function submit(draft: ComposerDraft) {
    start({ ...draft, files: draft.attachments.map(a => a.name), model: model.id, effort, webSearch, thinking });
  }

  function stop() {
    if (!active || !running(active.phase)) return;
    abort.current?.abort();
    patch(active.id, t => ({ ...t, phase: "stopped" }));
  }

  function newChat() {
    abort.current?.abort();
    setTurns([]);
    announce("New chat");
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function changeModel(id: string) {
    const next = models.find(m => m.id === id);
    if (!next) return;
    setModelId(id);
    announce(`${next.name} selected`);
  }

  function toggleTool(tool: "search" | "thinking") {
    if (tool === "search") { setWebSearch(on => !on); announce(webSearch ? "Web search off" : "Web search on"); }
    else { setThinking(on => !on); announce(thinking ? "Extended thinking off" : "Extended thinking on"); }
  }

  /* Files dragged anywhere over the block land in the composer. */
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const drag = {
    onDragEnter: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current += 1; setDragging(true); },
    onDragOver: (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; },
    onDragLeave: (event: DragEvent) => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      composerRef.current?.addFiles(Array.from(event.dataTransfer.files));
      composerRef.current?.focus();
    },
  };

  return <section className={cx(styles.root, className)} aria-label="Chat" {...drag}>
    <AnimatePresence initial={false}>
      {mode === "thread" && <motion.div key="new" className={styles.topBar} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={{ duration: duration.standard, delay: reduced ? 0 : .2 }}>
        <Tooltip content="New chat" side="left">
          <button type="button" className={styles.iconButton} aria-label="New chat" onClick={newChat}><SquarePen aria-hidden="true" /></button>
        </Tooltip>
      </motion.div>}
    </AnimatePresence>

    <div className={styles.stage} data-mode={mode}>
      {mode === "new"
        ? <motion.div key="greeting" className={styles.intro} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.considered, ease: [...ease.enter] }}>
            <h2 className={styles.greeting}>{greeting}</h2>
          </motion.div>
        : <div ref={threadRef} className={styles.thread} onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
            <ol className={styles.turns}>
              {turns.map((turn, i) => <li key={turn.id} className={styles.turn}>
                <SentMessage turn={turn} reduced={reduced} />
                <Reply turn={turn} last={i === turns.length - 1} reduced={reduced} onRetry={() => start(turn.message, turn.id)} />
              </li>)}
            </ol>
          </div>}

      <motion.div className={styles.dock} layout={reduced ? false : "position"} layoutDependency={mode} transition={spring.smooth}>
        <Composer ref={composerRef} models={models} model={model} effort={effort} webSearch={webSearch} thinking={thinking}
          onModel={changeModel} onEffort={level => { setEffort(level); announce(`${effortLabel[level]} effort`); }} onTool={toggleTool}
          busy={busy} progress={ring.progress} progressSeconds={ring.seconds} run={active?.id ?? 0}
          placeholder={placeholder} maxLength={maxLength} reduced={reduced} onSubmit={submit} onStop={stop} announce={announce} />
      </motion.div>

      {mode === "new" && suggestions.length > 0 && <motion.ul key="suggestions" className={styles.suggestions} aria-label="Suggestions"
        initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.considered, ease: [...ease.enter], delay: reduced ? 0 : .06 }}>
        {suggestions.slice(0, 3).map(s => {
          const Icon = s.icon ? suggestionIcon[s.icon] : null;
          return <li key={s.id}><button type="button" className={styles.suggestion} onClick={() => composerRef.current?.fill(s.prompt)}>
            {Icon && <Icon className={styles.suggestionIcon} aria-hidden="true" />}{s.label}
          </button></li>;
        })}
      </motion.ul>}
    </div>

    <AnimatePresence>
      {dragging && <motion.div key="drop" className={styles.drop} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.fast }}>
        <motion.span className={styles.dropInner} initial={reduced ? false : { y: 6 }} animate={{ y: 0 }} transition={reduced ? { duration: 0 } : settle}>
          <Upload className={styles.dropIcon} aria-hidden="true" />
          <span className={styles.dropTitle}>Drop files to attach</span>
          <span className={styles.dropNote}>PDFs, images, code and text, up to 30 MB each</span>
        </motion.span>
      </motion.div>}
    </AnimatePresence>

    <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
  </section>;
}

export default AiComposer;
