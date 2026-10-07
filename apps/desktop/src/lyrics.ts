import type { Track } from "./types";

export type LyricLine = { time: number; text: string };
export type Lyrics = { id: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null };

// Keep empty timed lines: they mark instrumental passages and the end of singing.
export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const row of source.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const text = row.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, "").trim();
    for (const stamp of stamps) lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${stamp[3] || "0"}`), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function activeLyric(lines: LyricLine[], position: number): number {
  let low = 0; let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].time <= position) low = middle + 1; else high = middle;
  }
  return low - 1;
}

const CACHE_KEY = "spatial-lyrics:v1";
const BACKOFF_KEY = "spatial-lyrics-retry-after";
type Entry = { key: string; expires: number; value: Lyrics | null };
let queue = Promise.resolve();
let nextRequest = 0;
let retryAfter = 0;
const pending = new Map<string, Promise<Lyrics | null>>();
const memory = new Map<string, Entry>();

function cacheEntries(): Entry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    return Array.isArray(entries) ? entries.filter(entry => typeof entry?.key === "string" && Number.isFinite(entry.expires) && entry.expires > Date.now()
      && (entry.value === null || validLyrics(entry.value))) : [];
  } catch { return []; }
}

function validLyrics(value: unknown): value is Lyrics {
  if (!value || typeof value !== "object") return false;
  const record = value as Lyrics;
  return Number.isFinite(record.id) && typeof record.instrumental === "boolean"
    && (record.plainLyrics === null || typeof record.plainLyrics === "string")
    && (record.syncedLyrics === null || typeof record.syncedLyrics === "string");
}

function cache(key: string, value: Lyrics | null) {
  const entry = { key, value, expires: Date.now() + (value ? 7 * 86400000 : 6 * 3600000) };
  memory.delete(key); memory.set(key, entry);
  if (memory.size > 50) memory.delete(memory.keys().next().value!);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify([...cacheEntries().filter(item => item.key !== key), entry].slice(-50))); } catch { /* Memory cache still works. */ }
}

function backoff(header: string | null, fallback: number) {
  const seconds = header === null || !header.trim() ? NaN : Number(header);
  const until = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(header || "");
  retryAfter = Math.max(retryAfter, Number.isFinite(until) ? until : Date.now() + fallback * 1000);
  try { localStorage.setItem(BACKOFF_KEY, String(retryAfter)); } catch { /* Retain in memory. */ }
}

export function getLyrics(track: Track): Promise<Lyrics | null> {
  const duration = Math.round(track.duration);
  if (!track.title.trim() || !track.artist.trim() || !Number.isFinite(duration) || duration < 1 || duration > 3600)
    return Promise.reject(new Error("Lyrics lookup needs an artist, title and a duration between 1 second and 1 hour."));
  const key = JSON.stringify([track.title.trim(), track.artist.trim(), track.album.trim(), duration]);
  const saved = memory.get(key) || cacheEntries().find(entry => entry.key === key);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.value);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = queue.then(async () => {
    try { retryAfter = Math.max(retryAfter, Number(localStorage.getItem(BACKOFF_KEY)) || 0); } catch { /* Storage is optional. */ }
    if (Date.now() < retryAfter) throw new Error(`Lyrics service is busy. Try again in ${Math.ceil((retryAfter - Date.now()) / 1000)} seconds.`);
    const delay = nextRequest - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const params = new URLSearchParams({ track_name: track.title.trim(), artist_name: track.artist.trim(), album_name: track.album.trim(), duration: String(duration) });
      const response = await fetch(`https://lrclib.net/api/get?${params}`, {
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20000),
        headers: { "Lrclib-Client": "Spatial v0.1.0 (app.spatial.desktop)" },
      });
      if (response.status === 404) { cache(key, null); return null; }
      if (response.status === 429 || response.status === 503) {
        backoff(response.headers.get("Retry-After"), response.status === 429 ? 60 : 10);
        throw new Error("Lyrics service is busy. Please try again later.");
      }
      if (!response.ok) throw new Error("Lyrics service is unavailable. Please try again later.");
      const body = await response.text();
      if (body.length > 256000) throw new Error("The lyrics response is too large.");
      const value = JSON.parse(body);
      const matchedDuration = value?.duration;
      if (!validLyrics(value) || !Number.isFinite(matchedDuration) || Math.abs(matchedDuration - track.duration) > 2)
        throw new Error("No lyrics matched this recording's duration.");
      const lyrics: Lyrics = { id: value.id, instrumental: value.instrumental, plainLyrics: value.plainLyrics, syncedLyrics: value.syncedLyrics };
      cache(key, lyrics); return lyrics;
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError))
        throw new Error("Could not reach the lyrics service. Check your internet connection and try again.");
      throw error;
    } finally { nextRequest = Date.now() + 350; }
  });
  queue = request.then(() => undefined, () => undefined);
  pending.set(key, request);
  void request.then(() => pending.delete(key), () => pending.delete(key));
  return request;
}
