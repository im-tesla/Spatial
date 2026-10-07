import test from "node:test";
import assert from "node:assert/strict";
import { changeFavorites, exportFavorites, importFavorites } from "../src/favoritesSharing.ts";

const empty = () => ({ albums: [], tracks: [] });
const album = { id: "server-a-album", title: "Night Letters", artist: "Spatial", date: "2026", track_count: 1, duration: 200, artwork_id: "private-artwork", atmos: true };
const track = { id: "server-a-track", title: "A quiet room", artist: "Spatial", album_artist: "Spatial", album: "Night Letters", date: "2026", disc_number: 1, track_number: 1, duration: 200,
  album_id: album.id, source_path: "private/file.m4a", token: "never-share-this", codec: "eac3", artwork_id: "private-artwork" };
const library = { albums: [album], tracks: [track], revision: 1 };
const favorite = { albums: [album.id], tracks: [track.id] };

test("portable favorites omit server-specific IDs, credentials, source paths and artwork", () => {
  const shared = exportFavorites(favorite, library);
  for (const privateValue of [album.id, track.id, "private/file", "never-share-this", "private-artwork"]) assert.ok(!shared.includes(privateValue));
  assert.equal(JSON.parse(shared).tracks[0].title, track.title);
  assert.deepEqual(JSON.parse(exportFavorites({ albums: ["deleted"], tracks: [] }, library)).albums, []);
});

test("import matches another server's IDs with normalized tags and merges existing favorites", () => {
  const other = { albums: [{ ...album, id: "server-b-album", title: " NIGHT   LETTERS ", date: "2026-04-01" }],
    tracks: [{ ...track, id: "server-b-track", title: "a QUIET room", duration: 201.5 }] };
  const result = importFavorites(exportFavorites(favorite, library), { albums: ["unrelated"], tracks: [] }, other);
  assert.deepEqual(result.favorites, { albums: ["unrelated", "server-b-album"], tracks: ["server-b-track"] });
  assert.equal(result.addedAlbums, 1); assert.equal(result.addedTracks, 1); assert.equal(result.missing, 0);
  const again = importFavorites(exportFavorites(favorite, library), result.favorites, other);
  assert.equal(again.addedAlbums + again.addedTracks, 0);
});

test("missing recordings and ambiguous editions are reported instead of guessed", () => {
  const duplicates = { albums: [{ ...album, id: "one" }, { ...album, id: "two" }],
    tracks: [{ ...track, id: "wrong-duration", duration: 250 }] };
  const result = importFavorites(exportFavorites(favorite, library), empty(), duplicates);
  assert.deepEqual(result.favorites, empty()); assert.equal(result.ambiguous, 1); assert.equal(result.missing, 1);
});

test("track numbering can resolve repeated titles but indistinguishable copies are skipped", () => {
  const repeated = { albums: [], tracks: [{ ...track, id: "correct" }, { ...track, id: "another", track_number: 3 }] };
  assert.deepEqual(importFavorites(exportFavorites({ albums: [], tracks: [track.id] }, library), empty(), repeated).favorites.tracks, ["correct"]);
  repeated.tracks[1].track_number = 1;
  assert.equal(importFavorites(exportFavorites({ albums: [], tracks: [track.id] }, library), empty(), repeated).ambiguous, 1);
});

test("invalid, unsupported and oversized lists are rejected before changing favorites", () => {
  const before = structuredClone(favorite);
  for (const source of ["not JSON", "{}", JSON.stringify({ format: "spatial-favorites", version: 2 }),
    JSON.stringify({ format: "spatial-favorites", version: 1, albums: [], tracks: [{ title: 7 }] }), "x".repeat(2_000_001)])
    assert.throws(() => importFavorites(source, favorite, library));
  assert.deepEqual(favorite, before);
});

test("bulk changes preserve unselected items, merge duplicates and support mixed selections", () => {
  const saved = { albums: ["a", "b"], tracks: ["x", "y"] }; const selected = { albums: ["b", "c", "c"], tracks: ["y", "z"] };
  assert.deepEqual(changeFavorites(saved, selected, "add"), { albums: ["a", "b", "c"], tracks: ["x", "y", "z"] });
  assert.deepEqual(changeFavorites(saved, selected, "remove"), { albums: ["a"], tracks: ["x"] });
  assert.deepEqual(saved, { albums: ["a", "b"], tracks: ["x", "y"] });
});
