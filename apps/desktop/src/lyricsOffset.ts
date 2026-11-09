export const minLyricsOffset = -10;
export const maxLyricsOffset = 10;
export const lyricsOffsetStep = 0.1;

export function clampLyricsOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const stepped = Math.round(value / lyricsOffsetStep) * lyricsOffsetStep;
  return Math.min(maxLyricsOffset, Math.max(minLyricsOffset, Number(stepped.toFixed(1))));
}

export function formatLyricsOffset(offset: number): string {
  const value = clampLyricsOffset(offset);
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}s`;
}

/** Positive offsets show lyrics later, so timing compares against an earlier position. */
export function lyricsTiming(position: number, offset: number): number {
  return position - clampLyricsOffset(offset);
}

/** Clicking a shifted line should seek to where that line now plays in the recording. */
export function lyricSeekTime(lineTime: number, offset: number, duration = Infinity): number {
  return Math.min(duration, Math.max(0, lineTime + clampLyricsOffset(offset)));
}
