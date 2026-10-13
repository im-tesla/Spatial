import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, activeLyric, lyricsTitle, lyricWordState, timedLyrics, highlightedLyrics } from "../src/lyrics.ts";
import { stringify } from "yaml";

test("LRC handles repeated timestamps, fractions, CRLF and timed silence", () => {
  const lines = parseLrc("[ar:Spatial]\r\n[00:10.125][00:20.5] Second line\r\n[00:02.01] First line\r\n[00:25.00]\r\n[00:99.00] Invalid timestamp");
  assert.deepEqual(lines, [
    { time: 2.01, text: "First line" }, { time: 10.125, text: "Second line" },
    { time: 20.5, text: "Second line" }, { time: 25, text: "" },
  ]);
});

test("highlighting respects timestamp boundaries, backward seeks and silence", () => {
  const lines = parseLrc("[00:02.00] First line\n[00:05.25] Second line\n[00:07.00]");
  assert.equal(activeLyric(lines, 0), -1);
  assert.equal(activeLyric(lines, 2), 0);
  assert.equal(activeLyric(lines, 5.249), 0);
  assert.equal(activeLyric(lines, 5.25), 1);
  assert.equal(activeLyric(lines, 7), 2);
  assert.equal(activeLyric(lines, 3), 0);
  assert.equal(activeLyric([], 100), -1);
});

const document = { version: "1.0", metadata: {}, lines: [
  { text: "A quiet room", start_ms: 1000, end_ms: 4000, words: [
    { text: "A ", start_ms: 1000, end_ms: 1300 }, { text: "quiet ", start_ms: 1700, end_ms: 2300 },
    { text: "room", start_ms: 3000, end_ms: 3800 },
  ] }, { text: "The lights turn green", start_ms: 5000, end_ms: 7000 },
] };
const timed = data => ({ id: 1, instrumental: false, plainLyrics: null, syncedLyrics: "[00:01.00] A quiet room", lyricsfile: stringify(data) });

test("real word timestamps preserve spacing, pauses and explicit line ends", () => {
  const lines = timedLyrics(timed(document), 8);
  assert.deepEqual(lines[0].words, [
    { text: "A ", start: 1, end: 1.3 }, { text: "quiet ", start: 1.7, end: 2.3 }, { text: "room", start: 3, end: 3.8 },
  ]);
  assert.equal(lines[0].words.map(word => word.text).join(""), lines[0].text);
  assert.deepEqual(lines.map(line => [line.time, line.text]), [[1, "A quiet room"], [4, ""], [5, "The lights turn green"], [7, ""]]);
  const word = lines[0].words[1];
  assert.equal(lyricWordState(word, 1.699), "upcoming");
  assert.equal(lyricWordState(word, 1.7), "active");
  assert.equal(lyricWordState(word, 2.299), "active");
  assert.equal(lyricWordState(word, 2.3), "sung");
  assert.equal(lyricWordState(word, 1.8), "active");
  assert.equal(lyricWordState(word, .5), "upcoming");
  assert.equal(lyricWordState(word, NaN), "upcoming");
});

test("missing word end times use the next supplied cue, never evenly spaced guesses", () => {
  const data = structuredClone(document);
  for (const word of data.lines[0].words) delete word.end_ms;
  const lines = timedLyrics(timed(data), 8);
  assert.deepEqual(lines[0].words.map(word => [word.start, word.end]), [[1, 1.7], [1.7, 3], [3, 4]]);
});

test("invalid words keep line timing, and malformed or unsupported documents fall back to LRC", () => {
  for (const mutate of [data => data.lines[0].words[1].start_ms = 900,
    data => data.lines[0].words[1].end_ms = 1500, data => data.lines[0].words[1].text = "different ",
    data => data.lines[0].words[2].end_ms = 9000]) {
    const data = structuredClone(document); mutate(data);
    const lines = timedLyrics(timed(data), 8);
    assert.equal(lines[0].text, "A quiet room"); assert.equal(lines[0].words, undefined);
  }
  for (const lyricsfile of ["version: [", "version: '2.0'\nlines: []", "a: &a [*a]\nlines: *a", "x".repeat(256001)])
    assert.deepEqual(timedLyrics({ ...timed(document), lyricsfile }, 8), [{ time: 1, text: "A quiet room" }]);
  const lines = timedLyrics({ ...timed(document), lyricsfile: undefined }, 8);
  assert.deepEqual(lines, [{ time: 1, text: "A quiet room" }]);
});

test("overlapping timed vocals keep both lines eligible for word highlighting", () => {
  const data = structuredClone(document);
  data.lines[1] = { text: "Another voice", start_ms: 2000, end_ms: 5000, words: [
    { text: "Another ", start_ms: 2000, end_ms: 3500 }, { text: "voice", start_ms: 3500, end_ms: 5000 },
  ] };
  const lines = timedLyrics(timed(data), 6);
  assert.deepEqual([...highlightedLyrics(lines, 2.1)], [1, 0]);
  assert.deepEqual([...highlightedLyrics(lines, 4.1)], [1]);
  assert.deepEqual([...highlightedLyrics(lines, .5)], []);
  delete data.lines[0].end_ms;
  const withoutLineEnd = timedLyrics(timed(data), 6);
  assert.equal(withoutLineEnd[0].words[2].end, 3.8);
  assert.deepEqual([...highlightedLyrics(withoutLineEnd, 3.2)], [1, 0]);
});

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const track = { title: "Test & title", artist: "Spatial Test Artist", album: "Test / album", duration: 42.4 };
const result = { id: 1, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 42, instrumental: false, plainLyrics: "An original test line", syncedLyrics: "[00:02.00] An original test line" };

