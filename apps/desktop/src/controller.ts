export const bindingActions = ["accept", "back", "pause", "rewind", "forward", "fullscreen"] as const;
export type BindingAction = typeof bindingActions[number];
export type ControllerAction = BindingAction | "up" | "down" | "left" | "right" | "scroll-up" | "scroll-down";
export type Bindings = Record<BindingAction, number>;
export type ControllerProfile = { enabled: boolean; bindings: Bindings };
export const defaultBindings: Readonly<Bindings> = Object.freeze({ accept: 0, back: 1, pause: 9, rewind: 4, forward: 5, fullscreen: 3 });
export const buttonLabels = ["A / Cross", "B / Circle", "X / Square", "Y / Triangle", "LB / L1", "RB / R1",
  "LT / L2", "RT / R2", "View / Share", "Menu / Options", "Left stick press / L3", "Right stick press / R3"];
export const controllerStorageKey = "spatial-controller:v1";

export function validBindings(value: unknown): value is Bindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === bindingActions.length && bindingActions.every(action => Number.isInteger(object[action])
    && Number(object[action]) >= 0 && Number(object[action]) <= 11) && new Set(Object.values(object)).size === bindingActions.length;
}
export function validControllerProfile(value: unknown): value is ControllerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as ControllerProfile;
  return Object.keys(profile).length === 2 && typeof profile.enabled === "boolean" && validBindings(profile.bindings);
}
export const defaultControllerProfile = (): ControllerProfile => ({ enabled: true, bindings: { ...defaultBindings } });
export function loadControllerProfile(): ControllerProfile {
  try { const value = JSON.parse(localStorage.getItem(controllerStorageKey) || "null"); return validControllerProfile(value) ? value : defaultControllerProfile(); }
  catch { return defaultControllerProfile(); }
}
export function saveControllerProfile(profile: ControllerProfile) {
  if (!validControllerProfile(profile)) throw new Error("Invalid controller mapping.");
  localStorage.setItem(controllerStorageKey, JSON.stringify(profile));
}
export function swapBinding(bindings: Bindings, action: BindingAction, button: number): Bindings {
  if (!validBindings(bindings) || !bindingActions.includes(action) || !Number.isInteger(button) || button < 0 || button > 11)
    throw new Error("Invalid controller mapping.");
  const other = bindingActions.find(item => bindings[item] === button);
  return { ...bindings, ...(other ? { [other]: bindings[action] } : {}), [action]: button };
}

export type PadSnapshot = { index: number; id: string; mapping: string; connected: boolean;
  buttons: readonly { pressed: boolean; value: number }[]; axes: readonly number[] };
const pressed = (pad: PadSnapshot, index: number) => !!pad.buttons[index]?.pressed || pad.buttons[index]?.value > .6;
const axis = (pad: PadSnapshot, index: number) => Number.isFinite(pad.axes[index]) ? pad.axes[index] : 0;
export function readControllerActions(pad: PadSnapshot, bindings: Bindings): Set<ControllerAction> {
  const actions = new Set<ControllerAction>();
  if (!pad.connected || pad.mapping !== "standard") return actions;
  for (const action of bindingActions) if (pressed(pad, bindings[action])) actions.add(action);
  const vertical = Number(pressed(pad, 13)) - Number(pressed(pad, 12));
  const horizontal = Number(pressed(pad, 15)) - Number(pressed(pad, 14));
  const x = axis(pad, 0), y = axis(pad, 1);
  if (vertical) actions.add(vertical < 0 ? "up" : "down");
  else if (horizontal) actions.add(horizontal < 0 ? "left" : "right");
  else if (Math.max(Math.abs(x), Math.abs(y)) > .55)
    actions.add(Math.abs(y) >= Math.abs(x) ? y < 0 ? "up" : "down" : x < 0 ? "left" : "right");
  if (Math.abs(axis(pad, 3)) > .55) actions.add(axis(pad, 3) < 0 ? "scroll-up" : "scroll-down");
  return actions;
}
const repeating = new Set<ControllerAction>(["up", "down", "left", "right", "scroll-up", "scroll-down", "rewind", "forward"]);
type Held = { blocked: boolean; next: number };
export class ControllerSampler {
  private bindings: Bindings = { ...defaultBindings };
  private devices = new Map<string, Map<ControllerAction, Held>>();
  setBindings(bindings: Bindings) {
    if (!validBindings(bindings)) throw new Error("Invalid controller mapping.");
    if (bindingActions.some(action => this.bindings[action] !== bindings[action])) { this.bindings = { ...bindings }; this.suspend(); }
  }
  suspend() { this.devices.clear(); }
  sample(pads: readonly (PadSnapshot | null)[], now: number): ControllerAction[] {
    const result = new Set<ControllerAction>(), live = new Set<string>();
    for (const pad of pads) {
      if (!pad?.connected || pad.mapping !== "standard") continue;
      const key = `${pad.index}:${pad.id}`; live.add(key);
      const actions = readControllerActions(pad, this.bindings);
      let held = this.devices.get(key);
      if (!held) { this.devices.set(key, new Map([...actions].map(action => [action, { blocked: true, next: Infinity }]))); continue; }
      for (const action of held.keys()) if (!actions.has(action)) held.delete(action);
      for (const action of actions) {
        const previous = held.get(action);
        if (!previous) { held.set(action, { blocked: false, next: now + 420 }); result.add(action); }
        else if (!previous.blocked && repeating.has(action) && now >= previous.next) {
          previous.next = now + (action === "rewind" || action === "forward" ? 350 : 150); result.add(action);
        }
      }
    }
    for (const key of this.devices.keys()) if (!live.has(key)) this.devices.delete(key);
    return [...result];
  }
}

export type FocusRect = { left: number; top: number; width: number; height: number };
export function nextControllerFocus(rectangles: readonly FocusRect[], current: number, direction: "up" | "down" | "left" | "right"): number {
  const origin = rectangles[current];
  if (!origin) return rectangles.length ? 0 : -1;
  const vertical = direction === "up" || direction === "down", sign = direction === "up" || direction === "left" ? -1 : 1;
  let winner = -1, score = Infinity;
  for (const [index, rectangle] of rectangles.entries()) {
    if (index === current) continue;
    const dx = rectangle.left + rectangle.width / 2 - origin.left - origin.width / 2;
    const dy = rectangle.top + rectangle.height / 2 - origin.top - origin.height / 2;
    const forward = (vertical ? dy : dx) * sign;
    if (forward <= 1) continue;
    const cross = Math.abs(vertical ? dx : dy);
    const overlaps = cross < (vertical ? origin.width + rectangle.width : origin.height + rectangle.height) / 2;
    const value = forward + .5 * cross + (overlaps ? 0 : 1000);
    if (value < score) { winner = index; score = value; }
  }
  return winner;
}
