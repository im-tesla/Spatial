import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const native = isTauri();
let previewToken = "";

// The Vite-only preview reads the real local catalog; it never plays browser PCM.
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  if (!import.meta.env.DEV) throw new Error("Open Spatial in the desktop application");
  if (command === "disconnect_server") { previewToken = ""; return undefined as T; }
  if (command === "connect_server") {
    const address = String(args.address).replace(/\/$/, "");
    if (!/^http:\/\/(127\.0\.0\.1|localhost):8787$/.test(address)) throw new Error("Browser preview connects to the local development server on port 8787");
    previewToken = String(args.token);
  }
  if (command === "connect_server" || command === "get_library" || command === "get_artwork") {
    const path = command === "get_artwork" ? `artwork/${encodeURIComponent(String(args.id))}` : "library";
    const response = await fetch(`/preview/api/${path}`, { headers: { Authorization: `Bearer ${previewToken}` } });
    if (!response.ok) throw new Error(response.status === 401 ? "The server token is incorrect" : "Cannot reach the local Spatial server");
    if (command === "get_artwork") return await new Promise<string>((resolve, reject) => {
      response.blob().then(blob => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); }).catch(reject);
    }) as T;
    return response.json();
  }
  if (command === "audio_devices") return [] as T;
  if (command === "playback_status") return { active: false, paused: false, ended: false, position: 0, duration: 0, passthrough: false, output_format: "", output_driver: "", error: null, track_id: null } as T;
  throw new Error("HDMI playback is available in the Windows desktop application");
}

export async function onEvent<T>(event: string, handler: (value: T) => void): Promise<() => void> {
  if (native) return listen<T>(event, message => handler(message.payload));
  if (event === "library-changed") {
    const interval = window.setInterval(() => handler(undefined as T), 3000);
    return () => window.clearInterval(interval);
  }
  return () => {};
}

