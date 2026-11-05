"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Brain, Check, ChevronDown, CircleAlert, ClipboardPaste, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Globe, Paperclip, Plus, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Tooltip } from "../../tooltip/tooltip";
import { ClaudeMark, FigmaMark, GeminiColorMark, GithubMark, GoogledriveMark, LinearMark, NotionMark, OpenaiMark } from "./composer-marks";
import { efforts, type ComposerModel, type ContextKind, type Effort, type ModelMarkId } from "./composer-data";
import { useComposerSlots } from "./composer-slots";
import styles from "./ai-composer.module.css";

const { spring, duration, ease } = motionTokens;
/** Moves, resizes and swaps settle without overshoot, so nothing wobbles. */
const settle = { type: "spring", visualDuration: 0.24, bounce: 0 } as const;
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/* ---------------------------------------------------------------------------------------------------------------
 * Attachments
 * ------------------------------------------------------------------------------------------------------------- */

export type AttachmentSource = "file" | "paste" | "drive" | "github" | "screenshot";
export type FileKind = "pdf" | "code" | "sheet" | "doc" | "image" | "archive" | "text";
export type AttachmentStatus = "uploading" | "done" | "ready" | "error";

export interface ComposerAttachment {
  id: string;
  source: AttachmentSource;
  kind: FileKind;
  name: string;
  /** Short detail under the name once ready, for example "PDF, 2.4 MB" or "42 líneas". */
  meta: string;
  size: number;
  status: AttachmentStatus;
  /** Upload progress from 0 to 1. */
  progress: number;
  error?: string;
  /** Image preview URL. */
  thumb?: string;
  /** The pasted text, for pasted attachments. */
  text?: string;
  /** The real file, when one was picked, dropped or pasted. */
  file?: File;
  /** Where a real upload landed; only set when the composer has an `upload` handler. */
  url?: string;
  /** Progress comes from a real upload, so the simulated ring leaves it alone. */
  remote?: boolean;
}

const codeExt = new Set(["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs", "rb", "java", "kt", "swift", "css", "html", "json", "sh", "sql", "yml", "yaml", "md"]);
const sheetExt = new Set(["csv", "tsv", "xls", "xlsx", "numbers"]);
const archiveExt = new Set(["zip", "tar", "gz", "rar", "7z"]);

