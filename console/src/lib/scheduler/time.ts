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
 * Luxon maps nonexistent times (spring-forward gap) forward and resolves
 * ambiguous times (fall-back) to the first occurrence — pinned by tests.
 */
export function localToUtcEpoch(localDate: string, localTime: string): number {
  return DateTime.fromISO(`${localDate}T${localTime}`, { zone: env.schoolTz }).toMillis();
}

export function addDaysLocal(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: env.schoolTz }).plus({ days }).toFormat("yyyy-MM-dd");
}

/** 0=Sunday .. 6=Saturday, matching the week_schedule table. */
export function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate, { zone: env.schoolTz }).weekday % 7;
}
