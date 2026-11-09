export type Density = "comfortable" | "compact";
export type AlbumSort = "newest" | "title" | "artist";
export type LyricsSize = "small" | "standard" | "large";

export interface Preferences {
  allowStereo: boolean;
  exclusiveMode: boolean;
  volume: number;
  artworkColors: boolean;
  reduceMotion: boolean;
  density: Density;
  trackArtwork: boolean;
  albumSort: AlbumSort;
  lyricsSize: LyricsSize;
  lyricsOffset: number;
  lyricsFollow: boolean;
  lyricsBackdrop: boolean;
}

export const preferencesKey = "spatial-preferences:v1";

export const defaultPreferences: Preferences = {
  allowStereo: false,
  exclusiveMode: true,
  volume: 80,
  artworkColors: true,
  reduceMotion: false,
  density: "comfortable",
  trackArtwork: true,
  albumSort: "newest",
  lyricsSize: "standard",
  lyricsOffset: 0,
  lyricsFollow: true,
  lyricsBackdrop: true,
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : fallback;

export function sanitizePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return { ...defaultPreferences };
  const saved = value as Record<string, unknown>;
  const boolean = (key: keyof Preferences) => typeof saved[key] === "boolean" ? saved[key] as boolean : defaultPreferences[key] as boolean;
  const volume = typeof saved.volume === "number" && Number.isFinite(saved.volume)
    ? Math.max(0, Math.min(100, Math.round(saved.volume))) : defaultPreferences.volume;
  const lyricsOffset = typeof saved.lyricsOffset === "number" && Number.isFinite(saved.lyricsOffset)
    ? Math.min(10, Math.max(-10, Number((Math.round(saved.lyricsOffset * 10) / 10).toFixed(1))))
    : defaultPreferences.lyricsOffset;
  return {
    allowStereo: boolean("allowStereo"),
    exclusiveMode: boolean("exclusiveMode"),
    volume,
    artworkColors: boolean("artworkColors"),
    reduceMotion: boolean("reduceMotion"),
    density: oneOf(saved.density, ["comfortable", "compact"] as const, defaultPreferences.density),
    trackArtwork: boolean("trackArtwork"),
    albumSort: oneOf(saved.albumSort, ["newest", "title", "artist"] as const, defaultPreferences.albumSort),
    lyricsSize: oneOf(saved.lyricsSize, ["small", "standard", "large"] as const, defaultPreferences.lyricsSize),
    lyricsOffset,
    lyricsFollow: boolean("lyricsFollow"),
    lyricsBackdrop: boolean("lyricsBackdrop"),
  };
}

export function loadPreferences(storage: PreferenceStorage | undefined = globalThis.localStorage): Preferences {
  try {
    const saved = storage?.getItem(preferencesKey);
    return saved ? sanitizePreferences(JSON.parse(saved)) : { ...defaultPreferences };
  } catch {
    return { ...defaultPreferences };
  }
}

export function savePreferences(preferences: Preferences, storage: PreferenceStorage | undefined = globalThis.localStorage) {
  try { storage?.setItem(preferencesKey, JSON.stringify(preferences)); } catch { /* Preferences still apply for this session. */ }
}
