"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useReducedMotion, type Transition } from "motion/react";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./agent-run.module.css";

const { spring, duration } = motionTokens;
export const easeOut = [...motionTokens.ease.enter] as [number, number, number, number];
/** Small, fast moves: critically damped, so nothing overshoots. */
export const settle: Transition = { type: "spring", visualDuration: .22, bounce: 0 };

export function useMotionPrefs() {
  const reduce = !!useReducedMotion();
  return {
    reduce,
    /** Height of panels and rows. */
    height: (reduce ? { duration: 0 } : spring.smooth) as Transition,
  };
}

/**
 * One label at a time in the same slot. The old label fades out fast, the new one fades in from 2px below, and the slot
 * follows the new width on a critically damped spring, so text after it glides instead of jumping.
 */
export function Swap({ swapKey, children, className }: { swapKey: string; children: ReactNode; className?: string }) {
  const { reduce } = useMotionPrefs();
  const stage = useRef<HTMLSpanElement>(null);
  const rest = useRef(0);

  useLayoutEffect(() => {
    const node = stage.current;
    if (!node) return;
    const sizing = Boolean(node.style.width);
    const current = node.getBoundingClientRect().width;
    node.style.width = "";
    const next = node.getBoundingClientRect().width;
    const from = sizing ? current : rest.current;
    rest.current = next;
    if (reduce || !from || Math.abs(from - next) < .5) { delete node.dataset.sizing; return; }
    node.dataset.sizing = "";
    const controls = animate(node, { width: [from, next] }, { ...settle, onComplete: () => { node.style.width = ""; delete node.dataset.sizing; } });
    return () => controls.stop();
  }, [swapKey, reduce]);

  // Keep the resting width current when fonts load or the container changes.
  useEffect(() => {
    const node = stage.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (!node.style.width) rest.current = node.getBoundingClientRect().width; });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <span ref={stage} className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={swapKey} className={styles.swapItem}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: reduce ? 0 : .1 } }}
        transition={{ duration: reduce ? 0 : duration.fast, ease: easeOut }}>{children}</motion.span>
    </AnimatePresence>
  </span>;
}

/** Opens and closes its content in place: height on the smooth spring, opacity on a short fade. */
export function Collapse({ open, children, id, className, label }: { open: boolean; children: ReactNode; id?: string; className?: string; label?: string }) {
  const { reduce, height } = useMotionPrefs();
  return <AnimatePresence initial={false}>
    {open && <motion.div key="open" id={id} role={label ? "region" : undefined} aria-label={label} className={[styles.collapse, className].filter(Boolean).join(" ")}
      initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0, transition: { height, opacity: { duration: reduce ? 0 : .1 } } }}
      transition={{ height, opacity: { duration: reduce ? 0 : duration.fast, ease: easeOut } }}>
      {children}
    </motion.div>}
  </AnimatePresence>;
}

/** Height follows the content on the smooth spring, so swapping what is inside never resizes in one frame. */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const { height: transition } = useMotionPrefs();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.autoHeight} initial={false} animate={{ height }} transition={transition}>
    <div ref={inner} className={className}>{children}</div>
  </motion.div>;
}

/** A check that draws its stroke once, quickly, when it appears. */
export function DrawCheck({ size = 14, className }: { size?: number; className?: string }) {
  const { reduce } = useMotionPrefs();
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M4.5 12.5l5 5L19.5 7" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .2, ease: easeOut }} />
  </svg>;
}
