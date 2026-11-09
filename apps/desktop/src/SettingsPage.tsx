import { useId, useState } from "react";
import type { ComponentType, CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  ArrowLeft, Check, ChevronRight, CircleHelp, Gamepad2, Headphones, Layers3, LoaderCircle, Mic2,
  Palette, Plug, RefreshCw, RotateCcw, Server, SlidersHorizontal, Speaker, Volume2,
} from "lucide-react";
import appPackage from "../package.json" with { type: "json" };
import { native } from "./api";
import UpdateStatus from "./UpdateStatus";
import DiscordSettings from "./DiscordSettings";
import type { useDiscordPreferences } from "./DiscordSettings";
import RemoteSettings from "./RemoteSettings";
import ControllerSettings from "./ControllerSettings";
import ExternalLink from "./ExternalLink";
import type { useController } from "./useController";
import { defaultPreferences } from "./preferences";
import type { Preferences } from "./preferences";
import { clampLyricsOffset, formatLyricsOffset, lyricsOffsetStep, maxLyricsOffset, minLyricsOffset } from "./lyricsOffset";
import type { AudioDevice, Library, PlaybackStatus } from "./types";
import "./settings-page.css";

export type SettingsTab = "general" | "playback" | "appearance" | "lyrics" | "integrations" | "controls";

const tabs: { id: SettingsTab; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "playback", label: "Playback", icon: Speaker },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "lyrics", label: "Lyrics", icon: Mic2 },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "controls", label: "Controls", icon: Gamepad2 },
];

function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean; onChange: () => void; label: string; disabled?: boolean;
}) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
    className={`preference-switch ${checked ? "enabled" : ""}`} onClick={onChange}><span /></button>;
}

function Segmented<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    onChange(options[next].value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map((option, index) =>
    <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled}
      tabIndex={index === selected ? 0 : -1} className={value === option.value ? "selected" : ""}
      onKeyDown={event => keyDown(event, index)} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-row-copy"><h3>{title}</h3>
    {description && <p>{description}</p>}</div><div className="settings-row-control">{children}</div></div>;
}

function Card({ title, description, children, id }: {
  title?: string; description?: string; children: ReactNode; id?: string;
}) {
  return <section className="settings-card">{title && <header className="settings-card-heading">
    <h2 id={id}>{title}</h2>{description && <p>{description}</p>}</header>}
    <div className="settings-card-body">{children}</div></section>;
}

