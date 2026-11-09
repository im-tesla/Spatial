import { motion, useReducedMotion } from "motion/react";
import { Layers3, Play } from "lucide-react";
import Cover from "./Cover";
import { FavoriteButton } from "./PlayerControls";
import { ease, spring } from "./motion";
import type { Album } from "./types";

const year = (date: string) => date.match(/^\d{4}/)?.[0] || "";

export default function AlbumGrid({ albums, selecting = false, selectedIds = [], favoriteIds, layoutKey, onOpen, onPlay, onFavorite, onSelect }: {
  albums: Album[]; selecting?: boolean; selectedIds?: string[]; favoriteIds: string[]; layoutKey?: string;
  onOpen: (album: Album) => void; onPlay: (album: Album) => void;
  onFavorite: (album: Album) => void; onSelect: (album: Album) => void;
}) {
  const reduced = useReducedMotion();
  return <div className="album-grid">{albums.map((album, index) => <motion.article
    className={`album-card ${selecting && selectedIds.includes(album.id) ? "is-selected" : ""}`} key={album.id}
    layout={albums.length <= 80 ? "position" : false} layoutDependency={layoutKey}
    initial={reduced || index >= 16 ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: reduced ? 0 : .35, delay: reduced || index >= 16 ? 0 : index * .018, ease, layout: spring }}
    whileHover={reduced ? undefined : { y: -3 }}>
    {selecting && <input className="selection-checkbox album-selection" type="checkbox" aria-label={`Select album ${album.title}`}
      checked={selectedIds.includes(album.id)} onChange={() => onSelect(album)} />}
    <div className="album-art">
      <button className="artwork-wrap" aria-label={`${selecting ? "Select" : "Open"} album ${album.title}`}
        onClick={() => selecting ? onSelect(album) : onOpen(album)}>
        <Cover id={album.artwork_id} title={album.title} />
        {album.atmos && <span className="album-atmos" title="Dolby Atmos"><Layers3 size={12} /></span>}
      </button>
      {!selecting && <motion.button className="quick-play" aria-label={`Play album ${album.title}`} whileTap={reduced ? undefined : { scale: .92 }}
        onClick={() => onPlay(album)}><Play size={16} fill="currentColor" /></motion.button>}
    </div>
    <div className="album-card-title">
      <button onClick={() => selecting ? onSelect(album) : onOpen(album)}><h3>{album.title}</h3></button>
      <FavoriteButton active={favoriteIds.includes(album.id)} label={`album ${album.title}`} onClick={() => onFavorite(album)} />
    </div>
    <p className="album-artist-name">{album.artist}</p>
    <span className="album-meta">{year(album.date) && <>{year(album.date)} · </>}{album.track_count} {album.track_count === 1 ? "track" : "tracks"}</span>
  </motion.article>)}</div>;
}