export function fileKind(name: string, type: string): FileKind {
  if (type.startsWith("image/")) return "image";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (codeExt.has(ext)) return "code";
  if (sheetExt.has(ext)) return "sheet";
  if (archiveExt.has(ext)) return "archive";
  if (ext === "txt") return "text";
  return "doc";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const kindIcon: Record<FileKind, typeof FileText> = { pdf: FileText, code: FileCode, sheet: FileSpreadsheet, doc: FileText, image: FileImage, archive: FileArchive, text: FileText };

/** The attachment's own glyph: an image preview, the source's mark, or a plain file type icon. */
export function AttachmentGlyph({ item, size = "md" }: { item: ComposerAttachment; size?: "md" | "sm" }) {
  if (item.thumb) {
    // eslint-disable-next-line @next/next/no-img-element -- local object URLs and data URIs, not optimizable
    return <img className={size === "sm" ? styles.thumbSmall : styles.thumb} src={item.thumb} alt="" draggable={false} />;
  }
  if (item.source === "drive") return <GoogledriveMark className={styles.glyph} aria-hidden="true" />;
  if (item.source === "github") return <GithubMark className={styles.glyph} aria-hidden="true" />;
  if (item.source === "paste") return <ClipboardPaste className={styles.glyph} aria-hidden="true" />;
  const Icon = kindIcon[item.kind];
  return <Icon className={styles.glyph} aria-hidden="true" />;
}

/** A small ring that fills while the upload runs. */
function Ring({ progress }: { progress: number }) {
  return <svg className={styles.ring} viewBox="0 0 18 18" aria-hidden="true">
    <circle className={styles.ringTrack} cx="9" cy="9" r="7" />
    <circle className={styles.ringFill} cx="9" cy="9" r="7" pathLength={1} strokeDasharray="1 1" style={{ strokeDashoffset: 1 - progress }} />
  </svg>;
}

export function AttachmentChip({ item, reduced, onRemove }: { item: ComposerAttachment; reduced: boolean; onRemove: (id: string) => void }) {
  const { copy } = useComposerSlots();
  const percent = Math.round(item.progress * 100);
  const label = item.status === "uploading" ? copy.cancelUpload(item.name) : copy.remove(item.name);
  const swap = reduced ? { duration: 0 } : settle;
  return <motion.li layout={reduced ? false : "position"} className={styles.chip} data-status={item.status} title={item.name}
    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }}
    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .92, transition: { duration: duration.fast, ease: [...ease.standard] } }}
    transition={reduced ? { duration: duration.fast } : settle}>
    <span className={cx(styles.chipGlyph, item.thumb && styles.chipGlyphImage)}><AttachmentGlyph item={item} /></span>
    <span className={styles.chipText}>
      <span className={styles.chipName}>{item.name}</span>
      <span className={styles.chipMeta} aria-live="off">
        {item.status === "error"
          ? <><CircleAlert className={styles.chipMetaIcon} aria-hidden="true" />{item.error}</>
          : item.status === "uploading" ? <span className={styles.tabular}>{copy.uploadPercent(percent)}</span>
          : item.meta}
      </span>
    </span>
    <button type="button" className={styles.chipAction} aria-label={label} onClick={event => { event.stopPropagation(); onRemove(item.id); }}>
      <AnimatePresence mode="popLayout" initial={false}>
        {item.status === "uploading"
          ? <motion.span key="ring" className={styles.chipActionGlyph} exit={{ opacity: 0, scale: .6, transition: { duration: duration.instant } }}><Ring progress={item.progress} /></motion.span>
          : item.status === "done"
            ? <motion.span key="check" className={cx(styles.chipActionGlyph, styles.chipCheck)} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6, transition: { duration: duration.fast } }} transition={swap}><Check aria-hidden="true" /></motion.span>
            : <motion.span key="remove" className={styles.chipActionGlyph} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .6, rotate: -45 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={swap}><X aria-hidden="true" /></motion.span>}
      </AnimatePresence>
    </button>
  </motion.li>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Marks
 * ------------------------------------------------------------------------------------------------------------- */

export function ModelMark({ mark, className }: { mark: ModelMarkId; className?: string }) {
  if (mark === "claude") return <ClaudeMark className={cx(styles.modelMark, styles.claudeMark, className)} aria-hidden="true" />;
  if (mark === "openai") return <OpenaiMark className={cx(styles.modelMark, className)} aria-hidden="true" />;
  return <GeminiColorMark className={cx(styles.modelMark, className)} aria-hidden="true" />;
}

