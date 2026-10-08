import test from "node:test";
import assert from "node:assert/strict";
import { loadDiscordEnabled, saveDiscordEnabled } from "../src/discordPreferences.ts";

test("Discord sharing starts enabled and preserves an explicit opt-out after restart", () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  assert.equal(loadDiscordEnabled(storage), true);
  saveDiscordEnabled(true, storage); assert.equal(loadDiscordEnabled(storage), true);
  saveDiscordEnabled(false, storage); assert.equal(loadDiscordEnabled(storage), false);
  saved.set("spatial-discord-enabled", "unexpected"); assert.equal(loadDiscordEnabled(storage), true);
});
test("unavailable preference storage retains the default and does not break controls", () => {
  const unavailable = { getItem: () => { throw new Error("Unavailable"); }, setItem: () => { throw new Error("Unavailable"); } };
  assert.equal(loadDiscordEnabled(unavailable), true);
  assert.doesNotThrow(() => saveDiscordEnabled(true, unavailable));
});
