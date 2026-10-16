// Test-only input provider. Vite's production entry never imports this module.
export function installControllerFixture() {
  const capabilities = { secure: window.isSecureContext, api: typeof navigator.getGamepads === "function", origin: location.origin };
  const state = { foreground: true, connected: true };
  const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  const gamepad = { id: "Simulated Xbox controller", index: 0, mapping: "standard", connected: true, buttons, axes, timestamp: 0 };
  if (capabilities.api && capabilities.secure) Object.defineProperty(navigator, "getGamepads", {
    configurable: true, value: () => state.connected ? [gamepad] : [],
  });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:8px;top:8px;z-index:10000";
  const panel = host.attachShadow({ mode: "open" });
  const style = document.createElement("style"); style.textContent = "section{background:#161a20;color:#fff;border:1px solid #7e899b;border-radius:8px;padding:8px;font:11px system-ui;max-width:540px}button{font:inherit;margin:3px;padding:4px;color:#fff;background:#343d4b;border:1px solid #8290a3;border-radius:4px}p{margin:3px}button[aria-pressed=true]{background:#586f36}";
  const section = document.createElement("section"); section.setAttribute("aria-label", "Controller test input");
  section.onpointerdown = event => { event.preventDefault(); event.stopPropagation(); };
  const summary = document.createElement("p"); summary.textContent = `TEST INPUT · real API: ${capabilities.api} · secure: ${capabilities.secure} · ${capabilities.origin}`; section.append(summary);
  const keyNames = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "L3", "R3", "Up", "Down", "Left", "Right"];
  function pulse(index: number) { buttons[index] = { pressed: true, touched: true, value: 1 }; window.setTimeout(() => { buttons[index] = { pressed: false, touched: false, value: 0 }; }, 100); }
  for (const [index, name] of keyNames.entries()) { const button = document.createElement("button"); button.textContent = `Pad ${name}`; button.onclick = () => pulse(index); section.append(button); }
  const background = document.createElement("button"); background.textContent = "Simulate inactive window";
  background.onclick = () => { state.foreground = !state.foreground; background.setAttribute("aria-pressed", String(!state.foreground)); }; section.append(background);
  const disconnect = document.createElement("button"); disconnect.textContent = "Simulate disconnect";
  disconnect.onclick = () => { state.connected = !state.connected; disconnect.setAttribute("aria-pressed", String(!state.connected)); }; section.append(disconnect);
  const scroll = document.createElement("button"); scroll.textContent = "Pad scroll down";
  scroll.onclick = () => { axes[3] = .9; window.setTimeout(() => { axes[3] = 0; }, 100); }; section.append(scroll);
  panel.append(style, section); document.body.append(host);
  for (const [index, name] of [[13, "Down"], [12, "Up"]] as const) {
    const hold = document.createElement("button"); hold.textContent = `Pad hold ${name}`;
    hold.onclick = () => { const down = !buttons[index].pressed; buttons[index] = { pressed: down, touched: down, value: down ? 1 : 0 }; hold.setAttribute("aria-pressed", String(down)); }; section.append(hold);
  }
  for (const [index, name, last] of [[13, "last", true], [12, "first", false]] as const) {
    const navigate = document.createElement("button"); navigate.textContent = `Pad to ${name} track`;
    navigate.onclick = () => {
      const tracks = document.querySelectorAll(".track-title"), target = last ? tracks[tracks.length - 1] : tracks[0];
      if (!target || target === document.activeElement) return;
      buttons[index] = { pressed: true, touched: true, value: 1 };
      const release = (event: FocusEvent) => { if (event.target !== target) return;
        buttons[index] = { pressed: false, touched: false, value: 0 }; document.removeEventListener("focusin", release); };
      document.addEventListener("focusin", release);
    }; section.append(navigate);
  }
  return state;
}
