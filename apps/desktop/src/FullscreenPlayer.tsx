import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { Minimize2 } from "lucide-react";
import Cover from "./Cover";
import LyricsPanel from "./LyricsPanel";
import { FavoriteButton, PlaybackControls, PlaybackProgress } from "./PlayerControls";
import type { PlaybackControlsProps, PlaybackProgressProps } from "./PlayerControls";
import { ease } from "./motion";
import type { Track } from "./types";
import "./fullscreen.css";

export default function FullscreenPlayer({ track, active, position, controls, progress, favorite, onFavorite, onClose, onSeek, error }: {
  track: Track; active: boolean; position: number; controls: PlaybackControlsProps; progress: PlaybackProgressProps;
  favorite: boolean; onFavorite: () => void; onClose: () => void; onSeek: (seconds: number) => void; error: string;
}) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const root = useRef<HTMLElement>(null);
  const callbacks = useRef({ onClose, onPlay: controls.onPlay, present, blocked: controls.starting || !controls.hasTrack });
  callbacks.current = { onClose, onPlay: controls.onPlay, present, blocked: controls.starting || !controls.hasTrack };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = root.current;
    root.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (!callbacks.current.present) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); callbacks.current.onClose(); return;
      }
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (event.code === "Space" && !event.repeat && !element?.closest("button, input, a, textarea, select, [contenteditable='true']")) {
        event.preventDefault(); if (!callbacks.current.blocked) callbacks.current.onPlay();
      }
      if (event.key !== "Tab" || !root.current) return;
      const items = Array.from(root.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href], [tabindex='0']"));
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      if (document.activeElement === document.body || panel?.contains(document.activeElement)) previous?.focus({ preventScroll: true });
    };
  }, []);

  return <motion.section ref={root} className="listening-view" data-playing={controls.playing ? "true" : "false"}
    tabIndex={-1} role="dialog" aria-modal="true" aria-label="Fullscreen player" inert={!present}
    initial={{ opacity: 0, scale: reduced ? 1 : 1.025 }} animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: reduced ? 1 : .985 }} transition={{ duration: reduced ? 0 : .55, ease }}>
    <div className="listening-atmosphere" aria-hidden="true">
      <Cover id={track.artwork_id} title="" className="listening-backdrop-art" />
      <div className="listening-glow listening-glow-one" /><div className="listening-glow listening-glow-two" />
      <div className="listening-shade" />
    </div>
    <header className="listening-header"><span className="listening-brand">spatial<span className="brand-dot">.</span></span>
      <button className="icon-button listening-close" aria-label="Exit fullscreen" title="Exit fullscreen · Esc" onClick={onClose}><Minimize2 size={20} /></button>
    </header>
    <div className="listening-layout">
      <motion.div className="listening-record" initial={{ opacity: 0, y: reduced ? 0 : 28 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduced ? 0 : .8, delay: reduced ? 0 : .08, ease }}>
        <div className="listening-artwork"><Cover id={track.artwork_id} title={track.album} /></div>
        <div className="listening-caption"><AnimatePresence initial={false} mode="wait"><motion.div className="listening-metadata" key={track.id}
          initial={{ opacity: 0, y: reduced ? 0 : 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -8 }}
          transition={{ duration: reduced ? 0 : .22, ease }}>
          <h1 title={track.title}>{track.title}</h1><p className="listening-artist">{track.artist}</p><p className="listening-album">{track.album}</p>
        </motion.div></AnimatePresence><FavoriteButton active={favorite} label={`track ${track.title}`} onClick={onFavorite} /></div>
        <div className="listening-transport"><PlaybackControls {...controls} /><PlaybackProgress {...progress} /></div>
        {error && <p className="listening-error" role="status">{error}</p>}
      </motion.div>
      <motion.div className="listening-lyrics" initial={{ opacity: 0, x: reduced ? 0 : 24 }} animate={{ opacity: 1, x: 0 }}
        transition={{ duration: reduced ? 0 : .9, delay: reduced ? 0 : .18, ease }}>
        <LyricsPanel variant="fullscreen" track={track} position={position} playing={active} paused={!controls.playing} onSeek={onSeek} />
      </motion.div>
    </div>
  </motion.section>;
}
