import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { native } from "./api";

export function useListeningMode() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const desired = useRef(false);
  const entering = useRef(false);
  const settled = useRef(false);
  const restore = useRef<(() => Promise<void>) | null>(null);

  const close = useCallback(() => {
    desired.current = false; settled.current = false; setOpen(false); setError("");
    const reset = restore.current; restore.current = null;
    if (reset) void reset().catch(() => {});
  }, []);

  const enter = useCallback(() => {
    if (entering.current || desired.current) return;
    desired.current = true; entering.current = true; setOpen(true); setError("");
    // Browser fullscreen must be requested in the original click's user activation.
    const request = native ? (async () => {
      const window = getCurrentWindow();
      const previous = await window.isFullscreen();
      if (!desired.current) return;
      if (!previous) {
        await window.setFullscreen(true);
        const reset = () => window.setFullscreen(false);
        if (desired.current) restore.current = reset; else await reset();
      }
    })() : (document.fullscreenElement ? Promise.resolve() : (typeof document.documentElement.requestFullscreen === "function"
      ? document.documentElement.requestFullscreen() : Promise.reject(new Error("Fullscreen unavailable"))).then(async () => {
      const reset = async () => { if (document.fullscreenElement) await document.exitFullscreen(); };
      if (desired.current) restore.current = reset; else await reset();
    }));
    void request.catch(() => { if (desired.current) setError("Fullscreen is unavailable. You can continue listening in this view."); })
      .finally(() => { entering.current = false; settled.current = desired.current; });
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const exited = () => {
      restore.current = null; desired.current = false; settled.current = false; setOpen(false); setError("");
    };
    const changed = () => {
      if (!settled.current || !restore.current) return;
      if (native) void getCurrentWindow().isFullscreen().then(full => { if (!cancelled && settled.current && restore.current && !full) exited(); }).catch(() => {});
      else if (!document.fullscreenElement) exited();
    };
    if (native) void getCurrentWindow().onResized(changed).then(fn => { if (cancelled) fn(); else unlisten = fn; }).catch(() => {});
    else document.addEventListener("fullscreenchange", changed);
    return () => { cancelled = true; unlisten?.(); document.removeEventListener("fullscreenchange", changed); };
  }, [open]);

  useEffect(() => () => {
    desired.current = false;
    const reset = restore.current; restore.current = null;
    if (reset) void reset().catch(() => {});
  }, []);
  return { open, error, enter, close };
}
