import type { Album, Library, Track } from "./types";

export interface Artist {
  key: string;
  name: string;
  sortName: string;
  albums: Album[];
  appearsOn: Album[];
  tracks: Track[];
  trackCount: number;
  atmos: boolean;
  artworkId: string | null;
}

// Artist names are not guaranteed to be unique in a tag set, but a normalized
// spelling is stable enough to join album credits and track credits.
export function artistKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function artistSortName(name: string): string {
  return artistKey(name).replace(/^the\s+/, "");
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function newestFirst(a: Album, b: Album) {
  return (b.date || "").localeCompare(a.date || "") || compareText(a.title, b.title);
}

export function buildArtists(library: Library): Artist[] {
  const artists = new Map<string, Artist>();
  const albumById = new Map(library.albums.map(album => [album.id, album]));
  const appearsOn = new Map<string, Set<string>>();
  const seenTracks = new Map<string, Set<string>>();

  const ensure = (name: string): Artist => {
    const key = artistKey(name);
    let artist = artists.get(key);
    if (!artist) {
      artist = {
        key, name: name.trim(), sortName: artistSortName(name),
        albums: [], appearsOn: [], tracks: [], trackCount: 0, atmos: false, artworkId: null,
      };
      artists.set(key, artist);
      appearsOn.set(key, new Set());
      seenTracks.set(key, new Set());
    }
    return artist;
  };

  for (const album of library.albums) ensure(album.artist).albums.push(album);

  for (const track of library.tracks) {
    const trackKey = artistKey(track.artist);
    const albumKey = artistKey(track.album_artist);
    const owner = ensure(track.album_artist);
    const performer = ensure(track.artist);
    for (const artist of trackKey === albumKey ? [owner] : [owner, performer]) {
      const seen = seenTracks.get(artist.key)!;
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      artist.tracks.push(track);
      if (track.atmos) artist.atmos = true;
    }
    if (trackKey !== albumKey) {
      const album = albumById.get(track.album_id);
      if (album) appearsOn.get(trackKey)!.add(album.id);
    }
  }

  const result = [...artists.values()];
  for (const artist of result) {
    artist.albums.sort(newestFirst);
    artist.appearsOn = [...appearsOn.get(artist.key)!]
      .map(id => albumById.get(id))
      .filter((album): album is Album => !!album)
      .sort(newestFirst);
    artist.tracks.sort((a, b) => {
      const albumA = albumById.get(a.album_id), albumB = albumById.get(b.album_id);
      return (albumA?.date || "").localeCompare(albumB?.date || "") || a.disc_number - b.disc_number
        || a.track_number - b.track_number || compareText(a.title, b.title);
    });
    artist.trackCount = artist.tracks.length;
    artist.atmos = artist.atmos || artist.albums.some(album => album.atmos);
    artist.artworkId = artist.albums.find(album => album.artwork_id)?.artwork_id
      || artist.tracks.find(track => track.artwork_id)?.artwork_id || null;
  }
  return result.sort((a, b) => compareText(a.sortName, b.sortName) || compareText(a.name, b.name));
}

export function filterArtists(artists: Artist[], search: string): Artist[] {
  const query = search.trim().toLowerCase();
  return query ? artists.filter(artist => `${artist.name} ${artist.albums.map(album => album.title).join(" ")}`.toLowerCase().includes(query)) : artists;
}

export function artistForName(artists: Artist[], name: string): Artist | undefined {
  const key = artistKey(name);
  return artists.find(artist => artist.key === key);
}
