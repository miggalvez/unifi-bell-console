export function timeAgo(epochMs: number | null | undefined, now = Date.now()): string {
  if (!epochMs) return "never";
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "7:00 PM" from a stored "19:00". */
export function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Today" / "Tomorrow" / "Mon, Aug 10" — never a bare ISO date. */
export function friendlyDate(isoDate: string, todayIso: string, tomorrowIso: string): string {
  if (isoDate === todayIso) return "Today";
  if (isoDate === tomorrowIso) return "Tomorrow";
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** How long until something, in the units a person would actually say. */
export function friendlyCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in under a minute";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export const swrFetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
