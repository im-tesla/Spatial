import { useRef, useState } from "react";
import { X } from "lucide-react";
import LyricsPanel from "./LyricsPanel";
import { clampLyricsWidth, defaultLyricsWidth, minLyricsWidth } from "./lyricsLayout";
import type { Track } from "./types";

export default function LyricsSidebar({ width, maximum, onResize, onClose, track, position, playing, onSeek }: {
  width: number; maximum: number; onResize: (width: number) => void; onClose: () => void;
  track: Track | null; position: number; playing: boolean; onSeek: (seconds: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  return <aside id="lyrics-sidebar" className={`lyrics-sidebar ${resizing ? "resizing" : ""}`} aria-labelledby="lyrics-title"
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="lyrics-resize" role="separator" tabIndex={0} aria-label="Resize lyrics panel" aria-orientation="vertical"
      aria-controls="lyrics-sidebar" aria-valuemin={minLyricsWidth} aria-valuemax={maximum} aria-valuenow={width} aria-valuetext={`${width} pixels`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width }; setResizing(true);
      }}
      onPointerMove={event => { if (drag.current) onResize(clampLyricsWidth(drag.current.width + drag.current.x - event.clientX, maximum)); }}
      onPointerUp={event => { drag.current = null; setResizing(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
      onPointerCancel={() => { drag.current = null; setResizing(false); }}
      onDoubleClick={() => onResize(clampLyricsWidth(defaultLyricsWidth, maximum))}
      onKeyDown={event => {
        const step = event.shiftKey ? 32 : 16;
        const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step
          : event.key === "Home" ? minLyricsWidth : event.key === "End" ? maximum : null;
        if (next !== null) { event.preventDefault(); onResize(clampLyricsWidth(next, maximum)); }
      }} />
    <div className="lyrics-sidebar-heading"><h2 id="lyrics-title">Lyrics</h2><div>
      <button className="icon-button" aria-label="Close lyrics panel" onClick={onClose}><X size={19} /></button>
    </div></div>
    <LyricsPanel track={track} position={position} playing={playing} onSeek={onSeek} />
  </aside>;
}
