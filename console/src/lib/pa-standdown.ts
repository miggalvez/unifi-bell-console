/**
 * "Does the PA have real work to do?" — asked by anything that makes test
 * noise on the speakers (the measurement scripts), so a diagnostic stands down
 * for the building rather than the other way round.
 *
 * Read-only on purpose. A diagnostic must never stop an alert or a drill, and
 * must never clear the speaker lock: those belong to whoever started them.
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getSystemState } from "@/lib/state";

/**
 * An emergency alert or a drill is live right now. Cheap enough to poll
 * during a test tone, and the one condition worth cutting a tone short for.
 */
export function alertOrDrillActive(): string | null {
  const state = getSystemState();
  if (state.alertCueId !== null) return "an emergency alert is sounding";
  if (state.drillSequenceId !== null) return "a drill is running";
  return null;
}

/**
 * Why a diagnostic should not start (or carry on), or null when the speakers
 * are free for the next `windowMs`. Covers what is sounding now, what holds
 * the speaker lock, and any bell or announcement due inside the window.
 */
export function reasonPaIsNeeded(windowMs: number, now = Date.now()): string | null {
  const live = alertOrDrillActive();
  if (live) return live;

  const state = getSystemState();
  if ((state.speakerBusyUntil ?? 0) > now) return "the speakers are in use";

  const playing = db
    .select({ cueName: schema.scheduledRuns.cueName })
    .from(schema.scheduledRuns)
    .where(inArray(schema.scheduledRuns.status, ["CLAIMED", "EXECUTING"]))
    .limit(1)
    .get();
  if (playing) return `${playing.cueName ?? "a cue"} is playing`;

  // Due now (the worker has up to a second before it claims it) or soon.
  const due = db
    .select({ cueName: schema.scheduledRuns.cueName, localTime: schema.scheduledRuns.localTime })
    .from(schema.scheduledRuns)
    .where(
      and(
        eq(schema.scheduledRuns.status, "PENDING"),
        gte(schema.scheduledRuns.scheduledAtUtc, now - 5_000),
        lte(schema.scheduledRuns.scheduledAtUtc, now + windowMs),
      ),
    )
    .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
    .limit(1)
    .get();
  if (due) return `${due.cueName ?? "a bell"} is due at ${due.localTime}`;

  return null;
}
