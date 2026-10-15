import { test } from "node:test";
import assert from "node:assert/strict";
import { isSpatialMix } from "../src/mixes.ts";

test("Spatial Mix titles join the collection while existing mix credits remain supported", () => {
  for (const title of ["Song (Spatial Mix)", "Song [SPATIAL MIX]", "Song — spatial mix", "Song ( Spatial  Mix )",
    "Song (mixed by tesla)", "Song — MIXED BY TESLA"])
    assert.equal(isSpatialMix(title), true, title);
  for (const title of ["Song", "Spatial Mixture", "Spatial Mixes", "Song (mixed by someone else)"])
    assert.equal(isSpatialMix(title), false, title);
});
