"use client";

import { useEffect, useMemo, useState } from "react";
import { useMotionPrefs } from "./run-motion";
import styles from "./agent-run.module.css";

/** Chunk sizes in words, cycled so the rhythm reads like a real stream rather than a metronome. */
const SIZES = [4, 6, 3, 5, 7, 4, 5];
const TICK = 34;

function chunk(text: string) {
  const words = text.split(" ");
  const chunks: string[] = [];
  for (let i = 0, n = 0; i < words.length; n++) {
    const size = SIZES[n % SIZES.length];
    chunks.push(words.slice(i, i + size).join(" ") + (i + size < words.length ? " " : ""));
    i += size;
  }
  return chunks;
}

/**
 * Streams a closing message in chunks of a few words every ~34ms on the animation frame clock. Every chunk is laid out
 * from the start and only fades in, so lines never reflow and nothing below the text moves while it streams.
 */
export function StreamedText({ text, className }: { text: string; className?: string }) {
  const { reduce } = useMotionPrefs();
  const chunks = useMemo(() => chunk(text), [text]);
  const [shown, setShown] = useState(reduce ? chunks.length : 0);

  useEffect(() => {
    if (reduce) return;
    let frame = 0, start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      const next = Math.min(chunks.length, 1 + Math.floor((now - start) / TICK));
      setShown(next);
      if (next < chunks.length) frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [chunks, reduce]);

  return <p className={className}>
    {chunks.map((part, i) => <span key={i} className={styles.chunk} data-shown={reduce || i < shown || undefined}>{part}</span>)}
  </p>;
}
