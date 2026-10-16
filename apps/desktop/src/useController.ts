import { useEffect, useRef, useState } from "react";
import { call, native } from "./api";
import { ControllerSampler, loadControllerProfile, saveControllerProfile } from "./controller";
import type { ControllerAction, ControllerProfile } from "./controller";
import { controllerNavigation } from "./controllerNavigation";
import "./controller.css";

export function useController(onAction: (action: ControllerAction) => void | Promise<void>) {
  const [profile, setProfile] = useState(loadControllerProfile);
  const [status, setStatus] = useState("");
  const callback = useRef(onAction); callback.current = onAction;
  const settings = useRef(profile); settings.current = profile;
  const sampler = useRef(new ControllerSampler());
  useEffect(() => { sampler.current.setBindings(profile.bindings); sampler.current.suspend(); }, [profile]);
  useEffect(() => {
    let cancelled = false, running = false, pending = false;
    const clear = () => { sampler.current.suspend(); delete document.documentElement.dataset.controller; };
    const trusted = (event: Event) => { if (event.isTrusted) delete document.documentElement.dataset.controller; };
    const foreground = () => native ? call<boolean>("controller_foreground") : Promise.resolve(document.hasFocus() && !document.hidden);
    const tick = async () => {
      if (cancelled || pending || !settings.current.enabled) return;
      pending = true;
      const applied = settings.current;
      try {
        if (typeof navigator.getGamepads !== "function") { setStatus("Controller input is unavailable in this app's renderer."); clear(); return; }
        const pads = [...navigator.getGamepads()];
        const connected = pads.filter(pad => pad?.connected);
        const description = connected.some(pad => pad?.mapping === "standard") ? "Controller connected"
          : connected.length ? "This controller has no standard mapping." : "Connect a controller to use it here.";
        setStatus(previous => previous === description ? previous : description);
        if (!connected.length || !await foreground() || cancelled) { clear(); return; }
        const actions = sampler.current.sample(pads, performance.now());
        if (!actions.length) return;
        // Fresh native ownership check before every batch, including synthetic UI clicks.
        if (!await foreground() || cancelled || settings.current !== applied) { clear(); return; }
        running = true;
        document.documentElement.dataset.controller = "true";
        for (const action of actions) {
          if (cancelled || !settings.current.enabled) break;
          if (!controllerNavigation(action)) await callback.current(action);
        }
      } catch { setStatus("Controller input couldn't be read. Reconnect the controller and try again."); clear(); }
      finally { running = false; pending = false; }
    };
    const timer = window.setInterval(() => void tick(), 32);
    const blur = () => { if (!running) clear(); };
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", clear);
    document.addEventListener("pointerdown", trusted, true); document.addEventListener("keydown", trusted, true);
    return () => { cancelled = true; window.clearInterval(timer); clear(); window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", clear); document.removeEventListener("pointerdown", trusted, true); document.removeEventListener("keydown", trusted, true); };
  }, []);
  function save(next: ControllerProfile) { saveControllerProfile(next); sampler.current.setBindings(next.bindings); sampler.current.suspend(); setProfile(next); }
  return { profile, status, save };
}
