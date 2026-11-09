import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, Layers3, Play, Shuffle, Users } from "lucide-react";
import AlbumGrid from "./AlbumGrid";
import ArtistCover from "./ArtistCover";
import { ease } from "./motion";
import type { Album } from "./types";
import type { Artist } from "./artists";

function count(value: number, singular: string) {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function ArtistsGrid({ artists, onOpen }: { artists: Artist[]; onOpen: (artist: Artist) => void }) {
  const reduced = useReducedMotion();
  return <div className="artist-grid">{artists.map((artist, index) => <motion.button key={artist.key}
    className="artist-card" aria-label={`Open artist ${artist.name}`} onClick={() => onOpen(artist)}
    initial={reduced || index >= 16 ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
    transition={{ duration: reduced ? 0 : .35, delay: reduced || index >= 16 ? 0 : index * .02, ease }}
    whileHover={reduced ? undefined : { y: -3 }}>
    <ArtistCover name={artist.name} artworkId={artist.artworkId} />
    <span className="artist-card-copy"><strong>{artist.name}</strong>
      <small>{artist.albums.length ? count(artist.albums.length, "album") : "Guest artist"}{artist.trackCount ? ` · ${count(artist.trackCount, "track")}` : ""}</small>
    </span>
  </motion.button>)}</div>;
}

export default function ArtistView({ artist, favoriteIds, sortLabel, search = "", onBack, onOpenAlbum, onPlayAlbum, onPlayAll, onShuffleAll, onFavoriteAlbum }: {
  artist: Artist; favoriteIds: string[]; sortLabel: string; search?: string; onBack: () => void;
  onOpenAlbum: (album: Album) => void; onPlayAlbum: (album: Album) => void;
  onPlayAll: () => void; onShuffleAll: () => void; onFavoriteAlbum: (album: Album) => void;
}) {
  const reduced = useReducedMotion();
  const query = search.trim().toLowerCase();
  const match = (album: Album) => !query || `${album.title} ${album.artist}`.toLowerCase().includes(query);
  const albums = artist.albums.filter(match);
  const appearsOn = artist.appearsOn.filter(match);
  const noop = () => {};
  return <>
    <button className="back-button" onClick={onBack}><ArrowLeft size={16} /> All artists</button>
    <motion.section className="artist-hero" initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : .4, ease }}>
      <ArtistCover name={artist.name} artworkId={artist.artworkId} className="artist-hero-portrait" eager />
      <div className="artist-hero-copy">
        <span className="eyebrow">ARTIST</span>
        <h1>{artist.name}</h1>
        <p className="artist-stats">
          {artist.albums.length ? count(artist.albums.length, "album") : "Guest artist"}
          {artist.trackCount > 0 && <><span>·</span>{count(artist.trackCount, "track")}</>}
          {artist.atmos && <><span>·</span><span className="artist-atmos"><Layers3 size={13} /> Dolby Atmos</span></>}
        </p>
        <div className="artist-actions">
          <button className="primary" disabled={!artist.tracks.length} onClick={onPlayAll}><Play size={16} fill="currentColor" /> Play</button>
          <button className="secondary" disabled={!artist.tracks.length} onClick={onShuffleAll}><Shuffle size={16} /> Shuffle</button>
        </div>
      </div>
    </motion.section>
    {albums.length ? <section className="collection-section artist-albums">
      <div className="section-bar"><h2>{query ? "Search results" : "Albums"}<span>{albums.length}</span></h2><span className="sort-label">{sortLabel}</span></div>
      <AlbumGrid albums={albums} favoriteIds={favoriteIds} layoutKey={`artist:${artist.key}:${query}`} onOpen={onOpenAlbum} onPlay={onPlayAlbum}
        onFavorite={onFavoriteAlbum} onSelect={noop} />
    </section> : <section className="collection-section"><div className="empty-state"><Users size={38} /><h3>{query ? "No albums match this search" : "No albums by this artist"}</h3><p>{query ? "Try a different album title." : "This artist appears on albums in your collection, shown below."}</p></div></section>}
    {appearsOn.length > 0 && <section className="collection-section artist-appears">
      <div className="section-bar"><h2>Appears on<span>{appearsOn.length}</span></h2></div>
      <AlbumGrid albums={appearsOn} favoriteIds={favoriteIds} layoutKey={`artist:${artist.key}:appears:${query}`} onOpen={onOpenAlbum}
        onPlay={onPlayAlbum} onFavorite={onFavoriteAlbum} onSelect={noop} />
    </section>}
  </>;
}
