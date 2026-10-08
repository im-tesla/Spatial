import test from "node:test";
import assert from "node:assert/strict";
import { loadDiscordEnabled, saveDiscordEnabled } from "../src/discordPreferences.ts";

test("Discord sharing starts disabled, requires an explicit choice, and survives restart", () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  assert.equal(loadDiscordEnabled(storage), false);
  saveDiscordEnabled(true, storage); assert.equal(loadDiscordEnabled(storage), true);
  saveDiscordEnabled(false, storage); assert.equal(loadDiscordEnabled(storage), false);
  saved.set("spatial-discord-enabled", "unexpected"); assert.equal(loadDiscordEnabled(storage), false);
});
test("unavailable preference storage does not enable sharing or break controls", () => {
  const unavailable = { getItem: () => { throw new Error("Unavailable"); }, setItem: () => { throw new Error("Unavailable"); } };
  assert.equal(loadDiscordEnabled(unavailable), false);
  assert.doesNotThrow(() => saveDiscordEnabled(true, unavailable));
});
