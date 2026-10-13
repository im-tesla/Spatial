import { useEffect } from "react";
import { motion, useMotionValue, useTransform } from "motion/react";
import { lyricLineProgress } from "./lyrics";
import { softwareRendering } from "./rendering";

// A line's start and next cue drive this visual fill. No word timings are inferred.
export default function LyricText({ text, position, start, end, running, reduced }: {
  text: string; position: number; start: number; end: number; running: boolean; reduced: boolean;
}) {
  const progress = useMotionValue(lyricLineProgress(position, start, end));
  const fill = useTransform(progress, value => `inset(0 0 ${Math.max(0, 100 - value * 120)}% 0)`);
  const glow = useTransform(progress, value => reduced || softwareRendering ? "none"
    : `0 0 16px rgb(255 255 255 / ${.08 + Math.sin(value * Math.PI) * .2}), 0 0 38px color-mix(in srgb, var(--accent) 15%, transparent)`);
  useEffect(() => {
    progress.set(lyricLineProgress(position, start, end));
    if (!running || reduced || softwareRendering) return;
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
  return <motion.span className="lyric-ink lyric-ink-active" style={{ textShadow: glow }}>
    <span className="lyric-ink-base">{text}</span>
    <motion.span className="lyric-ink-fill" aria-hidden="true" style={{ clipPath: fill }}>{text}</motion.span>
  </motion.span>;
}
