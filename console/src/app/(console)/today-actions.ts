"use server";

import { and, asc, eq, gt } from "drizzle-orm";
import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { db, schema, sqlite } from "@/lib/db/client";
import { env } from "@/env";
import { requireAdmin } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { materialize } from "@/lib/scheduler/materializer";

export interface TodayActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const CHANGE_SAFETY_MS = 10_000;

function todayAt(now: number): string {
  return DateTime.fromMillis(now, { zone: env.schoolTz }).toFormat("yyyy-MM-dd");
}

function refreshToday(): void {
  materialize();
  revalidatePath("/");
  revalidatePath("/schedule");
  revalidatePath("/activity");
}

/** Skip or delay the next queued bell, deriving its identity entirely server-side. */
export async function changeNextBell(
  kind: "SKIP" | "DELAY",
  delayMinutes?: number,
): Promise<TodayActionResult> {
  const admin = await requireAdmin();
  if (kind !== "SKIP" && kind !== "DELAY") return { ok: false, error: "Choose a valid change." };
  if (kind === "DELAY" && delayMinutes !== 5 && delayMinutes !== 10) {
    return { ok: false, error: "A bell can be delayed by 5 or 10 minutes." };
  }

  const now = Date.now();
  const localDate = todayAt(now);
  let changed: { runId: number; eventId: number; cueName: string; from: string; to: string | null } | null = null;

  try {
    const tx = sqlite.transaction(() => {
      const upcoming = db
        .select({
          id: schema.scheduledRuns.id,
          bellEventId: schema.scheduledRuns.bellEventId,
          cueName: schema.scheduledRuns.cueName,
          localTime: schema.scheduledRuns.localTime,
          scheduledAtUtc: schema.scheduledRuns.scheduledAtUtc,
        })
        .from(schema.scheduledRuns)
        .where(
          and(
            eq(schema.scheduledRuns.source, "SCHEDULE"),
            eq(schema.scheduledRuns.status, "PENDING"),
            eq(schema.scheduledRuns.localDate, localDate),
            gt(schema.scheduledRuns.scheduledAtUtc, now),
          ),
        )
        .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
        .limit(2)
        .all();
      const next = upcoming[0];
      if (!next?.bellEventId) throw new Error("There is no upcoming bell to change today.");
      if (next.scheduledAtUtc - now <= CHANGE_SAFETY_MS) {
        throw new Error("That bell is already starting and is too close to change safely.");
      }

      let effectiveTime: string | null = null;
      if (kind === "DELAY") {
        const delayedAt = next.scheduledAtUtc + delayMinutes! * 60_000;
        if (upcoming[1] && delayedAt >= upcoming[1].scheduledAtUtc) {
          throw new Error("That delay would overlap the following bell. Skip it or choose a shorter delay.");
        }
        const delayed = DateTime.fromMillis(delayedAt, { zone: env.schoolTz });
        if (delayed.toFormat("yyyy-MM-dd") !== localDate) {
          throw new Error("A bell cannot be delayed into another day.");
        }
        effectiveTime = delayed.toFormat("HH:mm");
      }

      db.insert(schema.bellEventOverrides)
        .values({
          localDate,
          bellEventId: next.bellEventId,
          kind,
          effectiveTime,
          createdBy: admin.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.bellEventOverrides.localDate, schema.bellEventOverrides.bellEventId],
          set: { kind, effectiveTime, createdBy: admin.id, updatedAt: now },
        })
        .run();

      if (kind === "SKIP") {
        db.delete(schema.scheduledRuns)
          .where(and(eq(schema.scheduledRuns.id, next.id), eq(schema.scheduledRuns.status, "PENDING")))
          .run();
      } else {
        const delayedAt = next.scheduledAtUtc + delayMinutes! * 60_000;
        db.update(schema.scheduledRuns)
          .set({ scheduledAtUtc: delayedAt, localTime: effectiveTime! })
          .where(and(eq(schema.scheduledRuns.id, next.id), eq(schema.scheduledRuns.status, "PENDING")))
          .run();
      }

      return {
        runId: next.id,
        eventId: next.bellEventId,
        cueName: next.cueName ?? "Bell",
        from: next.localTime,
        to: effectiveTime,
      };
    });
    changed = tx.immediate();
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 200) };
  }

  writeAudit({
    userId: admin.id,
    action: kind === "SKIP" ? "schedule.skip_next" : "schedule.delay_next",
    targetType: "bell_event",
    targetId: changed.eventId,
    detail: { cue: changed.cueName, localDate, from: changed.from, to: changed.to },
  });
  refreshToday();
  return {
    ok: true,
    message: kind === "SKIP"
      ? `${changed.cueName} will be skipped.`
      : `${changed.cueName} moved to ${changed.to}.`,
  };
}

