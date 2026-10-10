import assert from "node:assert/strict";
import test from "node:test";
import { remotePlaySelection } from "../src/remoteControl.ts";
import { formatTime, trackEntries, transportAvailability } from "../src-tauri/src/remote/ui/model.js";

const tracks = [
  { id: "a", album_id: "album", title: "First", artist: "Artist", album: "Album", disc_number: 1, track_number: 1 },
  { id: "b", album_id: "album", title: "Second", artist: "Artist", album: "Album", disc_number: 1, track_number: 2 },
  { id: "c", album_id: "other", title: "Third", artist: "Someone", album: "Other", disc_number: 1, track_number: 1 },
];
const library = { tracks, albums: [], revision: 1 };
const snapshot = { current: tracks[0], connected: true, starting: false, queue_ids: ["b", "a", "b"], queue_index: 0,
  favorite_ids: ["a"], repeat: "off", status: { active: true, duration: 180, position: 0 } };

test("phone album playback builds the album queue in disc and track order", () => {
  const selection = remotePlaySelection({ ...library, tracks: [...tracks].reverse() }, "b", "album");
  assert.deepEqual(selection.tracks.map(track => track.id), ["a", "b"]);
  assert.equal(selection.index, 1);
  assert.throws(() => remotePlaySelection(library, "c", "album"), /no longer/);
  assert.equal(remotePlaySelection(library, "c").index, 2);
  assert.equal(remotePlaySelection(library, "c", null, null).index, 2);
});

test("phone queue filtering preserves positions and duplicate entries", () => {
  assert.deepEqual(trackEntries(library, snapshot, "queue", null, "Second", false).map(entry => entry.index), [0, 2]);
  assert.deepEqual(trackEntries(library, snapshot, "tracks", null, "Artist", true).map(entry => entry.track.id), ["a"]);
  assert.deepEqual(trackEntries(library, snapshot, "albums", "other", "", false).map(entry => entry.track.id), ["c"]);
});

test("phone playback preserves the displayed search and favorites collection", () => {
  assert.deepEqual(remotePlaySelection(library, "a", null, "Artist", ["a"]).tracks.map(track => track.id), ["a"]);
  assert.deepEqual(remotePlaySelection(library, "c", null, "Someone").tracks.map(track => track.id), ["c"]);
  assert.throws(() => remotePlaySelection(library, "b", null, "", ["a"]), /no longer/);
});

test("phone transports match queue boundaries, repeat, seeking and busy states", () => {
  assert.deepEqual(transportAvailability(snapshot), { play: true, previous: false, next: true, seek: true });
  assert.equal(transportAvailability({ ...snapshot, status: { ...snapshot.status, position: 4 } }).previous, true);
  assert.equal(transportAvailability({ ...snapshot, queue_index: 2 }).next, false);
  assert.equal(transportAvailability({ ...snapshot, queue_index: 2, repeat: "all" }).next, true);
  assert.deepEqual(transportAvailability({ ...snapshot, starting: true }), { play: false, previous: false, next: false, seek: false });
  assert.deepEqual(transportAvailability({ ...snapshot, connected: false }), { play: false, previous: false, next: false, seek: false });
  assert.equal(transportAvailability({ ...snapshot, status: { ...snapshot.status, active: false } }).seek, false);
});

test("phone time formatting handles bad inputs and long tracks", () => {
  assert.equal(formatTime(-2), "0:00"); assert.equal(formatTime(NaN), "0:00");
  assert.equal(formatTime(183.9), "3:03"); assert.equal(formatTime(3601), "60:01");
});
