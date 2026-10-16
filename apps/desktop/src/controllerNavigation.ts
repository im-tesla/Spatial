import { nextControllerFocus } from "./controller";
import type { ControllerAction } from "./controller";

const selector = "button, a[href], input:not([type='hidden']), textarea, select, summary, [tabindex='0']";
function usable(element: HTMLElement) {
  const style = getComputedStyle(element);
  return !element.matches(":disabled, [aria-disabled='true']") && !element.closest("[inert], [aria-hidden='true']")
    && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && !element.classList.contains("sr-only")
    && element.getClientRects().length > 0 && element.getBoundingClientRect().width > 2 && element.getBoundingClientRect().height > 2;
}
function scope(): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(usable);
  return dialogs.at(-1) || document.body;
}
function items(root: HTMLElement) { return [...root.querySelectorAll<HTMLElement>(selector)].filter(usable); }
function highlight(element: HTMLElement) {
  document.documentElement.dataset.controller = "true";
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
}
function key(element: HTMLElement, name: string) {
  return element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}
function initial(root: HTMLElement, controls: HTMLElement[]) {
  return controls.find(element => root !== document.body && element.matches(".play-button"))
    || controls.find(element => element.closest(".main-content") && element.matches(".artwork-wrap, .track-title"))
    || controls.find(element => element.closest(".main-content") && !element.closest(".topbar"))
    || controls.find(element => element.matches(".nav-item.active")) || controls[0];
}
export function controllerNavigation(action: ControllerAction): boolean {
  if (action === "pause" || action === "rewind" || action === "forward" || action === "fullscreen") return false;
  const root = scope(), controls = items(root);
  const focused = document.activeElement instanceof HTMLElement && controls.includes(document.activeElement) ? document.activeElement : null;
  // A combobox owns its input until confirmed or dismissed; Back never leaks to the page.
  const expanded = root.querySelector<HTMLElement>('[role="combobox"][aria-expanded="true"]');
  if (expanded && usable(expanded) && ["up", "down", "accept", "back"].includes(action)) {
    highlight(expanded); key(expanded, action === "accept" ? "Enter" : action === "back" ? "Escape" : action === "up" ? "ArrowUp" : "ArrowDown"); return true;
  }
  if (action === "accept") {
    if (!focused) { const first = initial(root, controls); if (first) highlight(first); return true; }
    document.documentElement.dataset.controller = "true";
    if (key(focused, "Enter")) focused.click();
    return true;
  }
  if (action === "back") {
    if (focused?.matches("input:not([type='range']):not([type='checkbox']), textarea, [contenteditable='true']")) { focused.blur(); return true; }
    return false;
  }
  if (action === "scroll-up" || action === "scroll-down") {
    let container: HTMLElement | null = focused;
    while (container && container !== root && !(container.scrollHeight > container.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(container).overflowY))) container = container.parentElement;
    const target = container && container.scrollHeight > container.clientHeight + 1 ? container
      : root.querySelector<HTMLElement>(".lyrics-scroll, .main-content") || root;
    target.scrollBy({ top: action === "scroll-up" ? -100 : 100, behavior: "instant" });
    if (target.matches(".lyrics-scroll")) target.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    return true;
  }
  if (!["up", "down", "left", "right"].includes(action)) return false;
  if (!focused) { const first = initial(root, controls); if (first) highlight(first); return true; }
  if (focused instanceof HTMLInputElement && focused.type === "range" && (action === "left" || action === "right")) {
    const step = Number(focused.step) || 1, sign = action === "left" ? -1 : 1;
    const value = Math.max(Number(focused.min) || 0, Math.min(Number(focused.max) || 100, Number(focused.value) + sign * step));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(focused, String(value));
    focused.dispatchEvent(new Event("input", { bubbles: true })); focused.dispatchEvent(new Event("change", { bubbles: true }));
    focused.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true })); return true;
  }
  if (focused.getAttribute("role") === "separator" && (action === "left" || action === "right")) { key(focused, action === "left" ? "ArrowLeft" : "ArrowRight"); return true; }
  const index = nextControllerFocus(controls.map(element => element.getBoundingClientRect()), controls.indexOf(focused), action as "up" | "down" | "left" | "right");
  if (index >= 0) highlight(controls[index]);
  return true;
}
