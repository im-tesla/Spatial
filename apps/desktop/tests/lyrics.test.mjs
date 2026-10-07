import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, activeLyric } from "../src/lyrics.ts";

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

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const track = { title: "Test & title", artist: "Spatial Test Artist", album: "Test / album", duration: 42.4 };
const result = { id: 1, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 42, instrumental: false, plainLyrics: "An original test line", syncedLyrics: "[00:02.00] An original test line" };

test("lookup encodes metadata, deduplicates requests and reuses the local cache after restart", async () => {
  globalThis.localStorage = storage();
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json(result); };
  const { getLyrics } = await import("../src/lyrics.ts?cache-test");
  const [first, second] = await Promise.all([getLyrics(track), getLyrics(track)]);
  assert.deepEqual(first, second);
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
