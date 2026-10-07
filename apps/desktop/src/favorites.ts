export type Favorites = { albums: string[]; tracks: string[] };

export const emptyFavorites = (): Favorites => ({ albums: [], tracks: [] });

function storageKey(address: string) {
  const url = new URL(address.trim());
  return `spatial-favorites:v1:${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function loadFavorites(address: string): Favorites {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(address)) || "null");
    const ids = (value: unknown): string[] => Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
    return { albums: ids(saved?.albums), tracks: ids(saved?.tracks) };
  } catch { return emptyFavorites(); }
}

export function saveFavorites(address: string, favorites: Favorites) {
  localStorage.setItem(storageKey(address), JSON.stringify(favorites));
}
