import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ease, spring } from "./motion";
import { ArrowDown, LoaderCircle, Mic2, Music2, RefreshCw } from "lucide-react";
import { activeLyric, getLyrics, highlightedLyrics, timedLyrics } from "./lyrics";
import type { Lyrics } from "./lyrics";
import type { Track } from "./types";
import LyricText from "./LyricText";
import { softwareRendering } from "./rendering";
import "./lyrics.css";

export default function LyricsPanel({ track, position, playing, onSeek, variant = "sidebar", paused = false }: {
  track: Track | null; position: number; playing: boolean; onSeek: (seconds: number) => void; variant?: "sidebar" | "fullscreen"; paused?: boolean;
}) {
  const reduced = useReducedMotion();
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [following, setFollowing] = useState(true);
  const [paneHeight, setPaneHeight] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const signature = JSON.stringify(track && [track.title, track.artist, track.album, track.duration]);

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const observer = new ResizeObserver(() => setPaneHeight(pane.clientHeight));
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null); setError(""); setFollowing(true); setLoading(!!track);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (track) getLyrics(track).then(value => { if (!cancelled) setLyrics(value); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load lyrics."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signature, attempt]);

  const lines = useMemo(() => timedLyrics(lyrics, track?.duration || 0), [lyrics, track?.duration]);
  const active = activeLyric(lines, position);
  const highlighted = highlightedLyrics(lines, position);
  useEffect(() => {
    if (!following || !playing || active < 0) return;
    const row = lineRefs.current[active]; const container = scrollRef.current;
    if (!row || !container) return;
    const center = (behavior: ScrollBehavior) => container.scrollTo({
      top: row.offsetTop - container.clientHeight / 2 + row.clientHeight / 2, behavior,
    });
    center(reduced ? "instant" : "smooth");
    // Entering native fullscreen or resizing the sidebar can reflow the active line.
    let observed = false;
    const observer = new ResizeObserver(() => { if (observed) center("instant"); observed = true; });
    observer.observe(container); observer.observe(row);
    return () => observer.disconnect();
  }, [active, following, playing, lines, reduced, paneHeight]);

  const plain = lyrics?.plainLyrics?.trim();
  const synced = lines.length > 0;
  const fullscreen = variant === "fullscreen";
  const focused = playing && following;
  return <div className={`lyrics-panel ${fullscreen ? "lyrics-fullscreen" : ""}`} data-following={following} data-running={playing && !paused}
    style={{ "--lyrics-pane-height": `${paneHeight}px` } as CSSProperties}>
    {!fullscreen && <div className="lyrics-track-info"><strong>{track?.title || "Choose a track"}</strong><span>{track ? `${track.artist} · ${track.album}` : "Lyrics will follow your music."}</span></div>}
    <div className="lyrics-mode"><Mic2 size={14} /><span>{loading ? "Finding lyrics…" : synced ? (playing ? "Synced lyrics" : "Timed lyrics · play this track to follow along") : plain ? "Plain lyrics · timing unavailable" : "Lyrics"}</span>
      {synced && playing && !following && <button className="follow-lyrics" onClick={() => setFollowing(true)}><ArrowDown size={13} /> Follow song</button>}
    </div>
    <div className="lyrics-scroll" ref={scrollRef} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onPointerDown={event => { if (event.target === event.currentTarget) setFollowing(false); }} onKeyDown={event => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) setFollowing(false); }}>
      {loading ? <div className="lyrics-empty" role="status"><LoaderCircle className="spin" size={28} /><h3>Finding the words…</h3></div>
        : error ? <div className="lyrics-empty" role="status"><Mic2 size={28} /><h3>Lyrics couldn't load</h3><p>{error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /> Try again</button></div>
        : synced ? <motion.div className="lyrics-lines" key={signature} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .4, ease }}>{lines.map((line, index) => <motion.button key={`${index}-${line.time}`} ref={element => { lineRefs.current[index] = element; }}
          animate={{ x: !reduced && focused && highlighted.has(index) ? (fullscreen ? 4 : 2) : 0,
            y: !reduced && focused ? highlighted.has(index) ? -2 : Math.max(-3, Math.min(3, index - active)) * 1.5 : 0,
            scale: !reduced && focused && highlighted.has(index) ? 1.04 : 1,
            opacity: !focused ? 1 : highlighted.has(index) ? 1 : Math.abs(index - active) === 1 ? (index < active ? .44 : .56) : .34,
            filter: softwareRendering ? "none" : reduced || !focused || highlighted.has(index) ? "blur(0px)" : `blur(${Math.min(2.4, Math.abs(index - active) * (fullscreen ? .7 : .5))}px)` }}
          transition={reduced ? { duration: 0 } : { ...spring, stiffness: 210, damping: 28, opacity: { duration: .55 }, filter: { duration: .65 } }} style={{ transformOrigin: "left center" }}
          className={`lyric-line ${playing && highlighted.has(index) ? "current" : ""} ${playing && index < active && !highlighted.has(index) ? "past" : ""}`}
          aria-current={playing && highlighted.has(index) ? "true" : undefined} aria-label={`${line.text || "Instrumental passage"} · Seek to ${Math.floor(line.time / 60)}:${Math.floor(line.time % 60).toString().padStart(2, "0")}`}
          dir="auto" disabled={!playing} onClick={() => { setFollowing(true); onSeek(line.time); }}>
          {line.text ? playing && highlighted.has(index) ? <LyricText text={line.text} words={line.words} position={position}
            running={!paused && following} reduced={!!reduced} /> : <span className="lyric-ink">{line.text}</span>
            : <span className="lyric-gap" aria-label="Instrumental passage"><i /><i /><i /></span>}
        </motion.button>)}</motion.div>
        : plain ? <motion.div className="lyrics-lines plain-lyrics" key={signature} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .4, ease }}>{plain.split(/\r?\n/).map((line, index) => <p className="lyric-line" key={index}>{line || "\u00a0"}</p>)}</motion.div>
        : <div className="lyrics-empty"><Music2 size={32} /><h3>{!track ? "Music first, words next." : lyrics?.instrumental ? "Let the music speak." : "No lyrics available yet"}</h3><p>{!track ? "Play a track to see its lyrics here." : lyrics?.instrumental ? "This recording is instrumental." : "LRCLIB doesn't have matching lyrics for this recording."}</p></div>}
    </div>
    <div className="lyrics-credit"><span>Lyrics from <a href="https://lrclib.net" target="_blank" rel="noreferrer">LRCLIB</a></span><span>{synced && playing ? "Click a line to seek" : ""}</span></div>
  </div>;
}
