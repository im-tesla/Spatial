import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { lyricWordState } from "./lyrics";
import type { LyricWord } from "./lyrics";
import { softwareRendering } from "./rendering";

export default function LyricText({ text, words, position, running, reduced }: {
  text: string; words?: LyricWord[]; position: number; running: boolean; reduced: boolean;
}) {
  const [clock, setClock] = useState({ sample: position, value: position });
  useEffect(() => {
    if (!words?.length) return;
    setClock({ sample: position, value: position });
    if (!running) return;
    const sampled = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const advance = () => {
      // Follow native playback samples; never advance indefinitely on stale data.
      const elapsed = Math.min(.8, Math.max(0, (performance.now() - sampled) / 1000));
      const now = position + elapsed;
      setClock({ sample: position, value: now });
      const next = words.flatMap(word => [word.start, word.end]).filter(time => time > now && time <= position + .8);
      if (next.length) timer = setTimeout(advance, Math.max(1, (Math.min(...next) - now) * 1000));
    };
    advance();
    return () => clearTimeout(timer);
  }, [position, words, running]);

  if (!words?.length) return <span className="lyric-ink lyric-ink-active">{text}</span>;
  const now = running && clock.sample === position ? clock.value : position;
  return <span className="lyric-ink lyric-ink-active lyric-word-timed">{words.map((word, index) => {
    const state = lyricWordState(word, now);
    return <motion.span key={index} className="lyric-word" data-word-state={state}
      animate={{ opacity: state === "upcoming" ? .38 : state === "active" ? 1 : .86,
        textShadow: state === "active" && !reduced && !softwareRendering
          ? "0 0 14px rgb(255 255 255 / .3), 0 0 30px color-mix(in srgb, var(--accent) 24%, transparent)" : "none" }}
      transition={{ duration: reduced || softwareRendering ? 0 : .12 }}>{word.text}</motion.span>;
  })}</span>;
}
