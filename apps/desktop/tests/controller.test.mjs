import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerSampler, defaultBindings, defaultControllerProfile, validBindings, validControllerProfile,
  swapBinding, readControllerActions, nextControllerFocus, loadControllerProfile, saveControllerProfile, controllerStorageKey } from "../src/controller.ts";

function pad(buttons = [], axes = [0, 0, 0, 0], index = 0, id = "Xbox fixture") {
  return { index, id, mapping: "standard", connected: true,
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 })), axes };
}
test("press edges fire once; navigation and seeking repeat on their own bounded schedules", () => {
  const sampler = new ControllerSampler(); sampler.sample([pad()], 0);
  assert.deepEqual(sampler.sample([pad([0, 9, 3])], 10), ["accept", "pause", "fullscreen"]);
  assert.deepEqual(sampler.sample([pad([0, 9, 3])], 999), []);
  sampler.sample([pad()], 1000);
  assert.deepEqual(sampler.sample([pad([0])], 1010), ["accept"]);
  assert.deepEqual(sampler.sample([pad([13, 4])], 1020), ["rewind", "down"]);
  assert.deepEqual(sampler.sample([pad([13, 4])], 1439), []);
  assert.deepEqual(sampler.sample([pad([13, 4])], 1440), ["rewind", "down"]);
  assert.deepEqual(sampler.sample([pad([13, 4])], 1590), ["down"]);
  assert.deepEqual(sampler.sample([pad([13, 4])], 1790), ["rewind", "down"]);
  assert.deepEqual(sampler.sample([pad([13, 4])], 100000), ["rewind", "down"]); // no catch-up burst
});
test("drift, diagonals, analog buttons and unsupported mappings are handled explicitly", () => {
  assert.deepEqual([...readControllerActions(pad([], [.54, -.54, 0, .54]), defaultBindings)], []);
  assert.deepEqual([...readControllerActions(pad([], [.8, -.9, 0, .9]), defaultBindings)], ["up", "scroll-down"]);
  assert.deepEqual([...readControllerActions(pad([13], [.9, -.95, 0, 0]), defaultBindings)], ["down"]);
  const analog = pad(); analog.buttons[4] = { pressed: false, value: .61 };
  assert.deepEqual([...readControllerActions(analog, defaultBindings)], ["rewind"]);
  analog.mapping = ""; assert.deepEqual([...readControllerActions(analog, defaultBindings)], []);
  assert.deepEqual([...readControllerActions(pad([], [NaN, Infinity, 0, -Infinity]), defaultBindings)], []);
});
test("new/reconnected controllers, suspension and binding changes suppress held inputs until release", () => {
  const sampler = new ControllerSampler();
  assert.deepEqual(sampler.sample([pad([0, 13])], 0), []);
  assert.deepEqual(sampler.sample([pad([0, 13])], 1000), []);
  sampler.sample([pad()], 1010);
  assert.deepEqual(sampler.sample([pad([0])], 1020), ["accept"]);
  sampler.suspend(); assert.deepEqual(sampler.sample([pad([0])], 2000), []);
  sampler.sample([pad()], 2010); assert.deepEqual(sampler.sample([pad([0])], 2020), ["accept"]);
  sampler.sample([], 2030); assert.deepEqual(sampler.sample([pad([0])], 2040), []);
  sampler.sample([pad()], 2050); sampler.setBindings(swapBinding({ ...defaultBindings }, "accept", 1));
  assert.deepEqual(sampler.sample([pad([1])], 2060), []);
  sampler.sample([pad()], 2070); assert.deepEqual(sampler.sample([pad([1])], 2080), ["accept"]);
  assert.deepEqual(sampler.sample([pad([1], undefined, 0, "Replacement controller")], 2090), []);
});
test("two controllers deduplicate actions and disconnected state cannot keep repeating", () => {
  const sampler = new ControllerSampler(); sampler.sample([pad(), pad([], undefined, 1)], 0);
  assert.deepEqual(sampler.sample([pad([13, 9]), pad([13, 9], undefined, 1)], 10), ["pause", "down"]);
  assert.deepEqual(sampler.sample([null], 1000), []);
  assert.deepEqual(sampler.sample([pad([13])], 1010), []);
});
test("mapping validation, conflict swaps and storage failures preserve the applied profile", () => {
  assert.equal(validBindings(defaultBindings), true);
  for (const value of [null, [], { ...defaultBindings, back: 0 }, { ...defaultBindings, pause: 12 },
    { ...defaultBindings, pause: 1.5 }, { ...defaultBindings, pause: "9" }, { ...defaultBindings, unknown: 2 }, { accept: 0 }])
    assert.equal(validBindings(value), false);
  assert.equal(validControllerProfile({ ...defaultControllerProfile(), unknown: true }), false);
  const swapped = swapBinding({ ...defaultBindings }, "accept", 1);
  assert.equal(swapped.accept, 1); assert.equal(swapped.back, 0); assert.equal(validBindings(swapped), true);
  assert.deepEqual(defaultBindings, { accept: 0, back: 1, pause: 9, rewind: 4, forward: 5, fullscreen: 3 });
  const storage = new Map([["spatial-server", "existing server"]]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.deepEqual(loadControllerProfile(), defaultControllerProfile());
  storage.set(controllerStorageKey, "corrupt"); assert.deepEqual(loadControllerProfile(), defaultControllerProfile());
  saveControllerProfile({ enabled: false, bindings: swapped });
  assert.deepEqual(loadControllerProfile(), { enabled: false, bindings: swapped });
  assert.equal(storage.get("spatial-server"), "existing server");
  const saved = storage.get(controllerStorageKey);
  globalThis.localStorage.setItem = () => { throw new Error("unavailable storage"); };
  assert.throws(() => saveControllerProfile(defaultControllerProfile()), /unavailable/);
  assert.equal(storage.get(controllerStorageKey), saved);
});
const rect = (left, top, width = 80, height = 30) => ({ left, top, width, height });
test("spatial navigation rejects controls behind and prefers aligned neighbors including off-screen rows", () => {
  const rectangles = [rect(100, 0), rect(0, 45, 220), rect(100, 90), rect(100, -40), rect(300, 20)];
  assert.equal(nextControllerFocus(rectangles, 0, "down"), 1); // close button -> first full-width popover row
  assert.equal(nextControllerFocus(rectangles, 0, "up"), 3);
  assert.equal(nextControllerFocus(rectangles, 0, "right"), 4);
  const rows = [rect(10, 0), rect(10, 1000), rect(500, 30)];
  assert.equal(nextControllerFocus(rows, 0, "down"), 1);
  assert.equal(nextControllerFocus(rows, 1, "up"), 0);
  assert.equal(nextControllerFocus([], -1, "up"), -1);
});