export default function SettingsPage({ tab, onTab, onClose, preferences, onChange, devices, device, onDevice, onRefreshDevices,
  loadingDevices, devicesError, status, catalog, artistCount, address, connection, onDisconnect,
  controller, discordPreferences }: {
  tab: SettingsTab; onTab: (tab: SettingsTab) => void; onClose: () => void;
  preferences: Preferences; onChange: (patch: Partial<Preferences>) => void;
  devices: AudioDevice[]; device: string; onDevice: (name: string) => void; onRefreshDevices: () => void;
  loadingDevices: boolean; devicesError: string;
  status: PlaybackStatus; catalog: Library; artistCount: number; address: string; connection: string;
  onDisconnect: () => void;
  controller: ReturnType<typeof useController>;
  discordPreferences: ReturnType<typeof useDiscordPreferences>;
}) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const id = useId();
  const index = tabs.findIndex(item => item.id === tab);
  const volumeId = `${id}-volume`;
  const deviceDescription = devices.find(item => item.name === device)?.description || (device ? "Saved audio endpoint" : "No output selected");
  const stereo = preferences.allowStereo;
  const offsetPosition = (preferences.lyricsOffset - minLyricsOffset) / (maxLyricsOffset - minLyricsOffset) * 100;
  const offsetStart = Math.min(50, offsetPosition);
  const offsetEnd = Math.max(50, offsetPosition);

  function keyDown(event: KeyboardEvent) {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    onTab(tabs[next].id);
    document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus();
  }

  return <div className="settings-page">
    <button className="back-button" onClick={onClose}><ArrowLeft size={16} /> Back to library</button>
    <header className="settings-header">
      <span className="eyebrow">PREFERENCES</span>
      <h1>Settings</h1>
      <p>Playback, appearance and the details that make Spatial yours.</p>
    </header>
    <div className="settings-layout">
      <nav className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={keyDown}>
        {tabs.map(item => { const Icon = item.icon; return <button key={item.id} id={`${id}-tab-${item.id}`} role="tab"
          aria-selected={item.id === tab} tabIndex={item.id === tab ? 0 : -1}
          className={`settings-tab ${item.id === tab ? "active" : ""}`} onClick={() => onTab(item.id)}>
          <Icon size={17} /><span>{item.label}</span><ChevronRight size={14} className="settings-tab-arrow" />
        </button>; })}
      </nav>
      <div className="settings-panels" id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} key={tab}>
        {tab === "general" && <>
          <Card title="Your library">
            <div className="settings-stats">
              <div><strong>{catalog.albums.length}</strong><span>Albums</span></div>
              <div><strong>{artistCount}</strong><span>Artists</span></div>
              <div><strong>{catalog.tracks.length}</strong><span>Tracks</span></div>
              <div><strong>{catalog.tracks.filter(track => track.atmos).length}</strong><span>In Atmos</span></div>
            </div>
            <p className="settings-note">{catalog.revision ? `Catalog revision ${catalog.revision}. ` : ""}Filesystem changes reach this library automatically.</p>
          </Card>
          <Card title="Server connection">
            <Row title={connection === "connected" ? "Connected" : "Reconnecting"} description={address || "No server address"}>
              <span className={`settings-status ${connection === "connected" ? "" : "warn"}`}><span className="status-dot" />{connection === "connected" ? "Live" : "Retrying"}</span>
            </Row>
            <div className="settings-inline-actions">
              {confirmDisconnect ? <>
                <span className="settings-confirm">Disconnect and return to the connection screen?</span>
                <button className="secondary small" onClick={() => setConfirmDisconnect(false)}>Cancel</button>
                <button className="primary small" onClick={onDisconnect}>Disconnect</button>
              </> : <button className="secondary small" onClick={() => setConfirmDisconnect(true)}><Server size={14} /> Change server</button>}
            </div>
          </Card>
          <Card title="Updates"><UpdateStatus />
            <p className="settings-note">Spatial {appPackage.version} · Windows and Linux updates are signed and verified before installation.</p>
          </Card>
          <Card title="About">
            <Row title="Reset preferences" description="Restore the default playback, appearance and lyrics settings. Favorites are kept.">
              <button className="secondary small" onClick={() => onChange(defaultPreferences)}><RotateCcw size={14} /> Reset</button>
            </Row>
            <p className="settings-note">Preferences, favorites and the lyrics cache stay on this device. Automatic artist portraits use Deezer; album art fallbacks use iTunes and MusicBrainz.</p>
            <div className="settings-links"><ExternalLink href="https://github.com/im-tesla/Spatial">Spatial on GitHub <ChevronRight size={12} /></ExternalLink>
              <ExternalLink href="https://lrclib.net">Lyrics by LRCLIB <ChevronRight size={12} /></ExternalLink></div>
          </Card>
        </>}

        {tab === "playback" && <>
          <Card title="Audio output" description={stereo ? "Decoded stereo PCM for headphones and speakers." : "Original Dolby bitstream sent to your receiver."}>
            <div className={`output-summary ${stereo ? "stereo" : ""}`}>
              <span className="output-summary-icon">{stereo ? <Headphones size={22} /> : <Layers3 size={22} />}</span>
              <div><strong>{stereo ? "Stereo PCM" : "Dolby Atmos bitstream"}</strong>
                <span>{stereo ? `Decoded to two channels${preferences.exclusiveMode ? " · exclusive output" : " · shared output"}` : "E-AC-3 / TrueHD · receiver controls volume"}{status.active && status.output_mode ? ` · ${status.output_mode === "stereo" ? "playing stereo" : "playing bitstream"}` : ""}</span></div>
              <span className="mode-pill">{stereo ? (preferences.exclusiveMode ? "EXCLUSIVE" : "SHARED") : "EXCLUSIVE"}</span>
            </div>
            {loadingDevices ? <div className="loading"><LoaderCircle className="spin" size={18} /> Finding audio outputs…</div>
              : devices.length ? <div className="device-list" role="listbox" aria-label="Audio output">
                {devices.map(item => <button key={item.name} role="option" aria-selected={device === item.name}
                  className={`device-option ${device === item.name ? "selected" : ""}`} onClick={() => onDevice(item.name)} title={item.name}>
                  <Speaker size={18} /><span>{item.description}</span>{device === item.name && <Check size={18} />}
                </button>)}</div>
              : <div className="settings-empty"><Speaker size={24} /><p>{native ? "No audio outputs were found. Connect your receiver or headphones, then refresh." : "Audio output selection is available in the desktop application."}</p></div>}
            {devicesError && <p className="form-error" role="status">{devicesError}</p>}
            <div className="settings-inline-actions"><span className="settings-note inline">{deviceDescription}</span>
              <button className="secondary small" disabled={loadingDevices} onClick={onRefreshDevices}><RefreshCw size={14} /> Refresh</button></div>
          </Card>
          <Card title="Output options">
            <Row title="Allow stereo playback" description="Decode every track to stereo PCM for headphones and desktop speakers. Off keeps Dolby Atmos as the only output. Changes apply to the next track.">
              <Switch checked={stereo} label="Allow stereo playback" onChange={() => onChange({ allowStereo: !stereo })} />
            </Row>
            <Row title="Exclusive mode" description={stereo ? "Take exclusive control of the output device for the cleanest signal. Turn this off to share audio with other apps." : "Dolby Atmos bitstream always uses exclusive output. Turn on stereo playback to make this optional."}>
              <Switch checked={stereo && preferences.exclusiveMode} label="Enable exclusive mode" disabled={!stereo}
                onChange={() => onChange({ exclusiveMode: !preferences.exclusiveMode })} />
            </Row>
            <Row title="Software volume" description={stereo ? "Applies to stereo playback. Dolby bitstream volume stays at full scale for the receiver." : "Available with stereo playback. Your receiver controls bitstream volume."}>
              <div className={`volume-setting ${!stereo ? "disabled" : ""}`}>
                <Volume2 size={16} />
                <input id={volumeId} aria-label="Software volume" type="range" min={0} max={100} step={1}
                  value={preferences.volume} disabled={!stereo} style={{ "--volume-value": `${preferences.volume}%` } as CSSProperties}
                  onChange={event => onChange({ volume: Number(event.target.value) })} />
                <span>{preferences.volume}%</span>
              </div>
            </Row>
          </Card>
          <p className="settings-footnote"><CircleHelp size={14} /> Spatial sends the original Dolby frames untouched in bitstream mode. Stereo mode decodes locally and never sends PCM to an Atmos receiver.</p>
        </>}

        {tab === "appearance" && <>
          <Card title="Look and feel">
            <Row title="Artwork colors" description="Tint the interface with the palette of the album you're viewing.">
              <Switch checked={preferences.artworkColors} label="Use artwork colors" onChange={() => onChange({ artworkColors: !preferences.artworkColors })} />
            </Row>
            <Row title="Reduce motion" description="Minimize transitions, drifting artwork and animated lyric movement.">
              <Switch checked={preferences.reduceMotion} label="Reduce motion" onChange={() => onChange({ reduceMotion: !preferences.reduceMotion })} />
            </Row>
            <Row title="Layout density" description="Compact fits more albums and tracks on screen.">
              <Segmented label="Layout density" value={preferences.density} onChange={density => onChange({ density })}
                options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
            </Row>
          </Card>
          <Card title="Browsing">
            <Row title="Track artwork" description="Show album covers beside tracks outside an album.">
              <Switch checked={preferences.trackArtwork} label="Show track artwork" onChange={() => onChange({ trackArtwork: !preferences.trackArtwork })} />
            </Row>
            <Row title="Album order" description="How albums are sorted in your library and artist pages.">
              <Segmented label="Album order" value={preferences.albumSort} onChange={albumSort => onChange({ albumSort })}
                options={[{ value: "newest", label: "Newest" }, { value: "title", label: "Title" }, { value: "artist", label: "Artist" }]} />
            </Row>
          </Card>
        </>}

        {tab === "lyrics" && <>
          <Card title="Lyrics appearance">
            <div className="lyrics-preview" data-size={preferences.lyricsSize} aria-hidden="true"><span className="past">The lights turn green</span>
              <strong>A little space to breathe</strong><span>Every note comes home</span></div>
            <Row title="Text size" description="Scales lyrics in the side panel and fullscreen player.">
              <Segmented label="Lyrics text size" value={preferences.lyricsSize} onChange={lyricsSize => onChange({ lyricsSize })}
                options={[{ value: "small", label: "Small" }, { value: "standard", label: "Standard" }, { value: "large", label: "Large" }]} />
            </Row>
            <Row title="Sync offset" description="Shift lyric timing when a source runs early or late. Positive values show lyrics later.">
              <div className="offset-setting">
                <input aria-label="Lyrics offset" type="range" min={minLyricsOffset} max={maxLyricsOffset} step={lyricsOffsetStep}
                  value={preferences.lyricsOffset}
                  style={{ "--offset-start": `${offsetStart}%`, "--offset-end": `${offsetEnd}%` } as CSSProperties}
                  onChange={event => onChange({ lyricsOffset: clampLyricsOffset(Number(event.target.value)) })} />
                <span>{formatLyricsOffset(preferences.lyricsOffset)}</span>
                <button className="secondary small" disabled={preferences.lyricsOffset === 0} onClick={() => onChange({ lyricsOffset: 0 })}>
                  <RotateCcw size={13} /> Reset
                </button>
              </div>
            </Row>
            <Row title="Artwork backdrop" description="Let the current cover glow softly behind the lyrics panel.">
              <Switch checked={preferences.lyricsBackdrop} label="Show lyrics artwork backdrop" onChange={() => onChange({ lyricsBackdrop: !preferences.lyricsBackdrop })} />
            </Row>
          </Card>
          <Card title="Following">
            <Row title="Follow the song" description="Keep the current line centered as playback moves. Scrolling pauses following until you resume it.">
              <Switch checked={preferences.lyricsFollow} label="Follow lyrics automatically" onChange={() => onChange({ lyricsFollow: !preferences.lyricsFollow })} />
            </Row>
            <p className="settings-note">A matching .ttml file beside the audio is used first and labeled <strong>Local lyrics</strong>. Otherwise Spatial looks up the recording on LRCLIB, with word timing when available.</p>
          </Card>
        </>}

        {tab === "integrations" && <>
          <Card title="Discord"><DiscordSettings preferences={discordPreferences} /></Card>
          <Card title="Phone remote"><RemoteSettings /></Card>
        </>}

        {tab === "controls" && <Card title="Controller"><ControllerSettings controller={controller} /></Card>}
      </div>
    </div>
  </div>;
}
