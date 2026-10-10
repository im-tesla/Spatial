import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { DialogTransition, ease, LyricsSlot, PageTransition, spring } from "./motion";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Disc3, Headphones, Heart, Layers3, LibraryBig,
  ListMusic, LoaderCircle, Mic2, Pause, Play, Repeat, Repeat1, Search, Settings2, Shuffle, SkipBack,
  SkipForward, Speaker, Volume2, Waves, X } from "lucide-react";
import { call, native, onEvent } from "./api";
import { emptyFavorites, loadFavorites, saveFavorites } from "./favorites";
import type { Favorites } from "./favorites";
import CollectionTools from "./CollectionTools";
import UpdateStatus from "./UpdateStatus";
import DiscordSettings, { useDiscordPreferences } from "./DiscordSettings";
import RemoteSettings from "./RemoteSettings";
import { remotePlaySelection } from "./remoteControl";
import type { RemoteCommand } from "./remoteControl";
import { getArtwork } from "./artwork";
import LyricsSidebar from "./LyricsSidebar";
import { clampLyricsWidth, loadLyricsWidth, maxLyricsWidth } from "./lyricsLayout";
import { useArtworkTheme } from "./useArtworkTheme";
import type { Album, AudioDevice, Library, PlaybackStatus, RememberedConnection, Track } from "./types";

const emptyStatus: PlaybackStatus = { track_id: null, active: false, paused: false, ended: false,
  position: 0, duration: 0, passthrough: false, output_format: "", output_driver: "", error: null };
