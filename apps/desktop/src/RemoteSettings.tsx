import { useEffect, useState } from "react";
import { Copy, RefreshCw, Smartphone } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { call, native } from "./api";
import NetworkAddressPicker from "./NetworkAddressPicker";

interface RemoteSettingsState {
  enabled: boolean; address: string | null; url: string | null; qr_svg: string | null;
  expires_in: number; phones: number; interfaces: { address: string; name: string }[];
}

export default function RemoteSettings() {
  const [settings, setSettings] = useState<RemoteSettingsState | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!native) return;
    let active = true;
    const refresh = () => call<RemoteSettingsState>("remote_settings").then(value => {
      if (active) { setSettings(value); setAddress(previous => previous || value.address || value.interfaces[0]?.address || ""); }
    }).catch(() => { if (active) setError("Remote settings couldn't be loaded."); });
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  async function configure(command: string) {
    setBusy(true); setError(""); setCopied(false);
    try { setSettings(await call<RemoteSettingsState>(command, command === "start_remote" ? { address } : {})); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <section className="preference-section phone-remote" aria-labelledby="remote-heading">
    <div className="preference-row"><div><h3 id="remote-heading">Phone remote</h3><p>Control playback from your phone.</p></div>
      <button type="button" className={`preference-switch ${settings?.enabled ? "enabled" : ""}`} role="switch" aria-checked={!!settings?.enabled}
        aria-label="Enable phone remote" disabled={!native || !settings || busy || (!settings.enabled && !address)}
        onClick={() => void configure(settings?.enabled ? "stop_remote" : "start_remote")}><span /></button>
    </div>
    {!native ? <p className="preference-note">Available in the Windows desktop app.</p> : settings && <>
      {!settings.enabled && (settings.interfaces.length ? <NetworkAddressPicker interfaces={settings.interfaces}
        value={address} disabled={busy} onChange={setAddress} /> : <p className="preference-note">Connect this PC to Wi-Fi or Ethernet to use the remote.</p>)}
      {settings.enabled && <div className="remote-pairing">
        {settings.qr_svg ? <img className="remote-qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(settings.qr_svg)}`} alt="Scan to pair your phone with Spatial" /> :
          <div className="remote-qr remote-qr-empty"><Smartphone size={35} /><span>{settings.phones ? "Phone paired" : "Code expired"}</span></div>}
        <div className="remote-instructions"><strong>Connect your phone</strong><p>Open your phone's camera and scan the code. Keep your phone and PC on the same network.</p>
          <span className="remote-address">{settings.address}:8790</span>
          <span className="remote-pair-status">{settings.phones ? `${settings.phones} ${settings.phones === 1 ? "phone" : "phones"} connected` : "Waiting for your phone"}{settings.expires_in > 0 && ` · ${Math.ceil(settings.expires_in / 60)} min left`}</span>
          <div className="remote-pair-actions"><button className="secondary" disabled={busy} onClick={() => void configure("renew_remote_pairing")}><RefreshCw size={13} /> New code</button>
            {settings.url && <button className="secondary" onClick={() => { void writeText(settings.url!).then(() => setCopied(true)).catch(() => setError("Couldn't copy the pairing link.")); }}><Copy size={13} /> {copied ? "Copied" : "Copy link"}</button>}
          </div>
        </div>
      </div>}
      {settings.enabled && <p className="preference-note">If Windows asks, allow Spatial on private networks. Turning this off disconnects all phones.</p>}
    </>}
    {error && <p className="form-error" role="status">{error}</p>}
  </section>;
}
