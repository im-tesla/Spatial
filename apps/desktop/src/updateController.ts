export type UpdateProgress = { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
export type UpdateHandle = {
  version: string; download: (onProgress: (event: UpdateProgress) => void) => Promise<void>;
  install: () => Promise<void>; close: () => Promise<void>;
};
export type UpdateState = {
  phase: "idle" | "checking" | "available" | "current" | "downloading" | "installing" | "installed" | "error";
  version?: string; percent?: number; message?: string;
};
type Transport = { check: () => Promise<UpdateHandle | null>; prepare: () => Promise<void>; cancel: () => Promise<void> };
export const updateInterval = 6 * 60 * 60 * 1000;

// A single controller survives navigation and StrictMode replays; checks never install updates.
export function createUpdateController(transport: Transport, now = Date.now) {
  let state: UpdateState = { phase: "idle" };
  let update: UpdateHandle | null = null;
  let verified: UpdateHandle | null = null;
  let busy = false;
  let nextCheck = 0;
  const subscribers = new Set<(state: UpdateState) => void>();
  const emit = (next: UpdateState) => { state = next; subscribers.forEach(subscriber => subscriber(state)); };
  return {
    snapshot: () => state,
    subscribe(subscriber: (state: UpdateState) => void) {
      subscribers.add(subscriber); subscriber(state);
      return () => { subscribers.delete(subscriber); };
    },
    async check(manual = false) {
      if (busy || state.phase === "installed" || (!manual && now() < nextCheck)) return;
      busy = true;
      const previous = state;
      if (manual) emit({ phase: "checking" });
      try {
        const candidate = await transport.check();
        const old = update; update = candidate;
        verified = null;
        if (old) await old.close().catch(() => {});
        nextCheck = now() + updateInterval;
        emit(candidate ? { phase: "available", version: candidate.version } : { phase: manual ? "current" : "idle" });
      } catch {
        nextCheck = now() + 60 * 60 * 1000;
        emit(manual ? { phase: "error", version: update?.version, message: "Couldn't check for updates. Try again." } : previous);
      } finally { busy = false; }
    },
    async install() {
      if (busy || !update || state.phase === "installed") return;
      busy = true;
      const candidate = update;
      let prepared = false;
      let downloaded = 0; let total: number | undefined;
      emit({ phase: "downloading", version: candidate.version });
      try {
        // The native download verifies the signature before resolving. Playback continues until then.
        if (verified !== candidate) await candidate.download(event => {
          if (event.event === "Started") { total = event.data.contentLength; downloaded = 0; }
          if (event.event === "Progress") downloaded += event.data.chunkLength;
          const percent = total ? Math.min(100, Math.floor(downloaded / total * 100)) : undefined;
          if (percent !== state.percent) emit({ phase: "downloading", version: candidate.version, percent });
        });
        verified = candidate;
        emit({ phase: "installing", version: candidate.version });
        prepared = true; await transport.prepare();
        // On Windows the plugin launches NSIS, exits Spatial, and restarts it after installation.
        await candidate.install();
        emit({ phase: "installed", version: candidate.version });
        update = null;
      } catch {
        if (prepared) await transport.cancel().catch(() => {});
        emit({ phase: "error", version: candidate.version, message: "Update couldn't be installed. Try again." });
      } finally { busy = false; }
    },
  };
}
