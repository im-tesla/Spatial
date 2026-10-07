import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ease, spring } from "./motion";
import { ArrowDown, LoaderCircle, Mic2, Music2, RefreshCw } from "lucide-react";
import { activeLyric, getLyrics, parseLrc } from "./lyrics";
import type { Lyrics } from "./lyrics";
import type { Track } from "./types";

export default function LyricsPanel({ track, position, playing, onSeek }: {
  track: Track | null; position: number; playing: boolean; onSeek: (seconds: number) => void;
}) {
  const reduced = useReducedMotion();
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const signature = JSON.stringify(track && [track.title, track.artist, track.album, track.duration]);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null); setError(""); setFollowing(true); setLoading(!!track);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (track) getLyrics(track).then(value => { if (!cancelled) setLyrics(value); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load lyrics."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signature, attempt]);

  const lines = useMemo(() => parseLrc(lyrics?.syncedLyrics || ""), [lyrics]);
  const active = activeLyric(lines, position);
  useEffect(() => {
    if (!following || !playing || active < 0) return;
    const row = lineRefs.current[active]; const container = scrollRef.current;
    if (row && container) {
      const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: top - container.clientHeight / 2 + row.clientHeight / 2,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }
  }, [active, following, playing]);

  const plain = lyrics?.plainLyrics?.trim();
  const synced = lines.length > 0;
  return <div className="lyrics-panel">
    <div className="lyrics-track-info"><strong>{track?.title || "Choose a track"}</strong><span>{track ? `${track.artist} · ${track.album}` : "Lyrics will follow your music."}</span></div>
    <div className="lyrics-mode"><Mic2 size={14} /><span>{loading ? "Finding lyrics…" : synced ? (playing ? "Synced lyrics" : "Timed lyrics · play this track to follow along") : plain ? "Plain lyrics · timing unavailable" : "Lyrics"}</span>
      {synced && playing && !following && <button className="follow-lyrics" onClick={() => setFollowing(true)}><ArrowDown size={13} /> Follow song</button>}
    </div>
    <div className="lyrics-scroll" ref={scrollRef} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onPointerDown={event => { if (event.target === event.currentTarget) setFollowing(false); }} onKeyDown={event => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) setFollowing(false); }}>
      {loading ? <div className="lyrics-empty" role="status"><LoaderCircle className="spin" size={28} /><h3>Finding the words…</h3></div>
        : error ? <div className="lyrics-empty" role="status"><Mic2 size={28} /><h3>Lyrics couldn't load</h3><p>{error}</p><button className="secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /> Try again</button></div>
        : synced ? <motion.div className="lyrics-lines" key={signature} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .4, ease }}>{lines.map((line, index) => <motion.button key={`${index}-${line.time}`} ref={element => { lineRefs.current[index] = element; }}
          animate={{ x: !reduced && playing && index === active ? 4 : 0, scale: !reduced && playing && index === active ? 1.015 : 1 }} transition={reduced ? { duration: 0 } : spring} style={{ transformOrigin: "left center" }}
          className={`lyric-line ${playing && index === active ? "current" : ""} ${playing && index < active ? "past" : ""}`}
          aria-current={playing && index === active ? "true" : undefined} aria-label={`${line.text || "Instrumental passage"} · Seek to ${Math.floor(line.time / 60)}:${Math.floor(line.time % 60).toString().padStart(2, "0")}`}
          disabled={!playing} onClick={() => { setFollowing(true); onSeek(line.time); }}>{line.text || <span className="lyric-gap" aria-label="Instrumental passage">•••</span>}</motion.button>)}</motion.div>
        : plain ? <motion.div className="lyrics-lines plain-lyrics" key={signature} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .4, ease }}>{plain.split(/\r?\n/).map((line, index) => <p className="lyric-line" key={index}>{line || "\u00a0"}</p>)}</motion.div>
        : <div className="lyrics-empty"><Music2 size={32} /><h3>{!track ? "Music first, words next." : lyrics?.instrumental ? "Let the music speak." : "No lyrics available yet"}</h3><p>{!track ? "Play a track to see its lyrics here." : lyrics?.instrumental ? "This recording is instrumental." : "LRCLIB doesn't have matching lyrics for this recording."}</p></div>}
    </div>
    <div className="lyrics-credit"><span>Lyrics from <a href="https://lrclib.net" target="_blank" rel="noreferrer">LRCLIB</a></span><span>{synced && playing ? "Click a line to seek" : ""}</span></div>
  </div>;
}
