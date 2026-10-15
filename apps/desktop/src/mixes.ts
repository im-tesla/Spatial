export function isSpatialMix(title: string): boolean {
  return /\b(?:spatial\s+mix|mixed\s+by\s+tesla)\b/i.test(title);
}
