import type { Library, Track } from "./types";

export type RemoteAction =
  | { action: "toggle_pause" | "next" | "previous" | "shuffle" | "repeat" }
  | { action: "seek"; seconds: number }
  | { action: "play"; id: string; album_id?: string | null; query?: string | null; favorites_only?: boolean | null }
  | { action: "queue"; index: number }
  | { action: "favorite"; id: string };
export type RemoteCommand = RemoteAction & { request_id: string };

export function remotePlaySelection(catalog: Library, id: string, albumId?: string | null, query: string | null = "", favorites?: string[]): { tracks: Track[]; index: number } {
  const text = (query ?? "").trim().toLocaleLowerCase();
  const saved = favorites && new Set(favorites);
  const tracks = catalog.tracks.filter(track => (!albumId || track.album_id === albumId) && (!saved || saved.has(track.id)) &&
    `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(text));
  if (albumId) tracks.sort((a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number);
  const index = tracks.findIndex(track => track.id === id);
  if (index < 0) throw new Error("This track is no longer in your library.");
  return { tracks, index };
}