export function ContextGlyph({ kind }: { kind: ContextKind }) {
  if (kind === "notion") return <NotionMark className={styles.optionGlyph} aria-hidden="true" />;
  if (kind === "linear") return <LinearMark className={styles.optionGlyph} aria-hidden="true" />;
  if (kind === "figma") return <FigmaMark className={styles.optionGlyph} aria-hidden="true" />;
  const Icon = kind === "code" ? FileCode : kind === "sheet" ? FileSpreadsheet : FileText;
  return <Icon className={styles.optionGlyph} aria-hidden="true" />;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Width that follows content
 * ------------------------------------------------------------------------------------------------------------- */

/** Springs its width to the measured content, so a new label never resizes the chip in one frame. */
export function MorphWidth({ children, reduced, className }: { children: ReactNode; reduced: boolean; className?: string }) {
  const inner = useRef<HTMLSpanElement>(null);
  const measured = useRef(false);
  const [size, setSize] = useState<{ width: number | "auto"; animate: boolean }>({ width: "auto", animate: false });
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const animate = measured.current;
      measured.current = true;
      setSize({ width: Math.ceil(entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth), animate });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.span className={cx(styles.morph, className)} initial={false} animate={{ width: size.width }} transition={size.animate && !reduced ? settle : { duration: 0 }}>
    <span ref={inner} className={styles.morphInner}>{children}</span>
  </motion.span>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Send button: arrow, then a stop square ringed by the reply's progress
 * ------------------------------------------------------------------------------------------------------------- */

export type SendState = "empty" | "blocked" | "ready" | "generating";

export function SendButton({ state, progress, progressSeconds, run, label, reduced, onSend, onStop }: {
  state: SendState;
  /** 0 to 1 while generating; null spins an open arc when the length is unknown. */
  progress: number | null;
  /** How long the ring takes to reach `progress`, so a phase fills at its own pace. */
  progressSeconds: number;
  run: number;
  label: string;
  reduced: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const generating = state === "generating";
  const enabled = state === "ready" || generating;
  const determinate = progress !== null;
  // After a reply the arc keeps its last length while it fades; a new run remounts it empty.
  const offset = determinate ? 1 - Math.max(.02, progress) : .72;
  return <Tooltip content={label}>
    <motion.button type="button" className={styles.send} data-state={state} aria-label={label} aria-disabled={!enabled || undefined}
      onClick={() => { if (generating) onStop(); else if (state === "ready") onSend(); }}
      whileTap={enabled && !reduced ? { scale: .92 } : undefined} transition={spring.snappy}>
      <svg className={styles.sendRing} data-spin={generating && !determinate && !reduced || undefined} viewBox="0 0 44 44" aria-hidden="true">
        <motion.circle className={styles.sendTrack} cx="22" cy="22" r="20.5" initial={false} animate={{ opacity: generating ? 1 : 0 }} transition={{ duration: reduced ? 0 : duration.standard }} />
        <motion.circle key={run} className={styles.sendArc} cx="22" cy="22" r="20.5" pathLength={1} strokeDasharray="1 1" initial={{ strokeDashoffset: 1, opacity: 0 }}
          animate={{ strokeDashoffset: offset, opacity: generating ? 1 : 0 }}
          transition={{ strokeDashoffset: reduced ? { duration: 0 } : { duration: Math.max(.12, progressSeconds), ease: "linear" }, opacity: { duration: reduced ? 0 : duration.standard, delay: generating || reduced ? 0 : .12 } }} />
      </svg>
      <AnimatePresence mode="popLayout" initial={false}>
        {generating
          ? <motion.span key="stop" className={styles.sendGlyph}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .3, borderRadius: 8 }} animate={{ opacity: 1, scale: 1, borderRadius: 3 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .3, transition: { duration: duration.fast, ease: [...ease.standard] } }}
              transition={reduced ? { duration: 0 } : settle}><span className={styles.stopGlyph} /></motion.span>
          : <motion.span key="arrow" className={styles.sendGlyph}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -14, transition: { duration: duration.fast, ease: [...ease.exit] } }}
              transition={reduced ? { duration: 0 } : settle}><ArrowUp aria-hidden="true" /></motion.span>}
      </AnimatePresence>
    </motion.button>
  </Tooltip>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Toolbar pieces
 * ------------------------------------------------------------------------------------------------------------- */

export function ToolChip({ tool, on, onToggle }: { tool: "search" | "thinking"; on: boolean; onToggle: () => void }) {
  const { copy } = useComposerSlots();
  const Icon = tool === "search" ? Globe : Brain;
  const label = tool === "search" ? copy.searchLabel : copy.thinkingLabel;
  const tip = tool === "search" ? (on ? copy.searchOn : copy.searchOff) : (on ? copy.thinkingOn : copy.thinkingOff);
  return <Tooltip content={tip}>
    <button type="button" className={styles.toolChip} aria-pressed={on} aria-label={label} onClick={onToggle}>
      <Icon className={styles.toolIcon} aria-hidden="true" />
      <span className={styles.toolLabel}>{label}</span>
    </button>
  </Tooltip>;
}

