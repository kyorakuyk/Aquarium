export function replyDelayMs(text: string, random: () => number = Math.random): number {
  const characterCount = Array.from(text).length;
  const baseDelay = Math.min(6_000, Math.max(800, 600 + characterCount * 120));
  const sample = random();
  const jitterSample = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.round(baseDelay * (0.8 + jitterSample * 0.5));
}
