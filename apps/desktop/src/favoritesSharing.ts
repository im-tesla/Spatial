import type { Album, Library, Track } from "./types.ts";
import type { Favorites } from "./favorites.ts";

type SharedAlbum = Pick<Album, "title" | "artist" | "date">;
type SharedTrack = Pick<Track, "title" | "artist" | "album" | "album_artist" | "date" | "disc_number" | "track_number" | "duration">;
type SharedFavorites = { format: "spatial-favorites"; version: 1; albums: SharedAlbum[]; tracks: SharedTrack[] };
const limit = 10000;
const textLimit = 2_000_000;
const normalized = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const key = (...values: string[]) => JSON.stringify(values.map(normalized));

export function changeFavorites(favorites: Favorites, selected: Favorites, action: "add" | "remove"): Favorites {
  const removed = { albums: new Set(selected.albums), tracks: new Set(selected.tracks) };
  const change = (kind: keyof Favorites) => action === "add" ? [...new Set([...favorites[kind], ...selected[kind]])]
    : favorites[kind].filter(id => !removed[kind].has(id));
  return { albums: change("albums"), tracks: change("tracks") };
}

export function exportFavorites(favorites: Favorites, library: Library): string {
  const albums = new Set(favorites.albums); const tracks = new Set(favorites.tracks);
  // Explicit fields keep server addresses, IDs, credentials, paths and artwork out of the shared list.
  const shared: SharedFavorites = { format: "spatial-favorites", version: 1,
    albums: library.albums.filter(album => albums.has(album.id)).map(({ title, artist, date }) => ({ title, artist, date })),
    tracks: library.tracks.filter(track => tracks.has(track.id)).map(({ title, artist, album, album_artist, date, disc_number, track_number, duration }) =>
      ({ title, artist, album, album_artist, date, disc_number, track_number, duration })),
  };
  const result = JSON.stringify(shared, null, 2);
  if (shared.albums.length + shared.tracks.length > limit || result.length > textLimit)
    throw new Error("This favorites list is too large to share. Share a smaller selection.");
  return result;
}

function parse(source: string): SharedFavorites {
  if (source.length > textLimit) throw new Error("This favorites list is too large to import.");
  let data: unknown;
  try { data = JSON.parse(source); } catch { throw new Error("Paste a Spatial favorites list copied from another client."); }
  if (!data || typeof data !== "object" || !("format" in data) || data.format !== "spatial-favorites")
    throw new Error("This is not a Spatial favorites list.");
  if (!("version" in data) || data.version !== 1) throw new Error("This favorites list uses an unsupported version.");
  if (!("albums" in data) || !("tracks" in data) || !Array.isArray(data.albums) || !Array.isArray(data.tracks)
    || data.albums.length + data.tracks.length > limit) throw new Error("This favorites list has invalid or too many entries.");
  const string = (value: unknown) => typeof value === "string" && value.length <= 2000;
  const album = (item: unknown): item is SharedAlbum => !!item && typeof item === "object"
    && "title" in item && string(item.title) && "artist" in item && string(item.artist) && "date" in item && string(item.date);
  const ordinal = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000;
  const track = (item: unknown): item is SharedTrack => album(item) && "album" in item && string(item.album)
    && "album_artist" in item && string(item.album_artist) && "duration" in item && typeof item.duration === "number"
    && Number.isFinite(item.duration) && item.duration >= 0 && "disc_number" in item && ordinal(item.disc_number)
    && "track_number" in item && ordinal(item.track_number);
  if (!data.albums.every(album) || !data.tracks.every(track)) throw new Error("This favorites list contains invalid entries.");
  return { format: "spatial-favorites", version: 1, albums: data.albums, tracks: data.tracks };
}

function index<T>(items: T[], identity: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) { const id = identity(item); const group = result.get(id) || []; group.push(item); result.set(id, group); }
  return result;
}
function sameDate(a: string, b: string) {
  if (!a || !b) return true;
  const yearA = a.match(/^\d{4}/)?.[0]; const yearB = b.match(/^\d{4}/)?.[0];
  return yearA && yearB ? yearA === yearB : normalized(a) === normalized(b);
}

export function importFavorites(source: string, favorites: Favorites, library: Library) {
  const shared = parse(source);
  const albums = index(library.albums, album => key(album.title, album.artist));
  const tracks = index(library.tracks, track => key(track.title, track.artist, track.album, track.album_artist));
  const matched: Favorites = { albums: [], tracks: [] };
  let missing = 0; let ambiguous = 0;
  const record = (kind: keyof Favorites, candidates: { id: string }[]) => {
    if (!candidates.length) missing++;
    else if (candidates.length > 1) ambiguous++;
    else matched[kind].push(candidates[0].id);
  };
  // Duplicate copied entries should never inflate counts or introduce duplicate IDs.
  const unique = <T>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
  for (const album of unique(shared.albums)) record("albums", (albums.get(key(album.title, album.artist)) || [])
    .filter(candidate => sameDate(album.date, candidate.date)));
  for (const track of unique(shared.tracks)) {
    let candidates = (tracks.get(key(track.title, track.artist, track.album, track.album_artist)) || [])
      .filter(candidate => sameDate(track.date, candidate.date)
        && (!track.duration || !candidate.duration || Math.abs(track.duration - candidate.duration) <= 2));
    if (candidates.length > 1) {
      const numbered = candidates.filter(candidate => (!track.disc_number || track.disc_number === candidate.disc_number)
        && (!track.track_number || track.track_number === candidate.track_number));
      if (numbered.length) candidates = numbered;
    }
    record("tracks", candidates);
  }
  const next = changeFavorites(favorites, matched, "add");
  return { favorites: next, addedAlbums: next.albums.length - new Set(favorites.albums).size,
    addedTracks: next.tracks.length - new Set(favorites.tracks).size, missing, ambiguous };
}
