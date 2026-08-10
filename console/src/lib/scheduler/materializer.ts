/**
 * Materializes the schedule definition (plans + week assignment + exceptions)
 * into concrete scheduled_runs rows over the horizon. Regeneration is
 * idempotent: it deletes only PENDING SCHEDULE rows in the window and inserts
 * afresh — history (executed/missed/skipped) and manual runs are never touched.
 * The partial unique index on (bell_event_id, scheduled_at_utc) is the backstop.
 */
import { and, between, eq } from "drizzle-orm";
import type { DateTime } from "luxon";
import { db, schema, sqlite } from "@/lib/db/client";
import { getSettingNumber, updateSystemState } from "@/lib/state";
import { audioPathsForCue } from "./executor";
import { addDaysLocal, localToUtcEpoch, nowLocal, weekdayOf } from "./time";

export function effectivePlanIdFor(localDate: string): number | null {
  const exception = db
    .select()
    .from(schema.calendarExceptions)
    .where(eq(schema.calendarExceptions.date, localDate))
    .get();
  if (exception) return exception.type === "NO_SCHOOL" ? null : (exception.bellPlanId ?? null);
  const row = db
    .select()
    .from(schema.weekSchedule)
    .where(eq(schema.weekSchedule.dayOfWeek, weekdayOf(localDate)))
    .get();
  return row?.bellPlanId ?? null;
}

export function materialize(now: DateTime = nowLocal()): { inserted: number; horizonEnd: string } {
  const horizonDays = getSettingNumber("horizonDays", 35);
  const startDate = now.toFormat("yyyy-MM-dd");
  const horizonEnd = addDaysLocal(startDate, horizonDays - 1);
  const cutoffMs = now.toMillis(); // never materialize times already past

  const tx = sqlite.transaction(() => {
    db.delete(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.source, "SCHEDULE"),
          eq(schema.scheduledRuns.status, "PENDING"),
          between(schema.scheduledRuns.localDate, startDate, horizonEnd),
        ),
      )
      .run();

    let inserted = 0;
    for (let d = startDate; d <= horizonEnd; d = addDaysLocal(d, 1)) {
      const planId = effectivePlanIdFor(d);
      if (planId == null) continue;
      const overrides = new Map(
        db
          .select()
          .from(schema.bellEventOverrides)
          .where(eq(schema.bellEventOverrides.localDate, d))
          .all()
          .map((override) => [override.bellEventId, override]),
      );
      const events = db
        .select({ ev: schema.bellEvents, cue: schema.soundCues })
        .from(schema.bellEvents)
        .innerJoin(schema.soundCues, eq(schema.bellEvents.cueId, schema.soundCues.id))
        .where(
          and(
            eq(schema.bellEvents.bellPlanId, planId),
            eq(schema.bellEvents.isEnabled, true),
            eq(schema.soundCues.isEnabled, true),
          ),
        )
        .all();
      for (const { ev, cue } of events) {
        const override = overrides.get(ev.id);
        if (override?.kind === "SKIP") continue;
        const effectiveTime = override?.kind === "DELAY" && override.effectiveTime
          ? override.effectiveTime
          : ev.time;
        const at = localToUtcEpoch(d, effectiveTime);
        if (at <= cutoffMs) continue;
        try {
          db.insert(schema.scheduledRuns)
            .values({
              source: "SCHEDULE",
              bellEventId: ev.id,
              cueId: cue.id,
              cueName: cue.name,
              deliveryMethod:
                cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE"
                  ? ("PROTECT_TALKBACK_AUDIO" as const)
                  : cue.deliveryMethod,
              webhookId: cue.webhookId,
              ttsText: cue.ttsText,
              ttsTone: cue.ttsTone,
              audioPath: (audioPathsForCue(cue) ?? [])[0] ?? null,
              audioPaths: (() => {
                const p = audioPathsForCue(cue);
                return p && p.length > 1 ? JSON.stringify(p) : null;
              })(),
              estimatedDurationMs: cue.estimatedDurationMs,
              scheduledAtUtc: at,
              localDate: d,
              localTime: effectiveTime,
              status: "PENDING",
              createdAt: Date.now(),
            })
            .run();
          inserted++;
        } catch {
          // unique-index backstop: a non-PENDING run for this (event, time)
          // already exists (e.g. it played earlier today) — keep history.
        }
      }
    }
    updateSystemState({ lastMaterializedThrough: horizonEnd });
    return inserted;
  });

  return { inserted: tx(), horizonEnd };
}
