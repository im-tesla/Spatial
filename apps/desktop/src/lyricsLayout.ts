export const defaultLyricsWidth = 360;
export const minLyricsWidth = 280;

export function maxLyricsWidth(viewport: number): number {
  const navigation = viewport <= 1100 ? 185 : 220;
  return Math.max(minLyricsWidth, Math.min(600, viewport - navigation - 440));
}

export function clampLyricsWidth(width: number, maximum: number): number {
  return Math.min(maximum, Math.max(minLyricsWidth, Number.isFinite(width) ? width : defaultLyricsWidth));
}

export function loadLyricsWidth(): number {
  try {
    const saved = localStorage.getItem("spatial-lyrics-width");
    return saved === null ? defaultLyricsWidth : clampLyricsWidth(Number(saved), 600);
  } catch { return defaultLyricsWidth; }
}
