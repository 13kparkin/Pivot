/**
 * Split a message's accumulated status text into individual status points.
 *
 * Status text is built from streaming `status_text` deltas; each delta is
 * typically one complete status line from the provider, so newlines are the
 * point separator. Blank lines and surrounding whitespace are dropped so a
 * collapsed list reads as one line per point.
 */
export function splitStatusPoints(statusText: string | null | undefined): string[] {
  if (statusText === null || statusText === undefined) {
    return [];
  }
  const points: string[] = [];
  for (const line of statusText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      points.push(trimmed);
    }
  }
  return points;
}
