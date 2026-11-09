import { call } from "./api";

const cache = new Map<string, Promise<string>>();

export function getArtwork(id: string): Promise<string> {
  let request = cache.get(id);
  if (!request) {
    request = call<string>("get_artwork", { id }).catch(error => { cache.delete(id); throw error; });
    cache.set(id, request);
  }
  return request;
}

const portraits = new Map<string, Promise<string | null>>();
let activePortraits = 0;
const portraitQueue: (() => void)[] = [];

function limitPortrait<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      activePortraits++;
      task().then(resolve, reject).finally(() => {
        activePortraits--;
        portraitQueue.shift()?.();
      });
    };
    if (activePortraits < 3) run(); else portraitQueue.push(run);
  });
}

/** Artist portraits are resolved by the server and cached per spelling for this session. */
export function getArtistArtwork(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (!key || key === "various artists" || key === "unknown artist") return Promise.resolve(null);
  let request = portraits.get(key);
  if (!request) {
    request = limitPortrait(() => call<string | null>("get_artist_artwork", { name: name.trim() }))
      .then(url => url || null)
      .catch(error => { portraits.delete(key); throw error; });
    portraits.set(key, request);
    if (portraits.size > 120) portraits.delete(portraits.keys().next().value!);
  }
  return request;
}
