export function loadDiscordEnabled(storage?: Pick<Storage, "getItem">) {
  try { return (storage ?? globalThis.localStorage)?.getItem("spatial-discord-enabled") === "true"; } catch { return false; }
}
export function saveDiscordEnabled(enabled: boolean, storage?: Pick<Storage, "setItem">) {
  try { (storage ?? globalThis.localStorage)?.setItem("spatial-discord-enabled", String(enabled)); } catch { /* In-memory choice still works if storage is unavailable. */ }
}
