import { useEffect } from "react";
import { motion, useMotionValue, useTransform } from "motion/react";
import type { MotionStyle } from "motion/react";
import { lyricLineProgress } from "./lyrics";

// A line's start and next cue drive this visual fill. No word timings are inferred.
export default function LyricText({ text, position, start, end, running, reduced }: {
  text: string; position: number; start: number; end: number; running: boolean; reduced: boolean;
}) {
  const progress = useMotionValue(lyricLineProgress(position, start, end));
  const fill = useTransform(progress, value => `${value * 120}%`);
  const glow = useTransform(progress, value => reduced ? "none"
    : `0 0 16px rgb(255 255 255 / ${.08 + Math.sin(value * Math.PI) * .2}), 0 0 38px color-mix(in srgb, var(--accent) 15%, transparent)`);
  useEffect(() => {
    progress.set(lyricLineProgress(position, start, end));
    if (!running || reduced) return;
    let frame = 0;
    const sampled = performance.now();
    const paint = (now: number) => {
      // Interpolate between native samples, then hold if fresh playback data stops.
      const elapsed = Math.min(.8, Math.max(0, (now - sampled) / 1000));
      progress.set(lyricLineProgress(position + elapsed, start, end));
      if (elapsed < .8) frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [position, start, end, running, reduced, progress]);
  return <motion.span className="lyric-ink lyric-ink-active" style={{ "--lyric-fill": fill, textShadow: glow } as MotionStyle}>{text}</motion.span>;
}
