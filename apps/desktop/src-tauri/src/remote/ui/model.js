export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function trackEntries(library, snapshot, view, albumId, query, favoritesOnly) {
  if (!library) return [];
  const byId = new Map(library.tracks.map(track => [track.id, track]));
  const entries = view === "queue" ? snapshot.queue_ids.map((id, index) => ({ track: byId.get(id), index })) :
    library.tracks.map((track, index) => ({ track, index }));
  const text = query.trim().toLocaleLowerCase();
  const favoriteIds = new Set(snapshot.favorite_ids);
  return entries.filter(({ track }) => track && (!albumId || track.album_id === albumId) &&
    (!favoritesOnly || favoriteIds.has(track.id)) && `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase().includes(text))
    .sort((a, b) => albumId ? a.track.disc_number - b.track.disc_number || a.track.track_number - b.track.track_number : 0);
}

export function transportAvailability(snapshot) {
  const current = !!snapshot.current;
  const busy = snapshot.starting || !snapshot.connected;
  return {
    play: current && !busy,
    previous: current && !busy && (snapshot.queue_index > 0 || snapshot.repeat === "all" || snapshot.status.position > 3),
    next: current && !busy && (snapshot.queue_index + 1 < snapshot.queue_ids.length || snapshot.repeat === "all"),
    seek: current && !busy && snapshot.status.active && snapshot.status.duration > 0,
  };
}
