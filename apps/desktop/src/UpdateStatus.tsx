import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { check } from "@tauri-apps/plugin-updater";
import { call, native } from "./api";
import { createUpdateController, updateInterval } from "./updateController";
import "./updates.css";

const enabled = native && (!import.meta.env.DEV || new URLSearchParams(location.search).has("updates"));
const controller = createUpdateController({
  check: async () => {
    const update = await check({ timeout: 15000 });
    return update && { version: update.version, download: progress => update.download(progress, { timeout: 300000 }),
      install: () => update.install({ restartAfterInstall: true }), close: () => update.close() };
  },
  prepare: () => call("prepare_update"),
  cancel: () => call("cancel_update"),
});

export default function UpdateStatus() {
  const [state, setState] = useState(controller.snapshot);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = controller.subscribe(setState);
    void controller.check();
    const timer = window.setInterval(() => void controller.check(), updateInterval);
    const onFocus = () => void controller.check();
    window.addEventListener("focus", onFocus);
    return () => { unsubscribe(); window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);
  if (!enabled) return null;
  const installing = state.phase === "downloading" || state.phase === "installing" || state.phase === "installed";
  return <section className="client-updates" aria-label="App updates">
    {state.version && <p className="update-version">Spatial {state.version} {state.phase === "installed" ? "installed" : "available"}</p>}
    {state.message && <p className="update-message" role="status">{state.message}</p>}
    {state.version ? <button className="update-button" disabled={installing || state.phase === "checking"} onClick={() => void controller.install()}>
      {installing ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}
      {state.phase === "downloading" ? `Downloading${state.percent === undefined ? "…" : ` ${state.percent}%`}`
        : state.phase === "installing" ? "Installing…" : state.phase === "installed" ? "Restarting…" : "Update and restart"}
    </button> : <button className="update-button" disabled={state.phase === "checking"} onClick={() => void controller.check(true)}>
      {state.phase === "checking" ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
      {state.phase === "checking" ? "Checking…" : state.phase === "current" ? "You're up to date" : "Check for updates"}
    </button>}
    {state.phase === "downloading" && state.percent !== undefined && <progress aria-label="Update download" value={state.percent} max={100} />}
  </section>;
}
