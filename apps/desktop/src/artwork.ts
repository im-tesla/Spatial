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
