// Development-only fixture: production App, mocked native IPC, no audio or network requests.
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Library, PlaybackStatus, Track } from "../src/types";
import appPackage from "../package.json";
import "../src/styles.css";

Object.assign(window, { isTauri: true });
// Simulate the OS preference without changing the user's Windows settings.
if (new URLSearchParams(location.search).get("motion") === "reduced") {
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = matchMedia(query);
    if (query.includes("prefers-reduced-motion")) Object.defineProperty(result, "matches", { value: true });
    return result;
  };
}
const albums = [
  { id: "fixture-night", title: "Night Letters", artist: "Spatial", date: "2026", track_count: 3, duration: 60, atmos: true, artwork_id: "fixture-purple" },
  { id: "fixture-sun", title: "Sun Room", artist: "Spatial", date: "2025", track_count: 1, duration: 20, atmos: true, artwork_id: "fixture-orange" },
];
const showcase = new URLSearchParams(location.search).has("showcase");
const friendLibrary = new URLSearchParams(location.search).get("library") === "friend";
if (showcase) albums.push(
  { id: "fixture-tidal", title: "Tidal Forms", artist: "Lowlight", date: "2026", track_count: 3, duration: 60, atmos: true, artwork_id: "fixture-blue" },
  { id: "fixture-afterglow", title: "Afterglow", artist: "Mira Vale", date: "2025", track_count: 3, duration: 60, atmos: true, artwork_id: "fixture-rose" },
);
const tracks: Track[] = ["A quiet room", "A little space", "Every note comes home", "Morning light"].map((title, index) => {
  const album = albums[index === 3 ? 1 : 0];
  return { id: `fixture-track-${index}`, album_id: album.id, title, artist: "Spatial", album_artist: "Spatial", album: album.title,
    date: album.date, disc_number: 1, track_number: index === 3 ? 1 : index + 1, duration: 20, codec: "eac3", profile: "", atmos: true,
    sample_rate: 48000, channels: 6, bitrate: 768000, artwork_id: album.artwork_id };
});
if (showcase) {
  for (const album of albums.slice(2)) {
    ["First light", "Between the waves", "Still here"].forEach((title, index) => tracks.push({
      ...tracks[0], id: `${album.id}-track-${index}`, album_id: album.id, title, artist: album.artist,
      album_artist: album.artist, album: album.title, date: album.date, track_number: index + 1, artwork_id: album.artwork_id,
    }));
  }
}
// Opt-in collection fixture includes title matches and an artist-only non-match.
if (new URLSearchParams(location.search).has("mixes")) tracks.push(
  { ...tracks[0], id: "fixture-mix-one", title: "A quiet room (Mixed by Tesla)" },
  { ...tracks[1], id: "fixture-mix-two", title: "A little space — MIXED BY TESLA", artwork_id: "fixture-blue" },
  { ...tracks[2], id: "fixture-not-a-mix", title: "Every note comes home", artist: "Mixed by Tesla" },
);
if (friendLibrary) {
  for (const album of albums) album.id = `friend-${album.id}`;
  for (const track of tracks) { track.id = `friend-${track.id}`; track.album_id = `friend-${track.album_id}`; }
}
const library: Library = { revision: 1, albums, tracks };
const connectionScenario = new URLSearchParams(location.search).get("connection");
const updateScenario = new URLSearchParams(location.search).get("updates");
let restoreCalls = 0;
const covers = new Map<string, string>();
for (const [id, color, dark] of [["fixture-purple", "#75459b", "#161323"], ["fixture-orange", "#b56937", "#292025"],
  ["fixture-blue", "#407788", "#101e2b"], ["fixture-rose", "#a44b6c", "#251629"]]) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  if (showcase) {
    const gradient = context.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, color); gradient.addColorStop(1, dark);
    context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
    const glow = context.createRadialGradient(185, 72, 0, 160, 96, 190);
    glow.addColorStop(0, "#ffffff35"); glow.addColorStop(1, "#ffffff00");
    context.fillStyle = glow; context.fillRect(0, 0, 256, 256);
    context.strokeStyle = "#ffffff35"; context.lineWidth = 1;
    for (let line = 0; line < 18; line++) {
      context.beginPath();
      context.moveTo(-20, 32 + line * 13);
      context.bezierCurveTo(85, 180 + line * 3, 155, -70 + line * 17, 280, 70 + line * 14);
      context.stroke();
    }
  } else { context.fillStyle = color; context.fillRect(0, 0, 256, 256); }
  context.strokeStyle = "#ffffff50"; context.lineWidth = 1;
  for (let size = 40; size < 230; size += 24) { context.beginPath(); context.arc(128,128,size/2,0,Math.PI*2); context.stroke(); }
  covers.set(id, canvas.toDataURL());
}
let status: PlaybackStatus = { track_id: null, active: false, paused: false, ended: false, position: 0, duration: 0,
  passthrough: true, output_format: "spdif-eac3", output_driver: "wasapi", error: null };
