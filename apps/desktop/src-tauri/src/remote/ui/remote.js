import { formatTime, trackEntries, transportAvailability } from "/model.js";

// Icons follow Lucide's SVG geometry (ISC license, https://lucide.dev/license).
const paths = {
  play: '<path d="m9 5 12 7-12 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="5"/>',
  next: '<path d="m5 5 10 7-10 7z" fill="currentColor" stroke="none"/><path d="M19 5v14"/>',
  previous: '<path d="m19 5-10 7 10 7z" fill="currentColor" stroke="none"/><path d="M5 5v14"/>',
  shuffle: '<path d="m18 14 4 4-4 4m0-20 4 4-4 4M2 18h2c6 0 8-12 14-12h4M2 6h2c2 0 3 1 4 3m7 6c1 2 3 3 5 3h2"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="m7 7 2 2m6 6 2 2"/>',
  albums: '<rect x="5" y="5" width="16" height="16" rx="2"/><path d="M16 1H3a2 2 0 0 0-2 2v13"/><circle cx="13" cy="13" r="4"/><circle cx="13" cy="13" r="1"/>',
  tracks: '<path d="M9 6h13M9 12h13M9 18h13M2 6h1M2 12h1M2 18h1"/>',
  queue: '<path d="M4 5h16M4 10h16M4 15h7m4-1 6 4-6 4z"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
};
function icon(name) {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.disc}</svg>`;
  return wrapper.firstElementChild;
}
const $ = id => document.getElementById(id);
for (const id of ["shuffle", "previous", "next", "repeat"]) $(id).append(icon(id));
$("toggle_pause").append(icon("play")); $("favorite").append(icon("heart"));
$("back").append(icon("back")); $("favorites-filter").append(icon("heart")); $("search-icon").append(icon("search"));
document.querySelectorAll("[data-icon]").forEach(node => node.append(icon(node.dataset.icon)));

let snapshot = null, library = null, revision = null, view = "playing", albumId = null;
let favoritesOnly = false, busy = false, paired = false, online = false, seeking = false, refreshing = false, renderKey = "";
let artworkId = undefined;
let progressAt = performance.now(), optimisticPosition = null;
let connectionNotice = false;
const themeProperties = new Set(["--base", "--surface", "--sidebar", "--player", "--panel", "--wash", "--raised",
  "--active-bg", "--line", "--strong-line", "--accent", "--accent-hover", "--accent-ink", "--text",
  "--secondary-text", "--muted", "--dim", "--lyric-past"]);
function updateTheme(theme) {
  for (const [key, value] of Object.entries(theme || {})) {
    if (themeProperties.has(key) && typeof value === "string" && CSS.supports("color", value)) {
      document.documentElement.style.setProperty(key, value);
    }
  }
  // The phone's browser chrome should follow the album too.
  if (typeof theme?.["--base"] === "string" && CSS.supports("color", theme["--base"])) {
    document.querySelector('meta[name="theme-color"]').content = theme["--base"];
  }
}
function notice(message = "", connection = false) { connectionNotice = connection; $("notice").textContent = message; $("notice").hidden = !message; }
function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function cover(id, small = false) {
  const element = node("span", small ? "small-cover" : "album-cover"); element.append(icon("disc"));
  if (id) { const image = new Image(); image.src = `/api/artwork/${encodeURIComponent(id)}`;
    image.alt = ""; image.loading = "lazy";
    image.addEventListener("error", () => image.remove()); element.append(image); }
  return element;
}
async function api(path, body) {
  const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000) }).catch(() => { throw new Error("Couldn't reach Spatial. Keep the desktop app open and both devices on the same network."); });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = new Error(result.error || "Couldn't reach Spatial. Keep the desktop app open.");
    if (response.status === 401) paired = false;
    throw error;
  }
  return response.json();
}
async function send(action) {
  if (busy || !paired || !online) return;
  busy = true;
  if (action.action === "seek") optimisticPosition = action.seconds;
  updatePlayer();
  try { await api("/api/command", action); notice(); await refresh(); }
  catch (error) { notice(error.message || "Couldn't reach Spatial."); }
  finally { busy = false; optimisticPosition = null; updatePlayer(); }
}
for (const action of ["shuffle", "previous", "next", "repeat", "toggle_pause"]) {
  $(action).addEventListener("click", () => void send({ action }));
}
$("favorite").addEventListener("click", () => snapshot?.current && void send({ action: "favorite", id: snapshot.current.id }));
$("seek").addEventListener("input", () => { seeking = true; $("position").textContent = formatTime(Number($("seek").value));
  $("seek").style.setProperty("--progress", `${Number($("seek").value) / Number($("seek").max) * 100}%`); });
$("seek").addEventListener("change", () => { const seconds = Number($("seek").value); seeking = false; void send({ action: "seek", seconds }); });
$("seek").addEventListener("pointercancel", () => { seeking = false; updatePlayer(); });

function updateProgress() {
  if (!snapshot || seeking) return;
  const status = snapshot.status;
  const elapsed = status.active && !status.paused && !snapshot.starting && online ? Math.min(1.5, (performance.now() - progressAt) / 1000) : 0;
  const position = optimisticPosition ?? Math.min(status.duration, status.position + elapsed);
  $("seek").max = String(Math.max(1, status.duration)); $("seek").value = String(position);
  $("seek").style.setProperty("--progress", `${Math.min(100, position / Math.max(1, status.duration) * 100)}%`);
  const label = formatTime(position);
  if ($("position").textContent !== label) $("position").textContent = label;
}

function updatePlayer() {
  if (!snapshot) return;
  const track = snapshot.current, status = snapshot.status, available = transportAvailability(snapshot);
  $("song-title").textContent = track?.title || "Nothing playing";
  $("song-artist").textContent = track?.artist || "Choose an album or track.";
  $("song-album").textContent = track?.album || "";
  if (artworkId !== (track?.artwork_id || null)) { artworkId = track?.artwork_id || null;
    $("hero-cover").replaceChildren(cover(artworkId)); $("mini-cover").replaceChildren(cover(artworkId, true)); }
  updateTheme(snapshot.theme);
  $("favorite").classList.toggle("active", !!track && snapshot.favorite_ids.includes(track.id));
  $("favorite").setAttribute("aria-pressed", String(!!track && snapshot.favorite_ids.includes(track.id)));
  $("favorite").disabled = !track || busy || !paired || !online;
  $("toggle_pause").replaceChildren(icon(status.active && !status.paused ? "pause" : "play"));
  $("toggle_pause").setAttribute("aria-label", status.active && !status.paused ? "Pause" : "Play");
  $("toggle_pause").disabled = !available.play || busy || !paired || !online;
  $("previous").disabled = !available.previous || busy || !paired || !online;
  $("next").disabled = !available.next || busy || !paired || !online;
  $("seek").disabled = !available.seek || busy || !paired || !online;
  updateProgress();
  $("duration").textContent = formatTime(status.duration || track?.duration || 0);
  $("shuffle").classList.toggle("active", snapshot.shuffle); $("shuffle").setAttribute("aria-pressed", String(snapshot.shuffle));
  $("repeat").classList.toggle("active", snapshot.repeat !== "off"); $("repeat").classList.toggle("repeat-one", snapshot.repeat === "one");
  $("repeat").setAttribute("aria-label", `Repeat: ${snapshot.repeat === "one" ? "Current track" : snapshot.repeat === "all" ? "Entire queue" : "Off"}`);
  $("shuffle").disabled = $("repeat").disabled = busy || !paired || !online;
  $("output-note").hidden = snapshot.ready;
  $("mini-player").hidden = !track || view === "playing";
  $("mini-title").textContent = track?.title || ""; $("mini-artist").textContent = track?.artist || "";
  $("mini-status").replaceChildren(icon(status.active && !status.paused ? "pause" : "play"));
}

function navigate(nextView, selectedAlbum = null) {
  view = nextView; albumId = selectedAlbum; $("search").value = ""; renderKey = "";
  $("playing").hidden = view !== "playing"; $("collection").hidden = view === "playing";
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  updatePlayer(); renderCollection(); window.scrollTo({ top: 0, behavior: "instant" });
}
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => navigate(button.dataset.view)));
$("mini-player").addEventListener("click", () => navigate("playing"));
$("back").addEventListener("click", () => navigate("albums"));
$("search").addEventListener("input", () => { renderKey = ""; renderCollection(); });
$("favorites-filter").addEventListener("click", () => { favoritesOnly = !favoritesOnly; renderKey = ""; renderCollection(); });

function renderCollection() {
  if (!library || !snapshot || view === "playing") return;
  const key = JSON.stringify([revision, view, albumId, $("search").value, favoritesOnly, snapshot.current?.id, snapshot.queue_index, snapshot.queue_ids, snapshot.favorite_ids]);
  if (renderKey === key) return; renderKey = key;
  const album = library.albums.find(item => item.id === albumId);
  $("back").hidden = !album; $("collection-title").textContent = album ? album.title : view === "queue" ? "Play queue" : view === "tracks" ? favoritesOnly ? "Favorites" : "All tracks" : "Albums";
  $("favorites-filter").hidden = view !== "tracks"; $("favorites-filter").classList.toggle("active", favoritesOnly);
  $("favorites-filter").setAttribute("aria-pressed", String(favoritesOnly));
  $("album-detail").hidden = !album; $("album-detail").replaceChildren();
  if (album) {
    $("album-detail").append(cover(album.artwork_id, true), node("p", "album-artist", album.artist));
    const play = node("button", "primary", "Play album"); play.prepend(icon("play"));
    play.addEventListener("click", () => { const first = trackEntries(library, snapshot, view, albumId, "", false)[0];
      if (first) void send({ action: "play", id: first.track.id, album_id: albumId }); });
    $("album-detail").append(play);
  }
  const items = $("items"); items.replaceChildren(); items.className = view === "albums" && !album ? "album-grid" : "track-list";
  if (view === "albums" && !album) {
    const text = $("search").value.trim().toLocaleLowerCase();
    const albums = library.albums.filter(item => `${item.title} ${item.artist}`.toLocaleLowerCase().includes(text))
      .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
    for (const item of albums) {
      const button = node("button", "album-card"); button.append(cover(item.artwork_id), node("strong", "", item.title), node("span", "", item.artist));
      button.addEventListener("click", () => navigate("albums", item.id)); items.append(button);
    }
  } else {
    for (const { track, index } of trackEntries(library, snapshot, view, albumId, $("search").value, view === "tracks" && favoritesOnly)) {
      const button = node("button", "track-row");
      const active = snapshot.current?.id === track.id && (view !== "queue" || index === snapshot.queue_index);
      button.classList.toggle("current", active);
      button.append(cover(track.artwork_id, true));
      const label = node("span", "track-label"); label.append(node("strong", "", track.title), node("span", "", track.artist));
      button.append(label, node("span", "track-time", formatTime(track.duration)));
      button.addEventListener("click", () => void send(view === "queue" ? { action: "queue", index } : {
        action: "play", id: track.id, album_id: albumId, query: $("search").value,
        favorites_only: view === "tracks" && favoritesOnly,
      }));
      items.append(button);
    }
  }
  if (!items.children.length) items.append(node("p", "empty-state", view === "queue" ? "Play an album or track to build your queue." : "No matches. Try another search."));
}

async function refresh() {
  if (refreshing || !paired) return;
  refreshing = true;
  try {
    const next = await api("/api/state");
    if (!snapshot || next.status.track_id !== snapshot.status.track_id || next.status.position !== snapshot.status.position ||
        next.status.active !== snapshot.status.active || next.status.paused !== snapshot.status.paused) progressAt = performance.now();
    snapshot = next; online = true;
    if (revision !== snapshot.revision || !library) { library = await api("/api/library"); revision = snapshot.revision; renderKey = ""; }
    updatePlayer(); renderCollection();
  } catch (error) { online = false; updatePlayer(); throw error; }
  finally { refreshing = false; }
}
async function connect() {
  const pairingToken = new URLSearchParams(location.hash.slice(1)).get("pair");
  // Pairing secrets never reach the HTTP URL, server logs or referrers.
  if (location.hash) history.replaceState(null, "", location.pathname);
  try { if (pairingToken) await api("/api/pair", { token: pairingToken }); paired = true; await refresh(); notice(); }
  catch (error) { notice(error.message || "Couldn't reach Spatial. Scan a QR code in the desktop app to connect."); }
}
void connect();
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("pair")) void connect();
});
setInterval(() => { if (!document.hidden && paired && !busy) void refresh().then(() => { if (connectionNotice) notice(); }).catch(error => { notice(error.message, true); updatePlayer(); }); }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && paired) void refresh().catch(error => notice(error.message)); });
setInterval(() => { if (!document.hidden) updateProgress(); }, 100);
