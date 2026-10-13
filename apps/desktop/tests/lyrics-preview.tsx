// Development-only visual fixture. No audio or real provider requests are made.
import { useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import { LyricsSlot } from "../src/motion";
import { createRoot } from "react-dom/client";
import LyricsSidebar from "../src/LyricsSidebar";
import FullscreenPlayer from "../src/FullscreenPlayer";
import { wordLyricsfile } from "./word-lyrics-fixture";
import { createTheme } from "../src/theme";
import { clampLyricsWidth, maxLyricsWidth } from "../src/lyricsLayout";
import type { CSSProperties } from "react";
import "../src/styles.css";
import "../src/rendering.css";
import { initializeRendering } from "../src/rendering";
import type { Track } from "../src/types";

const track: Track = { id: "lyrics-visual-fixture", album_id: "fixture", title: "Lyrics preview", artist: "Spatial", album_artist: "Spatial",
  album: "Original verification fixture", date: "", disc_number: 1, track_number: 1, duration: 20,
  codec: "", profile: "", atmos: false, sample_rate: 48000, channels: 2, bitrate: 0, artwork_id: null };
initializeRendering();
const realFetch = window.fetch;
window.fetch = async (input, options) => {
  if (!String(input).startsWith("https://lrclib.net/api/get?")) return realFetch(input, options);
  const title = new URL(String(input)).searchParams.get("track_name") || "";
  if (title.includes("offline")) throw new TypeError("Synthetic offline fixture");
  if (title.includes("missing")) return new Response(null, { status: 404 });
  return Response.json({ id: 987654321, duration: 20, instrumental: title.includes("instrumental"),
    lyricsfile: title.includes("words") ? wordLyricsfile : null,
    plainLyrics: title.includes("plain") ? "A quiet room\nThe lights turn green\nA little space to breathe" : null,
    syncedLyrics: title === track.title ? "[00:01.00] A quiet room\n[00:04.00] The lights turn green\n[00:08.00] A little space to breathe\n[00:12.00] Every note comes home\n[00:16.00] And the room opens up\n[00:19.00]" : null });
};

function Fixture() {
  const [position, setPosition] = useState(4);
  const [resultType, setResultType] = useState("synced");
  const [paused, setPaused] = useState(true);
  const [full, setFull] = useState(false);
  const [width, setWidth] = useState(() => clampLyricsWidth(400, maxLyricsWidth(window.innerWidth)));
  const [open, setOpen] = useState(true);
  const fixtureTrack = { ...track, title: resultType === "synced" ? track.title : `${track.title} · ${resultType}` };
  const controls = { playing: !paused, starting: false, hasTrack: true, canPrevious: true, canNext: true, shuffle: false, repeat: "off" as const,
    onPlay: () => setPaused(value => !value), onPrevious: () => setPosition(1), onNext: () => setPosition(8), onShuffle: () => {}, onRepeat: () => {} };
  const progress = { position, duration: 20, disabled: false, onScrub: setPosition, onSeek: setPosition };
  return <MotionConfig reducedMotion="user"><div style={createTheme([140,70,190])}><div className={`app-shell ${open ? "lyrics-open" : ""}`} style={{ "--lyrics-width": `${width}px`, "--lyrics-space": open ? `${width}px` : "0px" } as CSSProperties}>
    <aside className="sidebar"><div className="brand">spatial.</div></aside>
    <main className="main-content"><div className="library-heading"><span className="eyebrow">VISUAL TEST FIXTURE · NO AUDIO</span><h1>Lyrics panel</h1></div>
      <button className="secondary" onClick={() => setOpen(true)}>Open lyrics</button>
      <button className="secondary" onClick={() => setFull(true)}>Fullscreen preview</button>
      <button className="secondary" onClick={() => setPaused(value => !value)}>{paused ? "Resume clock" : "Pause clock"}</button>
      <label style={{ fontSize: 11, marginTop: 15 }}>Simulated playback position
        <input aria-label="Simulated playback position" type="number" min={0} max={20} step={.1} value={position} onChange={event => setPosition(Number(event.target.value))} style={{ marginLeft: 15, width: 60, color: "#172018" }} />
      </label>
      <label style={{ fontSize: 11, marginTop: 10 }}>Provider result
        <select aria-label="Provider result" value={resultType} onChange={event => setResultType(event.target.value)} style={{ marginLeft: 15 }}>
          {["synced", "words", "plain", "instrumental", "missing", "offline"].map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
    </main>
    <AnimatePresence initial={false}>{open && <LyricsSlot key="lyrics"><LyricsSidebar width={width} maximum={maxLyricsWidth(window.innerWidth)} onResize={value => setWidth(clampLyricsWidth(value, maxLyricsWidth(window.innerWidth)))} onClose={() => setOpen(false)} track={fixtureTrack} position={position} playing paused={paused} onSeek={setPosition} /></LyricsSlot>}</AnimatePresence>
  </div><AnimatePresence>{full && <FullscreenPlayer track={fixtureTrack} active position={position} controls={controls} progress={progress}
    favorite={false} onFavorite={() => {}} onClose={() => setFull(false)} onSeek={setPosition} error="" />}</AnimatePresence></div></MotionConfig>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
