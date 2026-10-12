import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Heart, LoaderCircle, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { ease } from "./motion";

export const formatTime = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}`;

export function FavoriteButton({ active, label, onClick, disabled = false }: { active: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  const reduced = useReducedMotion();
  return <motion.button className={`icon-button favorite-button ${active ? "is-favorite" : ""}`} aria-pressed={active}
    whileTap={disabled || reduced ? undefined : { scale: .88 }}
    aria-label={`${active ? "Remove" : "Add"} ${label} ${active ? "from" : "to"} favorites`} onClick={onClick} disabled={disabled}>
    <motion.span className="favorite-glyph" initial={false} animate={{ scale: active && !reduced ? [1, 1.22, 1] : 1 }}
      transition={{ duration: reduced ? 0 : .32, ease }}><Heart size={16} fill={active ? "currentColor" : "none"} /></motion.span>
  </motion.button>;
}

export type PlaybackControlsProps = {
  playing: boolean; starting: boolean; hasTrack: boolean; canPrevious: boolean; canNext: boolean;
  shuffle: boolean; repeat: "off" | "all" | "one";
  onShuffle: () => void; onRepeat: () => void; onPrevious: () => void; onNext: () => void; onPlay: () => void;
};

export function PlaybackControls({ playing, starting, hasTrack, canPrevious, canNext, shuffle, repeat,
  onShuffle, onRepeat, onPrevious, onNext, onPlay }: PlaybackControlsProps) {
  const reduced = useReducedMotion();
  return <div className="transport-buttons" role="group" aria-label="Playback controls">
    <button className={`icon-button ${shuffle ? "is-active" : ""}`} aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
      title={shuffle ? "Shuffle: On" : "Shuffle: Off"} aria-pressed={shuffle} onClick={onShuffle}><Shuffle size={17} /></button>
    <button className="icon-button" aria-label="Previous track" disabled={!hasTrack || starting || !canPrevious} onClick={onPrevious}>
      <SkipBack size={18} fill="currentColor" /></button>
    <motion.button className="play-button" aria-label={playing ? "Pause" : "Play"} whileTap={!hasTrack || starting || reduced ? undefined : { scale: .9 }}
      disabled={!hasTrack || starting} onClick={onPlay}>
      <AnimatePresence initial={false} mode="wait"><motion.span className="play-glyph" key={starting ? "loading" : playing ? "pause" : "play"}
        initial={{ opacity: 0, scale: reduced ? 1 : .8, rotate: reduced ? 0 : -12 }} animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={{ opacity: 0, scale: reduced ? 1 : .8 }} transition={{ duration: reduced ? 0 : .12, ease }}>
        {starting ? <LoaderCircle className="spin" size={20} /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </motion.span></AnimatePresence>
    </motion.button>
    <button className="icon-button" aria-label="Next track" disabled={!hasTrack || starting || !canNext} onClick={onNext}>
      <SkipForward size={18} fill="currentColor" /></button>
    <button className={`icon-button ${repeat !== "off" ? "is-active" : ""}`} aria-label={repeat === "one" ? "Repeat: Current track" : repeat === "all" ? "Repeat: Entire queue" : "Repeat: Off"}
      title={repeat === "one" ? "Repeat: One" : repeat === "all" ? "Repeat: All" : "Repeat: Off"} onClick={onRepeat}>
      {repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
    </button>
  </div>;
}

export type PlaybackProgressProps = {
  position: number; duration: number; disabled: boolean; onScrub: (seconds: number) => void; onSeek: (seconds: number) => void;
};

export function PlaybackProgress({ position, duration, disabled, onScrub, onSeek }: PlaybackProgressProps) {
  const fill = Math.max(0, Math.min(100, position / (duration || 1) * 100));
  return <div className="progress"><span>{formatTime(position)}</span><input aria-label="Playback position"
    aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`} style={{ "--seek-fill": `${fill}%` } as CSSProperties}
    type="range" min={0} max={duration || 1} step={.1} value={position} disabled={disabled}
    onChange={event => onScrub(Number(event.target.value))} onPointerUp={event => onSeek(Number(event.currentTarget.value))}
    onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) onSeek(Number(event.currentTarget.value)); }} />
    <span>{formatTime(duration)}</span></div>;
}