mockIPC((command, args) => {
  const payload = args && !Array.isArray(args) && !(args instanceof ArrayBuffer) && !(args instanceof Uint8Array) ? args : {};
  if (command === "plugin:updater|check") {
    if (updateScenario === "offline") throw new Error("Simulated offline release feed");
    return updateScenario === "current" ? null : { rid: 99, currentVersion: appPackage.version, version: "0.1.4", rawJson: {} };
  }
  if (command === "plugin:updater|download") {
    const channel = payload.onEvent;
    const callbackId = channel && typeof channel === "object" && "id" in channel ? Number(channel.id)
      : Number(String(channel).replace("__CHANNEL__:", ""));
    let messageIndex = 0;
    const send = (message: unknown) => (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, message: unknown) => void } }).__TAURI_INTERNALS__.runCallback(callbackId, { message, index: messageIndex++ });
    send({ event: "Started", data: { contentLength: 100 } });
    send({ event: "Progress", data: { chunkLength: 50 } });
    return new Promise((resolve, reject) => window.setTimeout(() => {
      if (updateScenario === "bad-signature") { reject(new Error("Simulated invalid signature")); return; }
      send({ event: "Progress", data: { chunkLength: 50 } }); send({ event: "Finished" }); resolve(100);
    }, 900));
  }
  if (command === "prepare_update") { status = { ...status, active: false }; console.info("Fixture update prepared after download"); return; }
  if (command === "cancel_update") { console.info("Fixture update failure unlocked playback"); return; }
  if (command === "plugin:updater|install") throw new Error("Simulated installer failure; no software is installed");
  if (command === "plugin:resources|close") return;
  if (command === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(payload.text));
  if (command === "restore_server") {
    restoreCalls++;
    console.info(`Fixture restore request ${restoreCalls}`);
    if (!connectionScenario) return null;
    const offline = connectionScenario === "invalid" || (connectionScenario === "offline" && restoreCalls === 1);
    return { address: friendLibrary ? "http://friend-library.example:8787" : "http://127.0.0.1:8787", library: offline ? null : library,
      error: offline ? connectionScenario === "invalid" ? "The server rejected your access token." : "Cannot reach Spatial. Check the server address, service and firewall." : null };
  }
  if (command === "get_library" || command === "connect_server") return library;
  if (command === "get_artwork") return covers.get(String(payload.id));
  if (command === "audio_devices") return [{ name: "fixture-hdmi", description: "Simulated HDMI endpoint" }];
  if (command === "playback_status") return { ...status };
  if (command === "play_track") status = { ...status, track_id: String(payload.id), active: true, paused: false, position: 4,
    duration: tracks.find(track => track.id === payload.id)?.duration || 20 };
  if (command === "seek") status = { ...status, position: Number(payload.seconds) };
  if (command === "toggle_pause") status = { ...status, paused: !status.paused };
  if (command === "stop_playback" || command === "disconnect_server") status = { ...status, active: false };
}, { shouldMockEvents: true });
const realFetch = window.fetch;
window.fetch = async (input, options) => {
  if (!String(input).startsWith("https://lrclib.net/api/get?")) return realFetch(input, options);
  return Response.json({ id: 987654322, duration: 20, instrumental: false, plainLyrics: null,
    syncedLyrics: "[00:01.00] A quiet room\n[00:04.00] The lights turn green\n[00:08.00] A little space to breathe\n[00:12.00] Every note comes home\n[00:16.00] And the room opens up\n[00:19.00]" });
};
const { default: App } = await import("../src/App");
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