test("lyrics searches remove the mix credit while preserving recording editions", async () => {
  for (const title of ["Song (Mixed By Tesla)", "Song [mixed by tesla]", "Song — mixed by tesla", "mixed by tesla - Song", "Song mixed BY TESLA"])
    assert.equal(lyricsTitle(title), "Song");
  assert.equal(lyricsTitle("Song (Live) (Mixed By Tesla)"), "Song (Live)");
  assert.equal(lyricsTitle("Mixed by someone else"), "Mixed by someone else");
  assert.equal(lyricsTitle("Song -"), "Song -");
  globalThis.localStorage = storage();
  const urls = [];
  globalThis.fetch = async url => { urls.push(new URL(url)); return Response.json(result); };
  const { getLyrics } = await import("../src/lyrics.ts?mix-title-test");
  const decorated = { ...track, title: `${track.title} (Mixed By Tesla)` };
  await getLyrics(decorated);
  await getLyrics(track);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("track_name"), track.title);
  assert.equal(decorated.title, `${track.title} (Mixed By Tesla)`);
});

test("lookup encodes metadata, deduplicates requests and reuses the local cache after restart", async () => {
  globalThis.localStorage = storage();
  const requests = [];
  const wordResult = { ...result, lyricsfile: stringify(document), hasWordSync: true };
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json(wordResult); };
  const { getLyrics } = await import("../src/lyrics.ts?cache-test");
  const [first, second] = await Promise.all([getLyrics(track), getLyrics(track)]);
  assert.deepEqual(first, second);
  assert.equal(first.lyricsfile, wordResult.lyricsfile);
  assert.equal(timedLyrics(first, track.duration)[0].words[1].start, 1.7);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get("track_name"), track.title);
  assert.equal(url.searchParams.get("artist_name"), track.artist);
  assert.equal(url.searchParams.get("duration"), "42");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  const restarted = await import("../src/lyrics.ts?restart-test");
  assert.deepEqual(await restarted.getLyrics(track), first);
  assert.equal(requests.length, 1);
});

test("requests run one at a time and respect provider Retry-After across tracks", async () => {
  globalThis.localStorage = storage();
  let requests = 0; let active = 0; let maxActive = 0;
  globalThis.fetch = async () => {
    requests++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return new Response("Not JSON", { status: 429, headers: { "Retry-After": "120" } });
  };
  const { getLyrics } = await import("../src/lyrics.ts?backoff-test");
  const responses = await Promise.allSettled([getLyrics(track), getLyrics({ ...track, title: "Another recording" })]);
  assert.equal(responses[0].status, "rejected");
  assert.equal(responses[1].status, "rejected");
  assert.equal(requests, 1);
  assert.equal(maxActive, 1);
  const restarted = await import("../src/lyrics.ts?backoff-restart");
  await assert.rejects(restarted.getLyrics({ ...track, title: "Third recording" }), /Try again in/);
  assert.equal(requests, 1);
});

test("older line-only caches refresh word data while remaining readable offline", async () => {
  globalThis.localStorage = storage();
  const key = JSON.stringify([track.title, track.artist, track.album, Math.round(track.duration)]);
  const old = { id: result.id, instrumental: false, plainLyrics: result.plainLyrics, syncedLyrics: result.syncedLyrics };
  localStorage.setItem("spatial-lyrics:v1", JSON.stringify([{ key, expires: Date.now() + 100000, value: old }]));
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new TypeError("offline fixture"); };
  const offline = await import("../src/lyrics.ts?legacy-offline");
  assert.deepEqual(await offline.getLyrics(track), old);
  assert.equal(requests, 1);
  globalThis.fetch = async () => { requests++; return Response.json({ ...result, lyricsfile: stringify(document) }); };
  const online = await import("../src/lyrics.ts?legacy-online");
  const refreshed = await online.getLyrics(track);
  assert.equal(requests, 2);
  assert.equal(timedLyrics(refreshed, track.duration)[0].words[1].start, 1.7);
  const restarted = await import("../src/lyrics.ts?legacy-restarted");
  assert.deepEqual(await restarted.getLyrics(track), refreshed);
  assert.equal(requests, 2);
});

test("missing lyrics are cached while a wrong recording duration is rejected", async () => {
  globalThis.localStorage = storage();
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(null, { status: 404 }); };
  const missing = await import("../src/lyrics.ts?missing-test");
  assert.equal(await missing.getLyrics(track), null);
  assert.equal(await missing.getLyrics(track), null);
  assert.equal(requests, 1);
  globalThis.localStorage = storage();
  globalThis.fetch = async () => Response.json({ ...result, duration: 60 });
  const mismatch = await import("../src/lyrics.ts?mismatch-test");
  await assert.rejects(mismatch.getLyrics(track), /duration/);
});
