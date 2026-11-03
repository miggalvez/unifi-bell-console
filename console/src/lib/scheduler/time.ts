import { DateTime } from "luxon";
import { env } from "@/env";

/** All wall-clock reasoning happens in the school timezone. */
export function nowLocal(): DateTime {
  return DateTime.now().setZone(env.schoolTz);
}

export function localDateTimeParts(now = nowLocal()): { localDate: string; localTime: string } {
  return { localDate: now.toFormat("yyyy-MM-dd"), localTime: now.toFormat("HH:mm") };
}

/**
 * Convert a school-local date + 'HH:MM' to a UTC epoch, DST-correct per date.
 * Nonexistent times (spring-forward gap) map forward; ambiguous times
 * (fall-back) resolve to the first occurrence — both pinned by tests.
 *
 * The first occurrence must be chosen explicitly: on its own, Luxon resolves
 * an ambiguous time with the zone's offset at the moment the process first
 * parsed a date (cached for the process lifetime), so the answer flipped with
 * the season the web/worker process happened to start in.
 */
export function localToUtcEpoch(localDate: string, localTime: string): number {
  const dt = DateTime.fromISO(`${localDate}T${localTime}`, { zone: env.schoolTz });
  return Math.min(...dt.getPossibleOffsets().map((d) => d.toMillis()));
}

export function addDaysLocal(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: env.schoolTz }).plus({ days }).toFormat("yyyy-MM-dd");
}

/** 0=Sunday .. 6=Saturday, matching the week_schedule table. */
export function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate, { zone: env.schoolTz }).weekday % 7;
}
