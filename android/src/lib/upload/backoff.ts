export function backoff(attempt: number, retryAfterS?: number, random: () => number = Math.random): number {
  if (retryAfterS !== undefined && Number.isFinite(retryAfterS)) return Math.max(0, retryAfterS * 1000);
  return Math.floor(Math.max(0, Math.min(1, random())) * Math.min(300000, 1000 * 2 ** Math.min(30, Math.max(0, attempt - 1))));
}
