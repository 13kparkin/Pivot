/**
 * Display formatting for account rate limits.
 *
 * @module limitsFormat
 */

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const WEEKDAY_TIME = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * When a window resets: `4:00 PM` inside 24 hours, `Tue 10:00 AM` beyond.
 * Null for windows with no reset clock yet, "now" once the moment has passed
 * (the provider refreshes lazily, so a stale timestamp lingers briefly).
 */
export function formatResetAt(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  if (at <= nowMs) return "now";
  return at - nowMs < 24 * 60 * 60 * 1000 ? TIME.format(at) : WEEKDAY_TIME.format(at);
}

/** Coarse time-until-reset: `in 45m`, `in 2h`, `in 3d`. */
export function formatResetIn(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at) || at <= nowMs) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Age of a snapshot: `just now`, `5m ago`, `6h ago`, `3d ago`. */
export function formatAgo(asOf: string, nowMs: number): string {
  const at = Date.parse(asOf);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