const time = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}`;
const year = (date: string) => date.match(/^\d{4}/)?.[0] || "";

function Cover({ id, title, className = "" }: { id: string | null; title: string; className?: string }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    let active = true;
    if (id) {
      getArtwork(id).then(async url => {
        const decoded = new Image(); decoded.src = url; await decoded.decode();
        if (active) setImage({ id, url });
      }).catch(() => { if (active) setImage(null); });
    } else setImage(null);
    return () => { active = false; };
  }, [id]);
  return <div className={`cover ${className}`}><Disc3 aria-hidden="true" /><AnimatePresence initial={false}>
    {image && <motion.img key={image.id} src={image.url} alt={`${title} artwork`}
      initial={{ opacity: 0, scale: reduced ? 1 : 1.025 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : .4, ease }} />}
  </AnimatePresence></div>;
}

function AtmosBadge({ small = false }: { small?: boolean }) {
  return <span className={`atmos-badge ${small ? "small" : ""}`}><Layers3 size={small ? 10 : 13} /> DOLBY ATMOS</span>;
}

function FavoriteButton({ active, label, onClick, disabled = false }: { active: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  const reduced = useReducedMotion();
  return <motion.button className={`icon-button favorite-button ${active ? "is-favorite" : ""}`} aria-pressed={active}
    whileTap={disabled || reduced ? undefined : { scale: .88 }}
    aria-label={`${active ? "Remove" : "Add"} ${label} ${active ? "from" : "to"} favorites`} onClick={onClick} disabled={disabled}>
    <motion.span className="favorite-glyph" initial={false} animate={{ scale: active && !reduced ? [1, 1.22, 1] : 1 }}
      transition={{ duration: reduced ? 0 : .32, ease }}><Heart size={16} fill={active ? "currentColor" : "none"} /></motion.span>
  </motion.button>;
}

export default function App() {
  return <MotionConfig reducedMotion="user"><LayoutGroup id="spatial"><AppContent /></LayoutGroup></MotionConfig>;
}

function NavItem({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  const reduced = useReducedMotion();
  return <motion.button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} whileTap={reduced ? undefined : { scale: .98 }}>
    {active && <motion.span className="nav-indicator" layoutId="active-navigation" transition={spring} aria-hidden="true" />}
    {children}
  </motion.button>;
}

function shuffleList<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function AppContent() {
  const reduced = useReducedMotion();
  const discordPreferences = useDiscordPreferences();
  const [catalog, setCatalog] = useState<Library | null>(null);
  const [address, setAddress] = useState(localStorage.getItem("spatial-server") || (native ? "" : "http://127.0.0.1:8787"));
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(native);
  const [rememberedAddress, setRememberedAddress] = useState<string | null>(null);
  const restoreRequest = useRef<Promise<RememberedConnection | null> | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("connected");
  const [view, setView] = useState<"albums" | "tracks" | "mixes" | "favorites" | "queue">("albums");
  const [favorites, setFavorites] = useState<Favorites>(emptyFavorites);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Favorites>(emptyFavorites);
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<"output" | "settings" | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsWidth, setLyricsWidth] = useState(loadLyricsWidth);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [device, setDevice] = useState(localStorage.getItem("spatial-output") || "");
  const [devicesError, setDevicesError] = useState("");
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [status, setStatus] = useState(emptyStatus);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [starting, setStarting] = useState(false);
  const [remoteCompletion, setRemoteCompletion] = useState<{ id: string; error: string | null } | null>(null);
  const [seekPosition, setSeekPosition] = useState<number | null>(null);
  const [shuffle, setShuffle] = useState<boolean>(() => localStorage.getItem("spatial-shuffle") === "true");
  const [repeat, setRepeat] = useState<"off" | "all" | "one">(() => (localStorage.getItem("spatial-repeat") as "off" | "all" | "one") || "off");
  const originalQueueRef = useRef<Track[]>([]);
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const current = queue[queueIndex];
  const queueRef = useRef({ queue, queueIndex });
  queueRef.current = { queue, queueIndex };
  const advancing = useRef(false);
  const pendingPlay = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const lyricsToggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pageKey = selectedAlbum?.id || view;
  useEffect(() => { setSelecting(false); setSelection(emptyFavorites()); }, [pageKey, address]);
  useEffect(() => { setSelection(emptyFavorites()); }, [search]);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [pageKey]);
  const selectedDevice = devices.find(item => item.name === device)?.description || (device ? "Saved HDMI endpoint" : "Choose HDMI output");

  const refresh = useCallback(async () => {
    try { setCatalog(await call<Library>("get_library")); } catch (e) { setConnection("reconnecting"); }
  }, []);

  useEffect(() => {
    if (!catalog) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    onEvent<string>("library-changed", () => void refresh()).then(fn => cancelled ? fn() : cleanups.push(fn));
    onEvent<string>("server-connection", setConnection).then(fn => cancelled ? fn() : cleanups.push(fn));
    return () => { cancelled = true; cleanups.forEach(fn => fn()); };
  }, [!!catalog, refresh]);

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true); setDevicesError("");
    try { setDevices(await call<AudioDevice[]>("audio_devices")); }
    catch (e) { setDevicesError(String(e)); }
    finally { setLoadingDevices(false); }
  }, []);

  const acceptRestored = useCallback((saved: RememberedConnection | null) => {
    if (!saved) { setRememberedAddress(null); return; }
    setAddress(saved.address); setRememberedAddress(saved.address); setToken("");
    localStorage.setItem("spatial-server", saved.address);
    if (saved.library) {
      setFavorites(loadFavorites(saved.address)); setCatalog(saved.library); setConnection("connected");
      void loadDevices();
    }
    setError(saved.error || "");
  }, [loadDevices]);

  useEffect(() => {
    if (!native) return;
    let active = true;
    // Share the request across StrictMode effect replays, while each setup gets its own handler.
    restoreRequest.current ??= call<RememberedConnection | null>("restore_server");
    restoreRequest.current.then(saved => { if (active) acceptRestored(saved); })
      .catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, [acceptRestored]);

  const canUseSaved = native && rememberedAddress === address;

  useEffect(() => { if (modal === "output") void loadDevices(); }, [modal, loadDevices]);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!modal) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModal(null);
      if (event.key === "Tab" && dialogRef.current) {
        const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href], [tabindex='0']"));
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("keydown", escape); previousFocus?.focus(); };
  }, [modal]);

  useEffect(() => {
    if (selectedAlbum && catalog && !catalog.albums.some(album => album.id === selectedAlbum.id)) setSelectedAlbum(null);
  }, [catalog, selectedAlbum]);

  const start = useCallback(async (tracks: Track[], index: number, reportFailure = false) => {
    if (pendingPlay.current) { if (reportFailure) throw new Error("Playback is starting. Try again shortly."); return; }
    if (!device) { setModal("output"); setError("Choose your receiver's HDMI audio endpoint before playing."); if (reportFailure) throw new Error("Choose an HDMI output in Spatial on the PC first."); return; }
    if (!tracks[index]) { if (reportFailure) throw new Error("This track is unavailable."); return; }
    pendingPlay.current = true; setStarting(true); setError(""); advancing.current = false;
    try {
      await call("play_track", { id: tracks[index].id, device });
      setQueue(tracks); setQueueIndex(index);
      queueRef.current = { queue: tracks, queueIndex: index };
      setStatus({ ...emptyStatus, active: true, track_id: tracks[index].id, duration: tracks[index].duration });
    } catch (e) { setError(String(e)); if (reportFailure) throw e; }
    finally { pendingPlay.current = false; setStarting(false); }
  }, [device]);

  useEffect(() => {
    if (!catalog || !native) return;
    let cancelled = false;
    let timeout: number;
    let sampling = false;
    let sampledAt = -Infinity;
    let unlisten: (() => void) | undefined;
    const sample = async () => {
      if (cancelled || sampling || pendingPlay.current || performance.now() - sampledAt < 600) return;
      sampling = true; sampledAt = performance.now();
      try {
        if (!pendingPlay.current) {
          const next = await call<PlaybackStatus>("playback_status");
          if (!cancelled && !pendingPlay.current) {
            setStatus(next);
            if (next.error) setError(next.error);
            const snapshot = queueRef.current;
            if (next.ended && !advancing.current && snapshot.queue.length > 0) {
              if (repeatRef.current === "one") {
                advancing.current = true;
                await start(snapshot.queue, snapshot.queueIndex);
              } else if (snapshot.queueIndex + 1 < snapshot.queue.length) {
                advancing.current = true;
                await start(snapshot.queue, snapshot.queueIndex + 1);
              } else if (repeatRef.current === "all") {
                advancing.current = true;
                if (shuffleRef.current && snapshot.queue.length > 1) {
                  const reshuffled = shuffleList(snapshot.queue);
                  await start(reshuffled, 0);
                } else {
                  await start(snapshot.queue, 0);
                }
              }
            }
          }
        }
      } catch (e) { if (!cancelled) setError(String(e)); }
      finally { sampling = false; }
    };
    const poll = async () => {
      await sample();
      if (!cancelled) timeout = window.setTimeout(poll, 700);
    };
    // The native remote's clock also wakes polling when WebView timers are throttled.
    onEvent<null>("remote-tick", () => void sample()).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    void poll();
    return () => { cancelled = true; window.clearTimeout(timeout); unlisten?.(); };
  }, [!!catalog, start]);

  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (canUseSaved) {
        const saved = await call<RememberedConnection | null>("restore_server");
        acceptRestored(saved);
        if (!saved) setError("The saved connection is unavailable. Enter your access token again.");
        return;
      }
      const library = await call<Library>("connect_server", { address, token });
      setFavorites(loadFavorites(address));
      localStorage.setItem("spatial-server", address); setToken(""); setCatalog(library); setConnection("connected");
      if (native) setRememberedAddress(address);
      void loadDevices();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  async function action(command: string, args?: Record<string, unknown>) {
    try { await call(command, args); } catch (e) { setError(String(e)); }
  }

  function commitSeek(seconds: number) {
    setSeekPosition(null);
    setStatus(previous => ({ ...previous, position: seconds }));
    void action("seek", { seconds });
  }

  function toggleFavorite(kind: keyof Favorites, id: string) {
    const next = { ...favorites, [kind]: favorites[kind].includes(id)
      ? favorites[kind].filter(saved => saved !== id) : [...favorites[kind], id] };
    persistFavorites(next);
  }

  function persistFavorites(next: Favorites): boolean {
    try { saveFavorites(address, next); setFavorites(next); return true; }
    catch { setError("Could not save favorites on this device. Check that local app storage is available."); return false; }
  }

  function selectItem(kind: keyof Favorites, id: string) {
    setSelection(previous => ({ ...previous, [kind]: previous[kind].includes(id)
      ? previous[kind].filter(selected => selected !== id) : [...previous[kind], id] }));
  }

  function resizeLyrics(width: number) {
    setLyricsWidth(width);
    try { localStorage.setItem("spatial-lyrics-width", String(width)); } catch { /* Keep the preference for this session. */ }
  }

  function closeLyrics() {
    setLyricsOpen(false);
    requestAnimationFrame(() => lyricsToggleRef.current?.focus());
  }

  const filteredTrackEntries = (view === "queue" && !selectedAlbum ? queue : catalog?.tracks || [])
    .map((track, position) => ({ track, position })).filter(({ track }) =>
      (!selectedAlbum || track.album_id === selectedAlbum.id) &&
      (selectedAlbum || view !== "favorites" || favorites.tracks.includes(track.id)) &&
      (selectedAlbum || view !== "mixes" || track.title.toLowerCase().includes("mixed by tesla")) &&
      `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(search.toLowerCase()));
  const filteredTracks = filteredTrackEntries.map(entry => entry.track);
  const playQueue = useCallback((tracks: Track[], index: number) => {
    originalQueueRef.current = tracks;
    if (shuffleRef.current && tracks.length > 1) {
      const currentTrack = tracks[index];
      const others = tracks.filter((_, i) => i !== index);
      const shuffled = [currentTrack, ...shuffleList(others)];
      void start(shuffled, 0);
    } else {
      void start(tracks, index);
    }
  }, [start]);

  const toggleShuffle = useCallback(() => {
    const next = !shuffleRef.current;
    shuffleRef.current = next;
    setShuffle(next);
    localStorage.setItem("spatial-shuffle", String(next));
    const snapshot = queueRef.current;
    if (next) {
      if (snapshot.queue.length > 1 && snapshot.queueIndex >= 0) {
        originalQueueRef.current = snapshot.queue;
        const currentTrack = snapshot.queue[snapshot.queueIndex];
        const others = snapshot.queue.filter((_, i) => i !== snapshot.queueIndex);
        const shuffled = [currentTrack, ...shuffleList(others)];
        setQueue(shuffled);
        setQueueIndex(0);
        queueRef.current = { queue: shuffled, queueIndex: 0 };
      }
    } else {
      const currentTrack = snapshot.queue[snapshot.queueIndex];
      if (originalQueueRef.current.length > 0 && currentTrack) {
        const orig = originalQueueRef.current;
        const found = orig.findIndex(t => t.id === currentTrack.id);
        const newIdx = found >= 0 ? found : 0;
        setQueue(orig);
        setQueueIndex(newIdx);
        queueRef.current = { queue: orig, queueIndex: newIdx };
      }
    }
  }, []);

  const toggleRepeat = useCallback(() => {
    setRepeat(prev => {
      const next = prev === "off" ? "all" : prev === "all" ? "one" : "off";
      localStorage.setItem("spatial-repeat", next);
      return next;
    });
  }, []);

  const handleNext = useCallback(() => {
    const snapshot = queueRef.current;
    if (!snapshot.queue.length || starting) return;
    if (snapshot.queueIndex + 1 < snapshot.queue.length) {
      void start(snapshot.queue, snapshot.queueIndex + 1);
    } else if (repeatRef.current === "all") {
      if (shuffleRef.current && snapshot.queue.length > 1) {
        const reshuffled = shuffleList(snapshot.queue);
        void start(reshuffled, 0);
      } else {
        void start(snapshot.queue, 0);
      }
    }
  }, [starting, start]);

  const handlePrevious = useCallback(() => {
    const snapshot = queueRef.current;
    if (!snapshot.queue.length || starting) return;
    if (status.position > 3) {
      void action("seek", { seconds: 0 });
      return;
    }
    if (snapshot.queueIndex > 0) {
      void start(snapshot.queue, snapshot.queueIndex - 1);
    } else if (repeatRef.current === "all") {
      void start(snapshot.queue, snapshot.queue.length - 1);
    }
  }, [starting, status.position, start]);

  function playListedTrack(index: number) {
    if (view === "queue" && !selectedAlbum) void start(queue, filteredTrackEntries[index].position);
    else playQueue(filteredTracks, index);
  }
  function openQueue() { setView("queue"); setSelectedAlbum(null); setSearch(""); }
  const albums = (catalog?.albums || []).filter(album => (view !== "favorites" || favorites.albums.includes(album.id)) && `${album.title} ${album.artist}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const albumTracks = catalog?.tracks.filter(track => track.album_id === selectedAlbum?.id) || [];
  const selected = selectedAlbum && (catalog?.albums.find(album => album.id === selectedAlbum.id) || selectedAlbum);
  const favoriteAlbumCount = catalog?.albums.filter(album => favorites.albums.includes(album.id)).length || 0;
  const favoriteTrackCount = catalog?.tracks.filter(track => favorites.tracks.includes(track.id)).length || 0;
  const mixesCount = catalog?.tracks.filter(track => track.title.toLowerCase().includes("mixed by tesla")).length || 0;
  const themeArtwork = current ? current.artwork_id : selected ? selected.artwork_id : catalog?.albums.find(album => album.artwork_id)?.artwork_id;
  const theme = useArtworkTheme(catalog ? themeArtwork : null);
  const remoteHandler = useRef<(command: RemoteCommand) => Promise<void>>(async () => {});
  remoteHandler.current = async command => {
    if (!catalog) throw new Error("Connect Spatial to a music server first.");
    const snapshot = queueRef.current;
    switch (command.action) {
      case "play": {
        const selection = remotePlaySelection(catalog, command.id, command.album_id, command.query, command.favorites_only ? favorites.tracks : undefined);
        originalQueueRef.current = selection.tracks;
        if (shuffleRef.current && selection.tracks.length > 1) {
          await start([selection.tracks[selection.index], ...shuffleList(selection.tracks.filter((_, index) => index !== selection.index))], 0, true);
        } else await start(selection.tracks, selection.index, true);
        break;
      }
      case "queue": await start(snapshot.queue, command.index, true); break;
      case "toggle_pause":
        if (!current) throw new Error("Choose a track first.");
        if (status.active) { await call("toggle_pause"); setStatus(await call<PlaybackStatus>("playback_status")); }
        else await start(snapshot.queue, snapshot.queueIndex, true);
        break;
      case "next":
        if (snapshot.queueIndex + 1 < snapshot.queue.length) await start(snapshot.queue, snapshot.queueIndex + 1, true);
        else if (repeatRef.current === "all" && snapshot.queue.length) {
          await start(shuffleRef.current ? shuffleList(snapshot.queue) : snapshot.queue, 0, true);
        } else throw new Error("You're at the end of the queue.");
        break;
      case "previous":
        if (status.position > 3) { await call("seek", { seconds: 0 }); setStatus(await call<PlaybackStatus>("playback_status")); }
        else if (snapshot.queueIndex > 0) await start(snapshot.queue, snapshot.queueIndex - 1, true);
        else if (repeatRef.current === "all" && snapshot.queue.length) await start(snapshot.queue, snapshot.queue.length - 1, true);
        else throw new Error("You're at the start of the queue.");
        break;
      case "seek":
        await call("seek", { seconds: command.seconds }); setSeekPosition(null);
        setStatus(await call<PlaybackStatus>("playback_status")); break;
      case "shuffle": toggleShuffle(); break;
      case "repeat": toggleRepeat(); break;
      case "favorite": {
        const next = { ...favorites, tracks: favorites.tracks.includes(command.id) ? favorites.tracks.filter(id => id !== command.id) : [...favorites.tracks, command.id] };
        if (!persistFavorites(next)) throw new Error("Favorites couldn't be saved on the PC.");
        break;
      }
    }
  };
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onEvent<RemoteCommand>("remote-command", command => {
      void (async () => {
        if (!await call<boolean>("remote_command_pending", { id: command.request_id })) return;
        let error: string | null = null;
        try { await remoteHandler.current(command); } catch (e) { error = e instanceof Error ? e.message : String(e); }
        setRemoteCompletion({ id: command.request_id, error });
      })().catch(() => {});
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (native) void call("publish_remote_library", { library: catalog }).catch(() => {});
  }, [catalog]);
  useEffect(() => {
    if (!native) return;
    // Publish the committed React state before acknowledging a phone command.
    // A phone's immediate read after a skip must see the new queue and controls.
    const completion = remoteCompletion;
    void call("publish_remote_state", { snapshot: {
      connected: !!catalog, ready: !!device, starting, current: current || null, status,
      queue_ids: queue.map(track => track.id), queue_index: queueIndex, shuffle, repeat,
      favorite_ids: favorites.tracks, theme,
    } }).then(async () => {
      if (completion) await call("complete_remote_command", completion);
    }).catch(() => {}).finally(() => {
      if (completion) setRemoteCompletion(previous => previous?.id === completion.id ? null : previous);
    });
  }, [!!catalog, device, starting, current, status, queue, queueIndex, shuffle, repeat, favorites.tracks, theme, remoteCompletion]);
  const maximumLyricsWidth = maxLyricsWidth(viewportWidth);
  const panelWidth = clampLyricsWidth(lyricsWidth, maximumLyricsWidth);
  const lyricsTrack = current || null;
  const visibleItems: Favorites = {
    albums: !selected && (view === "albums" || view === "favorites") ? albums.map(album => album.id) : [],
    tracks: selected || view !== "albums" ? [...new Set(filteredTracks.map(track => track.id))] : [],
  };
  const visibleSelection: Favorites = { albums: selection.albums.filter(id => visibleItems.albums.includes(id)),
    tracks: selection.tracks.filter(id => visibleItems.tracks.includes(id)) };
  const collectionTools = (compact = false) => catalog && <CollectionTools catalog={catalog} favorites={favorites}
    selected={visibleSelection} visible={visibleItems} selecting={selecting} sharing={!selected && view === "favorites"}
    compact={compact} onMode={setSelecting} onSelect={setSelection} onUpdate={persistFavorites} />;
  const seekFill = Math.max(0, Math.min(100, (seekPosition ?? status.position) / (status.duration || current?.duration || 1) * 100));

  if (!catalog) return <motion.main className="connect-screen" data-reduced-motion={reduced ? "true" : undefined} style={theme as CSSProperties} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .45, ease }}>
    <div className="connect-art"><div className="orbital orbital-one" /><div className="orbital orbital-two" /><div className="orbital orbital-three" />
      <div className="connect-message"><span className="eyebrow">A DIFFERENT KIND OF LISTENING</span><h1>Music with<br />room to move.</h1><p>Your collection. Every dimension.<br />Straight to your receiver.</p></div>
    </div>
    <section className="connect-panel"><div className="brand"><span>spatial<span className="brand-dot">.</span></span></div>
      <div className="connect-form-wrap"><span className="eyebrow">WELCOME</span><h2>Connect your library</h2><p>{restoring ? "Opening your saved library…" : canUseSaved ? "Reconnect using your saved access token." : "Enter the server address and access token."}</p>
        <form onSubmit={connect}><label>Server address<input autoFocus type="url" placeholder="https://spatial.example.com" value={address} onChange={e => setAddress(e.target.value)} disabled={busy || restoring} required /></label>
          {!restoring && !canUseSaved && <label>Access token<input type="password" autoComplete="off" placeholder="Enter access token" value={token} onChange={e => setToken(e.target.value)} disabled={busy} required /></label>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary connect-button" disabled={busy || restoring}>{busy || restoring ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} {busy || restoring ? "Connecting…" : canUseSaved ? "Retry connection" : "Open my library"}</button>
          {canUseSaved && <button type="button" className="text-button" disabled={busy} onClick={() => { setRememberedAddress(null); setError(""); }}>Use another token</button>}
        </form><span className="connect-footnote"><Check size={14} /> {native ? "Access token is saved securely on this device." : "Access token stays in memory for this preview."}</span>
        <UpdateStatus />
      </div>
    </section>
  </motion.main>;

  return <motion.div className={`app-shell ${lyricsOpen ? "lyrics-open" : ""}`} data-reduced-motion={reduced ? "true" : undefined} style={{ ...theme, "--lyrics-width": `${panelWidth}px`, "--lyrics-space": lyricsOpen ? `${panelWidth}px` : "0px" } as CSSProperties}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : .4, ease }}>
    <aside className="sidebar"><button className="brand" onClick={() => { setSelectedAlbum(null); setView("albums"); setSearch(""); }}><span>spatial<span className="brand-dot">.</span></span></button>
      <span className="nav-label">YOUR COLLECTION</span><nav>
        <NavItem active={view === "albums"} onClick={() => { setView("albums"); setSelectedAlbum(null); setSearch(""); }}><LibraryBig size={19} /> Albums <span>{catalog.albums.length}</span></NavItem>
        <NavItem active={view === "tracks"} onClick={() => { setView("tracks"); setSelectedAlbum(null); setSearch(""); }}><ListMusic size={19} /> All tracks <span>{catalog.tracks.length}</span></NavItem>
        <NavItem active={view === "mixes"} onClick={() => { setView("mixes"); setSelectedAlbum(null); setSearch(""); }}><Disc3 size={19} /> Spatial Mixes <span>{mixesCount}</span></NavItem>
        <NavItem active={view === "favorites"} onClick={() => { setView("favorites"); setSelectedAlbum(null); setSearch(""); }}><Heart size={19} /> Favorites <span>{favoriteAlbumCount + favoriteTrackCount}</span></NavItem>
        <NavItem active={view === "queue"} onClick={openQueue}><Layers3 size={19} /> Play queue <span>{queue.length}</span></NavItem>
      </nav><div className="sidebar-note"><Waves size={22} /><p>More than sound.<br /><strong>A sense of space.</strong></p></div>
      <div className="sidebar-bottom"><button className="output-card" onClick={() => setModal("output")}><Speaker size={19} /><span>OUTPUT DEVICE<strong>{selectedDevice}</strong></span><ChevronDown size={13} /></button>
        <div className="server-state"><span className={`status-dot ${connection !== "connected" ? "amber" : ""}`} /><span>{connection === "connected" ? "Server Connected" : "Reconnecting to server…"}</span></div>
        <div className="sidebar-actions"><button className="text-button" onClick={async () => { await action("disconnect_server"); setRememberedAddress(null); setCatalog(null); setQueue([]); setQueueIndex(-1); setStatus(emptyStatus); setError(""); setSelectedAlbum(null); setLyricsOpen(false); }}>Change server</button><button className="icon-button" aria-label="Open settings" title="Settings" onClick={() => setModal("settings")}><Settings2 size={16} /></button></div>
        <UpdateStatus />
      </div>
    </aside>
    <main ref={mainRef} className="main-content"><header className="topbar">
      <label className="search-box"><Search size={17} /><input aria-label="Search your library" placeholder="Search your collection" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={15} /></button>}</label>
    </header>
      <AnimatePresence initial={false}>{error && <motion.div className="error-banner" role="alert" initial={{ opacity: 0, y: reduced ? 0 : -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .2 }}><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={17} /></button></motion.div>}</AnimatePresence>
      <AnimatePresence mode="wait"><PageTransition key={pageKey}>
      {selected ? <>
        <button className="back-button" onClick={() => { setSelectedAlbum(null); setSearch(""); }}><ArrowLeft size={16} /> Back to collection</button>
        <section className="album-hero"><Cover id={selected.artwork_id} title={selected.title} /><div className="album-info"><span className="eyebrow">ALBUM {selected.atmos && <AtmosBadge />}</span><h1>{selected.title}</h1><p className="album-artist">{selected.artist}</p><p className="subtle">{year(selected.date)} <span>·</span> {selected.track_count} tracks <span>·</span> {Math.round(selected.duration / 60)} min</p>
          <div className="album-actions"><button className="primary" disabled={starting} onClick={() => playQueue(albumTracks, 0)}><Play size={16} fill="currentColor" /> Play album</button><button className="secondary" onClick={() => { if (!shuffle) { setShuffle(true); localStorage.setItem("spatial-shuffle", "true"); } playQueue(albumTracks, Math.floor(Math.random() * albumTracks.length)); }}><Shuffle size={16} /> Shuffle</button><FavoriteButton active={favorites.albums.includes(selected.id)} label={`album ${selected.title}`} onClick={() => toggleFavorite("albums", selected.id)} />{!selecting && collectionTools(true)}</div>
        </div></section>{selecting && collectionTools()}
      </> : <section className="library-heading"><span className="eyebrow">{view === "queue" ? "THIS SESSION" : view === "favorites" ? "SAVED ON THIS DEVICE" : view === "mixes" ? "COLLECTION" : "LIBRARY"}</span><h1>{view === "queue" ? "Play queue" : view === "favorites" ? "Your favorites." : view === "mixes" ? "Spatial Mixes" : view === "albums" ? "Sound, in every dimension." : "Every track. All yours."}</h1><p>{view === "queue" ? <>{queue.length} tracks in your queue</> : view === "mixes" ? <>{mixesCount} {mixesCount === 1 ? "track" : "tracks"}</> : view === "favorites" ? <>{favoriteAlbumCount} albums <span>·</span> {favoriteTrackCount} tracks</> : <>{catalog.albums.length} albums <span>·</span> {catalog.tracks.length} tracks <span>·</span> {catalog.tracks.filter(t => t.atmos).length} in Dolby Atmos</>}</p></section>}
      {!selected && view !== "albums" && collectionTools()}
      {!selected && (view === "albums" || view === "favorites") && <section className="collection-section"><div className={`section-bar ${selecting ? "bulk-mode" : ""}`}><h2>{search && view !== "favorites" ? "Search results" : "Your albums"}<span>{albums.length}</span></h2>{view === "albums" ? collectionTools(!selecting) : <span className="sort-label">Newest releases first</span>}</div>
        {albums.length ? <div className="album-grid">{albums.map((album, index) => <motion.article className={`album-card ${selecting && visibleSelection.albums.includes(album.id) ? "is-selected" : ""}`} key={album.id} layout={albums.length <= 80 ? "position" : false} layoutDependency={`${search}:${favorites.albums.length}:${catalog.revision}`} initial={reduced || index >= 16 ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : .35, delay: reduced || index >= 16 ? 0 : index * .018, ease, layout: spring }} whileHover={reduced ? undefined : { y: -3 }}>{selecting && <input className="selection-checkbox album-selection" type="checkbox" aria-label={`Select album ${album.title}`} checked={visibleSelection.albums.includes(album.id)} onChange={() => selectItem("albums", album.id)} />}<button className="artwork-wrap" aria-label={`${selecting ? "Select" : "Open"} album ${album.title}`} onClick={() => { if (selecting) selectItem("albums", album.id); else { setSelectedAlbum(album); setSearch(""); } }}><Cover id={album.artwork_id} title={album.title} /><span className="card-open"><ArrowRight size={20} /></span></button><div className="album-card-title"><button onClick={() => { if (selecting) selectItem("albums", album.id); else { setSelectedAlbum(album); setSearch(""); } }}><h3>{album.title}</h3></button><FavoriteButton active={favorites.albums.includes(album.id)} label={`album ${album.title}`} onClick={() => toggleFavorite("albums", album.id)} /></div><p>{album.artist}</p><span className="album-meta">{year(album.date)}{year(album.date) && " · "}{album.track_count} tracks</span></motion.article>)}</div> : <div className="empty-state"><Disc3 size={40} /><h3>{search ? "No albums found" : view === "favorites" ? "No favorite albums yet" : "No albums yet"}</h3><p>{search ? "Try an artist or album title." : view === "favorites" ? "Tap the heart beside an album to save it here." : "No albums are available on this server yet."}</p></div>}
      </section>}
      {(selected || view !== "albums") && <section className={`track-section ${!selected && view === "favorites" ? "favorite-tracks" : ""}`}>{!selected && view === "favorites" && <div className="section-bar"><h2>Your tracks<span>{filteredTracks.length}</span></h2></div>}<div className="track-header"><span>#</span><span>TRACK</span><span>FORMAT</span><span>TIME</span><span /></div>
        {filteredTracks.map((track, index) => <motion.div initial={reduced || index >= 16 ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} layout={filteredTracks.length <= 80 ? "position" : false} layoutDependency={`${search}:${favorites.tracks.length}:${catalog.revision}`} transition={{ duration: reduced ? 0 : .3, delay: reduced || index >= 16 ? 0 : Math.min(index, 8) * .015, ease, layout: spring }} className={`track-row ${selecting && visibleSelection.tracks.includes(track.id) ? "is-selected" : ""} ${current?.id === track.id && (view !== "queue" || queueIndex === filteredTrackEntries[index].position) ? "playing" : ""}`} key={view === "queue" ? `${track.id}-${filteredTrackEntries[index].position}` : track.id}>
          {selecting ? <input className="selection-checkbox" type="checkbox" aria-label={`Select track ${track.title} by ${track.artist}`} checked={visibleSelection.tracks.includes(track.id)} onChange={() => selectItem("tracks", track.id)} /> : <button className="track-play" aria-label={`Play ${track.title}`} disabled={starting} onClick={() => playListedTrack(index)}>{current?.id === track.id && status.active && (view !== "queue" || queueIndex === filteredTrackEntries[index].position) ? <Waves size={16} /> : <><span>{selected ? track.track_number || index + 1 : view === "queue" ? filteredTrackEntries[index].position + 1 : index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}</button>}
          <button className="track-title" onClick={() => selecting ? selectItem("tracks", track.id) : playListedTrack(index)}>{!selected && <Cover id={track.artwork_id} title={track.title} />}<span><strong>{track.title}</strong><small>{track.artist}{!selected && ` · ${track.album}`}</small></span></button>
          <span className="track-format">{track.atmos ? <AtmosBadge small /> : track.codec.toUpperCase()}</span><span className="track-time">{time(track.duration)}</span><div className="track-actions"><FavoriteButton active={favorites.tracks.includes(track.id)} label={`track ${track.title}`} onClick={() => toggleFavorite("tracks", track.id)} /></div>
        </motion.div>)}{!filteredTracks.length && <div className="empty-state">{view === "queue" ? <ListMusic size={30} /> : <Heart size={30} />}<h3>{!selected && view === "queue" && !search ? "Your queue is empty" : !selected && view === "favorites" && !search ? "No favorite tracks yet" : !selected && view === "mixes" && !search ? "No mixes yet" : "No tracks found"}</h3><p>{!selected && view === "queue" && !search ? "Play an album or track to build your queue." : !selected && view === "favorites" && !search ? "Tap the heart beside a track to save it here." : !selected && view === "mixes" && !search ? 'Tracks with “mixed by tesla” in the title appear here automatically.' : "Try another search."}</p></div>}
      </section>}
      </PageTransition></AnimatePresence>
    </main>
    <AnimatePresence initial={false}>{lyricsOpen && <LyricsSlot key="lyrics"><LyricsSidebar width={panelWidth} maximum={maximumLyricsWidth} onResize={resizeLyrics} onClose={closeLyrics}
      track={lyricsTrack} position={status.track_id === lyricsTrack?.id ? status.position : 0}
      playing={status.track_id === lyricsTrack?.id && status.active} onSeek={seconds => void action("seek", { seconds })} /></LyricsSlot>}</AnimatePresence>
    <footer className="player-bar"><div className="now-playing">{current ? <Cover id={current.artwork_id} title={current.title} /> : <div className="idle-cover"><Headphones size={24} /></div>}
      <AnimatePresence initial={false} mode="wait"><motion.div className="now-playing-label" key={current?.id || "idle"}
        initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -3 }} transition={{ duration: reduced ? 0 : .16, ease }}>
        <strong>{current?.title || "Find your next dimension"}</strong><span>{current?.artist || "Choose an album to start listening"}</span>
      </motion.div></AnimatePresence><FavoriteButton active={!!current && favorites.tracks.includes(current.id)} label={current ? `track ${current.title}` : "current track"} disabled={!current} onClick={() => { if (current) toggleFavorite("tracks", current.id); }} /></div>
      <div className="transport"><div className="transport-buttons">
        <button className={`icon-button ${shuffle ? "is-active" : ""}`} aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"} title={shuffle ? "Shuffle: On" : "Shuffle: Off"} onClick={toggleShuffle}>
          <Shuffle size={17} />
        </button>
        <button className="icon-button" aria-label="Previous track" disabled={!current || starting || (queueIndex <= 0 && repeat !== "all" && status.position <= 3)} onClick={handlePrevious}>
          <SkipBack size={18} fill="currentColor" />
        </button>
        <motion.button className="play-button" aria-label={status.active && !status.paused ? "Pause" : "Play"} whileTap={!current || starting || reduced ? undefined : { scale: .9 }} disabled={!current || starting} onClick={() => status.active ? void action("toggle_pause") : void start(queue, queueIndex)}>
          <AnimatePresence initial={false} mode="wait"><motion.span className="play-glyph" key={starting ? "loading" : status.active && !status.paused ? "pause" : "play"}
            initial={{ opacity: 0, scale: reduced ? 1 : .8, rotate: reduced ? 0 : -12 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: reduced ? 1 : .8 }} transition={{ duration: reduced ? 0 : .12, ease }}>
            {starting ? <LoaderCircle className="spin" size={20} /> : status.active && !status.paused ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </motion.span></AnimatePresence>
        </motion.button>
        <button className="icon-button" aria-label="Next track" disabled={!current || starting || (queueIndex + 1 >= queue.length && repeat !== "all")} onClick={handleNext}>
          <SkipForward size={18} fill="currentColor" />
        </button>
        <button className={`icon-button ${repeat !== "off" ? "is-active" : ""}`} aria-label={repeat === "one" ? "Repeat: Current track" : repeat === "all" ? "Repeat: Entire queue" : "Repeat: Off"} title={repeat === "one" ? "Repeat: One" : repeat === "all" ? "Repeat: All" : "Repeat: Off"} onClick={toggleRepeat}>
          {repeat === "one" ? <Repeat1 size={17} /> : <Repeat size={17} />}
        </button>
      </div>
        <div className="progress"><span>{time(seekPosition ?? status.position)}</span><input aria-label="Playback position" aria-valuetext={`${time(seekPosition ?? status.position)} of ${time(status.duration || current?.duration || 0)}`} style={{ "--seek-fill": `${seekFill}%` } as CSSProperties} type="range" min={0} max={status.duration || current?.duration || 1} step={0.1} value={seekPosition ?? status.position} disabled={!status.active || starting} onChange={e => setSeekPosition(Number(e.target.value))} onPointerUp={e => commitSeek(Number(e.currentTarget.value))} onKeyUp={e => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) commitSeek(Number(e.currentTarget.value)); }} /><span>{time(status.duration || current?.duration || 0)}</span></div>
      </div><div className="player-details"><button ref={lyricsToggleRef} className={`icon-button ${lyricsOpen ? "is-active" : ""}`} aria-label={lyricsOpen ? "Close lyrics" : "Open lyrics"} aria-pressed={lyricsOpen} aria-controls="lyrics-sidebar" onClick={() => { setLyricsOpen(open => !open); }}><Mic2 size={18} /></button><button className="icon-button" aria-label="Receiver output settings" title="Control volume on your receiver" onClick={() => setModal("output")}><Volume2 size={18} /></button><button className={`icon-button ${view === "queue" ? "is-active" : ""}`} aria-label="Open queue" onClick={openQueue}><ListMusic size={19} /></button></div>
    </footer>
    <AnimatePresence>{modal === "settings" && <DialogTransition key="settings" dialogRef={dialogRef} onClose={() => setModal(null)}><div className="modal-heading"><h2 id="modal-title">Settings</h2><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={22} /></button></div><DiscordSettings preferences={discordPreferences} /><RemoteSettings /><div className="modal-footer settings-actions"><button className="primary" onClick={() => setModal(null)}>Done</button></div></DialogTransition>}
    {modal === "output" && <DialogTransition key="output" dialogRef={dialogRef} onClose={() => setModal(null)}><div className="modal-heading"><div><span className="eyebrow">DIRECT TO YOUR RECEIVER</span><h2 id="modal-title">Audio output</h2></div><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={22} /></button></div>
      <p className="modal-description">Select the Windows HDMI endpoint connected to your Atmos receiver. Spatial requests exclusive Dolby passthrough.</p><div className="output-mode"><Layers3 size={20} /><div><strong>Original Dolby bitstream</strong><span>E-AC-3 / TrueHD · receiver controls volume</span></div><span className="mode-pill">EXCLUSIVE</span></div>
        {loadingDevices ? <div className="loading"><LoaderCircle className="spin" size={20} /> Finding audio endpoints…</div> : devices.map(item => <button className={`device-option ${device === item.name ? "selected" : ""}`} key={item.name} onClick={async () => { if (status.active && item.name !== device) { await action("stop_playback"); setStatus(emptyStatus); } setDevice(item.name); localStorage.setItem("spatial-output", item.name); setError(""); }}><Speaker size={20} /><span>{item.description}</span>{device === item.name && <Check size={19} />}</button>)}
        {devicesError && <div className="form-error">{devicesError}</div>}{!loadingDevices && !devices.length && !devicesError && <div className="empty-state"><Speaker size={30} /><p>{native ? "No Windows audio endpoints were found. Connect and switch on your receiver, then refresh." : "Audio endpoint selection is available in the Windows desktop application."}</p></div>}
        <div className="modal-footer"><button className="secondary" onClick={() => void loadDevices()}>Refresh devices</button><button className="primary" onClick={() => setModal(null)}>Done</button></div>
    </DialogTransition>}</AnimatePresence>
  </motion.div>;
}