export async function clearTodayBellOverride(overrideId: number): Promise<TodayActionResult> {
  const admin = await requireAdmin();
  if (!Number.isInteger(overrideId) || overrideId <= 0) return { ok: false, error: "Invalid bell change." };

  const now = Date.now();
  const localDate = todayAt(now);
  const override = db
    .select({
      id: schema.bellEventOverrides.id,
      localDate: schema.bellEventOverrides.localDate,
      bellEventId: schema.bellEventOverrides.bellEventId,
      kind: schema.bellEventOverrides.kind,
      effectiveTime: schema.bellEventOverrides.effectiveTime,
      originalTime: schema.bellEvents.time,
      cueName: schema.soundCues.name,
    })
    .from(schema.bellEventOverrides)
    .innerJoin(schema.bellEvents, eq(schema.bellEventOverrides.bellEventId, schema.bellEvents.id))
    .innerJoin(schema.soundCues, eq(schema.bellEvents.cueId, schema.soundCues.id))
    .where(eq(schema.bellEventOverrides.id, overrideId))
    .get();
  if (!override || override.localDate !== localDate) return { ok: false, error: "That change is no longer active today." };

  const activeTime = override.kind === "DELAY" ? override.effectiveTime : override.originalTime;
  const activeAt = DateTime.fromISO(`${localDate}T${activeTime}`, { zone: env.schoolTz }).toMillis();
  if (activeAt - now <= CHANGE_SAFETY_MS) {
    return { ok: false, error: "That bell is already starting or has passed, so the change cannot be undone." };
  }
  // Undoing a delay after the ORIGINAL time has passed would ring the bell at
  // neither time: the delayed run is deleted, and re-materializing cannot
  // recreate a bell in the past. Refuse rather than silently dropping it.
  if (override.kind === "DELAY") {
    const originalAt = DateTime.fromISO(`${localDate}T${override.originalTime}`, { zone: env.schoolTz }).toMillis();
    if (originalAt - now <= CHANGE_SAFETY_MS) {
      return {
        ok: false,
        error: `Its original time (${override.originalTime}) has already passed — the delayed bell is the only one left. Skip it if it should not ring.`,
      };
    }
  }

  const tx = sqlite.transaction(() => {
    db.delete(schema.bellEventOverrides).where(eq(schema.bellEventOverrides.id, override.id)).run();
    db.delete(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.source, "SCHEDULE"),
          eq(schema.scheduledRuns.status, "PENDING"),
          eq(schema.scheduledRuns.localDate, localDate),
          eq(schema.scheduledRuns.bellEventId, override.bellEventId),
        ),
      )
      .run();
  });
  tx.immediate();

  writeAudit({
    userId: admin.id,
    action: "schedule.undo_day_change",
    targetType: "bell_event",
    targetId: override.bellEventId,
    detail: { cue: override.cueName, localDate, kind: override.kind },
  });
  refreshToday();
  return { ok: true, message: `The change to ${override.cueName} was undone.` };
}

/** Switch only the remaining part of today; materialization never recreates past bells. */
export async function setTodayPlan(planId: number | null): Promise<TodayActionResult> {
  const admin = await requireAdmin();
  const now = Date.now();
  const localDate = todayAt(now);

  let planName = "the weekly schedule";
  if (planId !== null) {
    if (!Number.isInteger(planId) || planId <= 0) return { ok: false, error: "Choose a valid bell plan." };
    const plan = db
      .select({ name: schema.bellPlans.name })
      .from(schema.bellPlans)
      .where(and(eq(schema.bellPlans.id, planId), eq(schema.bellPlans.isArchived, false)))
      .get();
    if (!plan) return { ok: false, error: "That bell plan is not available." };
    planName = plan.name;
  }

  const next = db
    .select({ at: schema.scheduledRuns.scheduledAtUtc })
    .from(schema.scheduledRuns)
    .where(
      and(
        eq(schema.scheduledRuns.source, "SCHEDULE"),
        eq(schema.scheduledRuns.status, "PENDING"),
        eq(schema.scheduledRuns.localDate, localDate),
        gt(schema.scheduledRuns.scheduledAtUtc, now),
      ),
    )
    .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
    .limit(1)
    .get();
  if (next && next.at - now <= CHANGE_SAFETY_MS) {
    return { ok: false, error: "A bell is already starting. Try again after it finishes." };
  }

  const previous = db
    .select()
    .from(schema.calendarExceptions)
    .where(eq(schema.calendarExceptions.date, localDate))
    .get();
  const tx = sqlite.transaction(() => {
    if (planId === null) {
      db.delete(schema.calendarExceptions).where(eq(schema.calendarExceptions.date, localDate)).run();
    } else {
      db.insert(schema.calendarExceptions)
        .values({
          date: localDate,
          type: "USE_PLAN",
          bellPlanId: planId,
          note: "Day-of schedule change",
          createdBy: admin.id,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: schema.calendarExceptions.date,
          set: {
            type: "USE_PLAN",
            bellPlanId: planId,
            note: "Day-of schedule change",
            createdBy: admin.id,
            createdAt: now,
          },
        })
        .run();
    }
    // Close the worker race before rebuilding from the new effective plan.
    db.delete(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.source, "SCHEDULE"),
          eq(schema.scheduledRuns.status, "PENDING"),
          eq(schema.scheduledRuns.localDate, localDate),
        ),
      )
      .run();
  });
  tx.immediate();

  writeAudit({
    userId: admin.id,
    action: planId === null ? "schedule.today_reset" : "schedule.today_plan",
    detail: {
      localDate,
      planId,
      planName,
      previous: previous ? { type: previous.type, planId: previous.bellPlanId, note: previous.note } : null,
    },
  });
  refreshToday();
  return { ok: true, message: `The rest of today now uses ${planName}.` };
}