export function AttachMenu({ onUpload, onDrive, onGithub, onClosedAfterPick }: {
  onUpload: () => void; onDrive?: () => void; onGithub?: () => void;
  /** Called on close when an item was chosen, so focus can return to the text instead of the trigger. */
  onClosedAfterPick: () => void;
}) {
  const { copy, menu } = useComposerSlots();
  const picked = useRef(false);
  const item = (key: string, icon: ReactNode, text: string, run: () => void) =>
    <Menu.Item key={key} className={styles.menuItem} onSelect={() => { picked.current = true; run(); }}>
      <span className={styles.menuIcon} aria-hidden="true">{icon}</span>{text}
    </Menu.Item>;
  return <Menu.Root modal={false}>
    <Tooltip content={copy.attachTip}>
      <Menu.Trigger asChild><button type="button" className={styles.iconButton} aria-label={copy.attachTip}><Plus aria-hidden="true" /></button></Menu.Trigger>
    </Tooltip>
    <Menu.Portal>
      <Menu.Content className={styles.menu} side="top" align="start" sideOffset={8} collisionPadding={12} loop
        onCloseAutoFocus={event => { if (picked.current) { event.preventDefault(); picked.current = false; onClosedAfterPick(); } }}>
        {item("upload", <Paperclip />, copy.uploadOption, onUpload)}
        {onDrive && item("drive", <GoogledriveMark />, copy.driveOption, onDrive)}
        {onGithub && item("github", <GithubMark />, copy.githubOption, onGithub)}
        {menu && <><Menu.Separator className={styles.menuSeparator} />{menu}</>}
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export function ModelMenu({ models, model, effort, reduced, onModel, onEffort }: {
  models: ComposerModel[]; model: ComposerModel; effort: Effort; reduced: boolean;
  onModel: (id: string) => void; onEffort: (effort: Effort) => void;
}) {
  const { copy, mark } = useComposerSlots();
  const markOf = (id: ModelMarkId) => (mark ? mark(id) : <ModelMark mark={id} />);
  // Left and right walk the effort row; Radix handles up and down.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const viaPointer = useRef(false);
  // Choosing with the pointer returns focus to the chip without the keyboard focus ring.
  function onCloseAutoFocus(event: Event) {
    if (!viaPointer.current) return;
    event.preventDefault();
    triggerRef.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
  }
  function effortKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitemradio']"));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const next = items[(at + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }
  return <Menu.Root modal={false}>
    <Menu.Trigger asChild><button ref={triggerRef} type="button" className={styles.modelChip} onPointerDown={() => { viaPointer.current = true; }} onKeyDown={() => { viaPointer.current = false; }} aria-label={copy.modelAria(model.name, copy.effort[effort])}>{markOf(model.mark)}<MorphWidth reduced={reduced} className={styles.modelText}>
                <span className={styles.modelName}>{model.short}</span>
                <span className={styles.modelEffort}>{copy.effort[effort]}</span>
              </MorphWidth><ChevronDown className={styles.chevron} aria-hidden="true" /></button></Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={cx(styles.menu, styles.modelMenu)} side="top" align="end" sideOffset={8} collisionPadding={12} loop onCloseAutoFocus={onCloseAutoFocus} onPointerDownCapture={() => { viaPointer.current = true; }} onKeyDownCapture={() => { viaPointer.current = false; }}>
        <Menu.RadioGroup value={model.id} onValueChange={onModel}>
          {models.map(m => <Menu.RadioItem key={m.id} value={m.id} className={cx(styles.menuItem, styles.modelItem)}>
            {markOf(m.mark)}
            <span className={styles.modelItemText}>
              <span className={styles.modelItemName}>{m.name}</span>
              <span className={styles.modelItemNote}>{m.note}</span>
            </span>
            <Menu.ItemIndicator className={styles.modelCheck}><Check aria-hidden="true" /></Menu.ItemIndicator>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
        <Menu.Separator className={styles.menuSeparator} />
        <Menu.Label className={styles.effortHead}><span>{copy.effortHead}</span><span className={styles.effortHint}>{copy.effortHint[effort]}</span></Menu.Label>
        <Menu.RadioGroup value={effort} onValueChange={value => onEffort(value as Effort)} className={styles.effortRow} onKeyDown={effortKeys}>
          {efforts.map(level => <Menu.RadioItem key={level} value={level} className={styles.effortItem} onSelect={event => event.preventDefault()}>
            {level === effort && <motion.span layoutId="ai-composer-effort" className={styles.effortThumb} transition={reduced ? { duration: 0 } : settle} />}
            <span className={styles.effortText}>{copy.effort[level]}</span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Character counter: a ring that appears near the limit
 * ------------------------------------------------------------------------------------------------------------- */

export function LimitCounter({ length, max }: { length: number; max: number }) {
  const ratio = length / max;
  const over = length > max;
  const tone = over ? "over" : ratio >= .95 ? "near" : "calm";
  const { copy } = useComposerSlots();
  const left = max - length;
  const n = (v: number) => v.toLocaleString("es");
  const detail = over ? copy.limitOverDetail(n(-left)) : copy.limitLeftDetail(n(left), n(max));
  return <Tooltip content={detail}><span className={styles.counter} data-tone={tone}>
    {over
      ? <CircleAlert className={styles.counterIcon} aria-hidden="true" />
      : <svg className={styles.counterRing} viewBox="0 0 20 20" aria-hidden="true">
          <circle className={styles.ringTrack} cx="10" cy="10" r="8" />
          <circle className={styles.counterFill} cx="10" cy="10" r="8" pathLength={1} strokeDasharray="1 1" style={{ strokeDashoffset: 1 - Math.min(1, ratio) }} />
        </svg>}
    <span className={styles.counterText}>{over ? copy.limitOverShort(n(-left)) : copy.limitLeftShort(n(left))}</span>
    <span className={styles.srOnly}>{detail}</span>
  </span></Tooltip>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Dictation waveform (simulated)
 * ------------------------------------------------------------------------------------------------------------- */

const BARS = 56;

/** Speech-like levels: syllables inside words, short gaps between them, then silence once the sentence is spoken. */
function level(t: number, speechMs: number) {
  if (t > speechMs) return .05 + Math.random() * .04;
  const s = t / 1000;
  const syllable = Math.abs(Math.sin(s * 11.3)) * .6 + Math.abs(Math.sin(s * 4.7 + 1.3)) * .4;
  const word = Math.sin(s * 2.4) > -.55 ? 1 : .15;
  return Math.min(1, .1 + syllable * word * (.65 + Math.random() * .45));
}

export function Waveform({ startedAt, speechMs, reduced, source }: { startedAt: number; speechMs: number; reduced: boolean; source?: () => number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bars = Array.from(ref.current?.children ?? []) as HTMLElement[];
    const levels = new Array<number>(BARS).fill(.06);
    if (reduced) {
      bars.forEach((bar, i) => { bar.style.transform = `scaleY(${.18 + .3 * Math.abs(Math.sin(i * .7))})`; });
      return;
    }
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 70) {
        last = now;
        levels.shift();
        levels.push(source ? Math.max(.06, source()) : level(Date.now() - startedAt, speechMs));
        bars.forEach((bar, i) => { bar.style.transform = `scaleY(${Math.max(.06, levels[i] ?? 0)})`; });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [startedAt, speechMs, reduced, source]);
  return <span ref={ref} className={styles.wave} aria-hidden="true">
    {Array.from({ length: BARS }, (_, i) => <span key={i} className={styles.bar} />)}
  </span>;
}

export function Elapsed({ from }: { from: number }) {
  const [now, setNow] = useState(from);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  return <span className={cx(styles.timer, styles.tabular)}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span>;
}
