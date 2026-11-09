import type { Album } from "./types";
import type { AlbumSort } from "./preferences";

export const albumSortLabels: Record<AlbumSort, string> = {
  newest: "Newest first",
  title: "Title A–Z",
  artist: "Artist A–Z",
};

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function sortAlbums(albums: Album[], sort: AlbumSort): Album[] {
  return [...albums].sort((a, b) => {
    if (sort === "title") return compare(a.title, b.title);
    if (sort === "artist") return compare(a.artist, b.artist) || compare(a.title, b.title);
    return (b.date || "").localeCompare(a.date || "") || compare(a.title, b.title);
  });
}
