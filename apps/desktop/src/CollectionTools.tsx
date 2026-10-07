import { useId, useState } from "react";
import { Check, CheckSquare2, ClipboardCopy, Heart, Minus, Plus, X } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { native } from "./api";
import { emptyFavorites } from "./favorites";
import type { Favorites } from "./favorites";
import { changeFavorites, exportFavorites, importFavorites } from "./favoritesSharing";
import type { Library } from "./types";
import "./collection-tools.css";

type Props = {
  catalog: Library; favorites: Favorites; selected: Favorites; visible: Favorites; selecting: boolean; sharing: boolean;
  compact?: boolean; onMode: (enabled: boolean) => void; onSelect: (selection: Favorites) => void; onUpdate: (favorites: Favorites) => boolean;
};

export default function CollectionTools({ catalog, favorites, selected, visible, selecting, sharing, compact, onMode, onSelect, onUpdate }: Props) {
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState("");
  const [fallback, setFallback] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const importId = useId();
  const count = selected.albums.length + selected.tracks.length;
  const visibleCount = visible.albums.length + visible.tracks.length;
  const canAdd = selected.albums.some(id => !favorites.albums.includes(id)) || selected.tracks.some(id => !favorites.tracks.includes(id));
  const canRemove = selected.albums.some(id => favorites.albums.includes(id)) || selected.tracks.some(id => favorites.tracks.includes(id));
  const availableCount = catalog.albums.filter(album => favorites.albums.includes(album.id)).length
    + catalog.tracks.filter(track => favorites.tracks.includes(track.id)).length;

  function update(action: "add" | "remove") {
    if (onUpdate(changeFavorites(favorites, selected, action))) {
      setMessage(`${count} selected ${count === 1 ? "item" : "items"} ${action === "add" ? "added to" : "removed from"} favorites.`);
      setError(""); onSelect(emptyFavorites());
    }
  }

  async function copy() {
    setCopying(true); setError(""); setMessage(""); setFallback("");
    try {
      const shared = exportFavorites(selecting && count ? selected : favorites, catalog);
      try {
        if (native) await writeText(shared); else await navigator.clipboard.writeText(shared);
        setMessage("Copied. Your friend can paste this list into Import favorites.");
      } catch {
        setFallback(shared); setError("Clipboard is unavailable. Copy the list below manually.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not copy favorites."); }
    finally { setCopying(false); }
  }

  function importList(event: React.FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      const result = importFavorites(source, favorites, catalog);
      if (!onUpdate(result.favorites)) return;
      const noun = (value: number, singular: string) => `${value} ${singular}${value === 1 ? "" : "s"}`;
      const summary = [`Added ${noun(result.addedAlbums, "album")} and ${noun(result.addedTracks, "track")}.`];
      if (result.missing) summary.push(`${noun(result.missing, "item")} not found in this library.`);
      if (result.ambiguous) summary.push(`${noun(result.ambiguous, "ambiguous match")} skipped.`);
      if (!result.addedAlbums && !result.addedTracks && !result.missing && !result.ambiguous) summary.push("Matching favorites are already saved.");
      setMessage(summary.join(" ")); setSource(""); setImporting(false); onSelect(emptyFavorites());
    } catch (e) { setError(e instanceof Error ? e.message : "Could not import favorites."); }
  }

  return <section className={`collection-tools ${compact ? "compact" : ""}`} aria-label="Collection actions">
    <div className="collection-toolbar">
      <div className="selection-tools">
        {(visibleCount > 0 || selecting) && <button className={`tool-button ${selecting ? "is-active" : ""}`} aria-pressed={selecting}
          onClick={() => { onMode(!selecting); onSelect(emptyFavorites()); setMessage(""); setError(""); }}>
          {selecting ? <Check size={15} /> : <CheckSquare2 size={15} />} {selecting ? "Done" : "Select"}
        </button>}
        {selecting && <>
          <span className="selection-count" aria-live="polite">{count} selected</span>
          <button className="tool-button" disabled={!visibleCount} onClick={() => onSelect(visible)}>Select all</button>
          <button className="tool-button" disabled={!count} onClick={() => onSelect(emptyFavorites())}>Clear selection</button>
          <button className="tool-button" disabled={!canAdd} onClick={() => update("add")}><Plus size={15} /> Add to favorites</button>
          <button className="tool-button" disabled={!canRemove} onClick={() => update("remove")}><Minus size={15} /> Remove from favorites</button>
        </>}
      </div>
      {sharing && <div className="sharing-tools">
        <button className="tool-button" disabled={copying || !(selecting && count ? count : availableCount)} onClick={() => void copy()}>
          <ClipboardCopy size={15} /> {copying ? "Copying…" : selecting && count ? "Copy selected" : "Copy favorites"}
        </button>
        <button className="tool-button" aria-expanded={importing} aria-controls={importId}
          onClick={() => { setImporting(!importing); setError(""); setMessage(""); setFallback(""); }}><Heart size={15} /> Import favorites</button>
      </div>}
    </div>
    {message && <p className="collection-notice" role="status">{message}</p>}
    {error && <p className="collection-notice collection-error" role="alert">{error}</p>}
    {fallback && <label className="favorites-paste-label">Favorites list<textarea className="favorites-paste" readOnly value={fallback}
      aria-label="Favorites list to copy" onFocus={e => e.currentTarget.select()} /></label>}
    {importing && <form className="favorites-import" id={importId} onSubmit={importList}>
      <div className="import-heading"><strong>Import a favorites list</strong><button type="button" className="icon-button" aria-label="Close favorites import" onClick={() => setImporting(false)}><X size={17} /></button></div>
      <p>Paste a list from Spatial. Matches already in this server's library will be added to your favorites.</p>
      <label className="favorites-paste-label">Shared favorites<textarea className="favorites-paste" autoFocus value={source} maxLength={2_000_000}
        placeholder="Paste a Spatial favorites list…" onChange={e => setSource(e.target.value)} /></label>
      <button className="primary" disabled={!source.trim()} type="submit">Add matching favorites</button>
    </form>}
  </section>;
}
