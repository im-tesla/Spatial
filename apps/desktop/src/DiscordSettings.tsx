import { useCallback, useEffect, useState } from "react";
import { call, native } from "./api";
import { loadDiscordEnabled, saveDiscordEnabled } from "./discordPreferences";
import "./settings.css";

type Configuration = { configured: boolean; enabled: boolean };
export function useDiscordPreferences() {
  const [enabled, setEnabled] = useState(() => native && loadDiscordEnabled());
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(native);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!native) return;
    let active = true;
    void call<Configuration>("configure_discord", { enabled: loadDiscordEnabled() })
      .then(configuration => { if (active) { setConfigured(configuration.configured); setEnabled(configuration.enabled); } })
      .catch(() => { if (active) setError("Discord settings couldn't be loaded."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  const toggle = useCallback(async () => {
    if (busy || !configured) return;
    setBusy(true); setError("");
    try {
      const configuration = await call<Configuration>("configure_discord", { enabled: !enabled });
      setEnabled(configuration.enabled); saveDiscordEnabled(configuration.enabled);
    } catch { setError("Discord settings couldn't be saved. Try again."); }
    finally { setBusy(false); }
  }, [enabled, busy, configured]);
  return { enabled, configured, busy, error, toggle };
}
export default function DiscordSettings({ preferences }: { preferences: ReturnType<typeof useDiscordPreferences> }) {
  return <section className="preference-section" aria-labelledby="discord-heading">
    <div className="preference-row"><div><h3 id="discord-heading">Discord activity</h3><p>Share the track and artist while listening.</p></div>
      <button type="button" className={`preference-switch ${preferences.enabled ? "enabled" : ""}`} role="switch"
        aria-checked={preferences.enabled} aria-label="Share listening activity on Discord" disabled={!preferences.configured || preferences.busy}
        onClick={() => void preferences.toggle()}><span /></button>
    </div>
    {!preferences.configured && !preferences.busy && <p className="preference-note">{native ? "Discord integration is not available in this build." : "Available in the Windows desktop app."}</p>}
    {preferences.error && <p className="form-error" role="status">{preferences.error}</p>}
  </section>;
}
