import { beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { materialize } from "@/lib/scheduler/materializer";
import { getTodaySchedule } from "@/lib/today";
import { updateSystemState } from "@/lib/state";
import { assignAllWeekdays, seedEvent, seedPlan, seedSpeaker, seedWebhookCue } from "./helpers";

const NOW = DateTime.fromISO("2027-03-08T06:00", { zone: "America/Chicago" });
const TODAY = "2027-03-08";

function seedReadyDay() {
  const cueId = seedWebhookCue("Class change", "bell.class-change");
  const planId = seedPlan("Normal School Day");
  const firstEventId = seedEvent(planId, "08:00", cueId, "First bell");
  const secondEventId = seedEvent(planId, "09:00", cueId, "Period two");
  assignAllWeekdays(planId);
  seedSpeaker("AA1111111111", "Main Hall");
  materialize(NOW);
  updateSystemState({
    workerHeartbeatAt: NOW.toMillis(),
    workerStartedAt: NOW.minus({ minutes: 5 }).toMillis(),
    lastHealthOkAt: NOW.toMillis(),
    lastHealthError: null,
    consecutiveHealthFailures: 0,
  });
  return { cueId, planId, firstEventId, secondEventId };
}

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  db.delete(schema.bellEventOverrides).run();
  db.delete(schema.calendarExceptions).run();
  db.delete(schema.weekSchedule).run();
  db.delete(schema.bellEvents).run();
  db.delete(schema.bellPlans).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.speakers).run();
  updateSystemState({
    workerHeartbeatAt: null,
    workerStartedAt: null,
    lastHealthOkAt: null,
    lastHealthError: null,
    consecutiveHealthFailures: 0,
    lastMaterializedThrough: null,
    apiKeyExpiresAt: null,
    ttsRevalidateFlag: false,
  });
});

describe("today schedule", () => {
  it("summarizes a healthy day and identifies the next bell", () => {
    seedReadyDay();

    const today = getTodaySchedule(NOW.toMillis());

    expect(today.readiness.tone).toBe("ready");
    expect(today.readiness.title).toBe("Today is ready");
    expect(today.plan?.name).toBe("Normal School Day");
    expect(today.timeline).toHaveLength(2);
    expect(today.next?.label).toBe("First bell");
    expect(today.next?.effectiveTime).toBe("08:00");
  });

  it("surfaces a stale scheduler heartbeat in staff language", () => {
    seedReadyDay();
    updateSystemState({ workerHeartbeatAt: NOW.minus({ minutes: 2 }).toMillis() });

    const today = getTodaySchedule(NOW.toMillis());

    expect(today.readiness.tone).toBe("attention");
    expect(today.readiness.title).toBe("Scheduled bells need support");
    expect(today.readiness.detail).toContain("automatic bell scheduler");
  });

  it("keeps a skipped bell skipped across schedule regeneration", () => {
    const { firstEventId } = seedReadyDay();
    db.insert(schema.bellEventOverrides)
      .values({
        localDate: TODAY,
        bellEventId: firstEventId,
        kind: "SKIP",
        createdAt: NOW.toMillis(),
        updatedAt: NOW.toMillis(),
      })
      .run();

    materialize(NOW);
    materialize(NOW);

    const firstRuns = db
      .select()
      .from(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.localDate, TODAY),
          eq(schema.scheduledRuns.bellEventId, firstEventId),
        ),
      )
      .all();
    expect(firstRuns).toHaveLength(0);
    expect(getTodaySchedule(NOW.toMillis()).timeline[0].status).toBe("SKIPPED_BY_STAFF");
  });

  it("materializes a delayed bell at its one-day effective time", () => {
    const { firstEventId } = seedReadyDay();
    db.insert(schema.bellEventOverrides)
      .values({
        localDate: TODAY,
        bellEventId: firstEventId,
        kind: "DELAY",
        effectiveTime: "08:10",
        createdAt: NOW.toMillis(),
        updatedAt: NOW.toMillis(),
      })
      .run();

    materialize(NOW);

    const firstRun = db
      .select()
      .from(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.localDate, TODAY),
          eq(schema.scheduledRuns.bellEventId, firstEventId),
        ),
      )
      .get();
    expect(firstRun?.localTime).toBe("08:10");
    const first = getTodaySchedule(NOW.toMillis()).timeline[0];
    expect(first.originalTime).toBe("08:00");
    expect(first.effectiveTime).toBe("08:10");
    expect(first.override?.kind).toBe("DELAY");
  });

  it("treats an explicit no-school exception as intentional", () => {
    seedReadyDay();
    db.insert(schema.calendarExceptions)
      .values({
        date: TODAY,
        type: "NO_SCHOOL",
        note: "Spring break",
        createdAt: NOW.toMillis(),
      })
      .run();
    materialize(NOW);

    const today = getTodaySchedule(NOW.toMillis());

    expect(today.readiness.tone).toBe("quiet");
    expect(today.readiness.title).toBe("No bells scheduled today");
    expect(today.readiness.detail).toBe("Spring break");
    expect(today.timeline).toHaveLength(0);
  });
});
