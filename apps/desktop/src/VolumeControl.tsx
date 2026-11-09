import { useRef } from "react";
import type { CSSProperties } from "react";
import { Volume1, Volume2, VolumeX } from "lucide-react";

export default function VolumeControl({ volume, onChange }: {
  volume: number; onChange: (volume: number) => void;
}) {
  const lastAudible = useRef(volume > 0 ? volume : 80);
  if (volume > 0) lastAudible.current = volume;
  const Icon = volume === 0 ? VolumeX : volume < 45 ? Volume1 : Volume2;
  return <div className="volume-control">
    <button className="icon-button volume-toggle" aria-label={volume === 0 ? "Unmute" : "Mute"}
      title="Software volume" onClick={() => onChange(volume === 0 ? lastAudible.current : 0)}><Icon size={18} /></button>
    <input aria-label="Playback volume" type="range" min={0} max={100} step={1} value={volume}
      style={{ "--volume-fill": `${volume}%` } as CSSProperties}
      onChange={event => onChange(Number(event.target.value))} />
  </div>;
}
