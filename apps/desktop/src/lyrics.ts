import type { Track } from "./types";
import appPackage from "../package.json" with { type: "json" };
import { parse as parseYaml } from "yaml";

export type LyricWord = { text: string; start: number; end: number };
export type LyricLine = { time: number; text: string; end?: number; words?: LyricWord[] };
export type Lyrics = { id: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null; lyricsfile?: string | null };

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

export function lyricWordState(word: LyricWord, position: number): "upcoming" | "active" | "sung" {
  if (!Number.isFinite(position) || position < word.start) return "upcoming";
  return position < word.end ? "active" : "sung";
}

export function highlightedLyrics(lines: LyricLine[], position: number): Set<number> {
  const selected = new Set<number>();
  const current = activeLyric(lines, position);
  if (current >= 0) selected.add(current);
  for (const [index, line] of lines.entries()) {
    if (line.words?.length && position >= line.time && position < (line.end ?? Math.max(...line.words.map(word => word.end))))
      selected.add(index);
  }
  return selected;
}

// LRCLIB's Lyricsfile 1.0 carries real word cues; ordinary LRC only has line cues.
export function timedLyrics(lyrics: Lyrics | null, duration: number): LyricLine[] {
  const fallback = () => parseLrc(lyrics?.syncedLyrics || "");
  if (!lyrics?.lyricsfile || lyrics.lyricsfile.length > 256000) return fallback();
  try {
    const document = parseYaml(lyrics.lyricsfile, { maxAliasCount: 0, logLevel: "silent" });
    if (document?.version !== "1.0" || !Array.isArray(document.lines) || document.lines.length > 3000) return fallback();
    // The draft leaves offset_ms semantics unresolved; timestamps are audio-relative.
    const timestamp = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value)
      && value >= 0 && value <= 3600000 ? value / 1000 : undefined;
    const lines: LyricLine[] = [];
    let wordCount = 0;
    for (const row of document.lines) {
      const time = timestamp(row?.start_ms), end = timestamp(row?.end_ms);
      if (time === undefined || typeof row?.text !== "string" || (end !== undefined && end < time)) return fallback();
      lines.push({ time, text: row.text, ...(end !== undefined ? { end } : {}) });
    }
    if (!lines.length || lines.some((line, index) => index > 0 && line.time < lines[index - 1].time)) return fallback();
    for (const [index, line] of lines.entries()) {
      const words = document.lines[index].words;
      if (!Array.isArray(words) || !words.length) continue;
      wordCount += words.length;
      if (wordCount > 10000 || words.length > 2048) return fallback();
      const lineEnd = line.end ?? lines.find((next, i) => i > index && next.time > line.time)?.time ?? duration;
      const cues: LyricWord[] = [];
      for (const [i, word] of words.entries()) {
        const start = timestamp(word?.start_ms);
        const end = word?.end_ms === undefined ? timestamp(words.find((next: { start_ms?: number }, j: number) => j > i && next?.start_ms !== undefined
          && word?.start_ms !== undefined && next.start_ms > word.start_ms)?.start_ms) ?? lineEnd : timestamp(word.end_ms);
        if (typeof word?.text !== "string" || !word.text || start === undefined || end === undefined || !Number.isFinite(end)
          || start < line.time || end < start || (line.end !== undefined && end > line.end) || (i > 0 && start < cues[i - 1].start)) break;
        cues.push({ text: word.text, start, end });
      }
      // Preserve punctuation/spacing, and reject mismatched or incomplete word data.
      if (cues.length === words.length && cues.map(word => word.text).join("").trim() === line.text.trim()) line.words = cues;
    }
    const withGaps: LyricLine[] = [];
    for (const [index, line] of lines.entries()) {
      withGaps.push(line);
      if (line.end !== undefined && line.end > line.time && line.end < (lines[index + 1]?.time ?? duration))
        withGaps.push({ time: line.end, text: "" });
    }
    return withGaps;
  } catch { return fallback(); }
}

const CACHE_KEY = "spatial-lyrics:v2";
const BACKOFF_KEY = "spatial-lyrics-retry-after";
type Entry = { key: string; expires: number; value: Lyrics | null };
let queue = Promise.resolve();
let nextRequest = 0;
let retryAfter = 0;
const pending = new Map<string, Promise<Lyrics | null>>();
const memory = new Map<string, Entry>();

function cacheEntries(cacheKey = CACHE_KEY): Entry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(cacheKey) || "[]");
    return Array.isArray(entries) ? entries.filter(entry => typeof entry?.key === "string" && Number.isFinite(entry.expires) && entry.expires > Date.now()
      && (entry.value === null || validLyrics(entry.value))) : [];
  } catch { return []; }
}

function validLyrics(value: unknown): value is Lyrics {
  if (!value || typeof value !== "object") return false;
  const record = value as Lyrics;
  return Number.isFinite(record.id) && typeof record.instrumental === "boolean"
    && (record.plainLyrics === null || typeof record.plainLyrics === "string")
    && (record.syncedLyrics === null || typeof record.syncedLyrics === "string")
    && (record.lyricsfile === undefined || record.lyricsfile === null || typeof record.lyricsfile === "string");
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

export function lyricsTitle(title: string): string {
  if (!/\bmixed\s+by\s+tesla\b/i.test(title)) return title.trim();
  return title.replace(/(?:\(\s*mixed\s+by\s+tesla\s*\)|\[\s*mixed\s+by\s+tesla\s*\])/gi, "")
    .replace(/\bmixed\s+by\s+tesla\b/gi, "")
    .replace(/\s+/g, " ").replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, "").trim();
}

export function getLyrics(track: Track): Promise<Lyrics | null> {
  const duration = Math.round(track.duration);
  const title = lyricsTitle(track.title);
  if (!title || !track.artist.trim() || !Number.isFinite(duration) || duration < 1 || duration > 3600)
    return Promise.reject(new Error("Lyrics lookup needs an artist, title and a duration between 1 second and 1 hour."));
  const key = JSON.stringify([title, track.artist.trim(), track.album.trim(), duration]);
  const saved = memory.get(key) || cacheEntries().find(entry => entry.key === key);
  if (saved && saved.expires > Date.now()) return Promise.resolve(saved.value);
  // Refresh older line-only cache entries for word data, retaining offline access.
  const legacy = cacheEntries("spatial-lyrics:v1").find(entry => entry.key === key && entry.value !== null);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = queue.then(async () => {
    try { retryAfter = Math.max(retryAfter, Number(localStorage.getItem(BACKOFF_KEY)) || 0); } catch { /* Storage is optional. */ }
    if (Date.now() < retryAfter) {
      if (legacy) return legacy.value;
      throw new Error(`Lyrics service is busy. Try again in ${Math.ceil((retryAfter - Date.now()) / 1000)} seconds.`);
    }
    const delay = nextRequest - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const params = new URLSearchParams({ track_name: title, artist_name: track.artist.trim(), album_name: track.album.trim(), duration: String(duration) });
      const response = await fetch(`https://lrclib.net/api/get?${params}`, {
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20000),
        headers: { "Lrclib-Client": `Spatial v${appPackage.version} (app.spatial.desktop)` },
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
      const lyrics: Lyrics = { id: value.id, instrumental: value.instrumental, plainLyrics: value.plainLyrics, syncedLyrics: value.syncedLyrics,
        ...(typeof value.lyricsfile === "string" ? { lyricsfile: value.lyricsfile } : {}) };
      cache(key, lyrics); return lyrics;
    } catch (error) {
      if (legacy) return legacy.value;
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
