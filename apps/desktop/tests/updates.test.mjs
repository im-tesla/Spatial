import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateController, updateInterval } from "../src/updateController.ts";

const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const events = [];
  const update = { version: "0.1.3", download: async progress => { events.push("download"); progress({ event: "Started", data: { contentLength: 100 } }); progress({ event: "Progress", data: { chunkLength: 50 } }); },
    install: async () => { events.push("install"); }, close: async () => { events.push("close"); } };
  const transport = { check: async () => update, prepare: async () => { events.push("stop"); }, cancel: async () => { events.push("cancel"); }, ...overrides };
  return { update, events, transport };
}

test("automatic checks announce updates without downloading or stopping playback, with cooldown", async () => {
  const f = fixture(); let clock = 100; let checks = 0;
  f.transport.check = async () => { checks++; return f.update; };
  const updater = createUpdateController(f.transport, () => clock);
  await updater.check(); await updater.check();
  assert.equal(checks, 1); assert.equal(updater.snapshot().phase, "available"); assert.deepEqual(f.events, []);
  clock += updateInterval; await updater.check();
  assert.equal(checks, 2); assert.deepEqual(f.events, ["close"]);
});

test("parallel checks and install clicks do not duplicate downloads, and verified download precedes playback stop", async () => {
  const waiting = deferred(); const f = fixture({ check: () => waiting.promise });
  const updater = createUpdateController(f.transport);
  const checking = updater.check(); await updater.check(true); waiting.resolve(f.update); await checking;
  const downloaded = deferred(); f.update.download = async progress => { f.events.push("download"); progress({ event: "Started", data: { contentLength: 10 } }); progress({ event: "Progress", data: { chunkLength: 5 } }); await downloaded.promise; };
  const installing = updater.install(); await updater.install();
  assert.equal(updater.snapshot().percent, 50); assert.deepEqual(f.events, ["download"]);
  downloaded.resolve(); await installing;
  assert.deepEqual(f.events, ["download", "stop", "install"]); assert.equal(updater.snapshot().phase, "installed");
});

test("failed or invalid downloads never stop playback or install, and may be retried", async () => {
  const f = fixture(); let downloads = 0;
  f.update.download = async () => { if (++downloads === 1) throw new Error("Signature invalid"); };
  const updater = createUpdateController(f.transport); await updater.check(); await updater.install();
  assert.equal(updater.snapshot().phase, "error"); assert.deepEqual(f.events, []);
  await updater.install(); assert.deepEqual(f.events, ["stop", "install"]); assert.equal(downloads, 2);
});

test("installer failure unlocks playback and reuses the verified download for retry", async () => {
  const f = fixture(); let attempts = 0;
  f.update.install = async () => { f.events.push("install"); if (++attempts === 1) throw new Error("Failed to launch installer"); };
  const updater = createUpdateController(f.transport); await updater.check(); await updater.install(); await updater.install();
  assert.deepEqual(f.events, ["download", "stop", "install", "cancel", "stop", "install"]);
});

test("offline background checks stay quiet while manual checks report failure and current versions", async () => {
  const f = fixture({ check: async () => { throw new Error("Offline"); } });
  const updater = createUpdateController(f.transport); await updater.check(); assert.equal(updater.snapshot().phase, "idle");
  await updater.check(true); assert.equal(updater.snapshot().phase, "error");
  f.transport.check = async () => null; await updater.check(true); assert.equal(updater.snapshot().phase, "current");
});

test("failed preparation releases playback protection and never launches the installer", async () => {
  const f = fixture({ prepare: async () => { throw new Error("Lost IPC response"); } });
  const updater = createUpdateController(f.transport); await updater.check(); await updater.install();
  assert.deepEqual(f.events, ["download", "cancel"]); assert.equal(updater.snapshot().phase, "error");
});
