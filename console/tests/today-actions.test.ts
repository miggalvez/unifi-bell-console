import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { materialize } from "@/lib/scheduler/materializer";
import { assignAllWeekdays, seedEvent, seedPlan, seedUser, seedWebhookCue } from "./helpers";
import {
  changeNextBell,
  clearTodayBellOverride,
  setTodayPlan,
} from "@/app/(console)/today-actions";

let userId: number;

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: userId, role: "ADMIN", displayName: "Tester" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const NOW = DateTime.fromISO("2027-03-08T06:00", { zone: "America/Chicago" });
const TODAY = "2027-03-08";

function seedDay(secondTime = "09:00") {
  userId = seedUser();
  const cueId = seedWebhookCue("Class change", "bell.class-change");
  const planId = seedPlan("Normal School Day");
  const firstEventId = seedEvent(planId, "08:00", cueId, "First bell");
  seedEvent(planId, secondTime, cueId, "Second bell");
  assignAllWeekdays(planId);
  materialize(NOW);
  return { cueId, planId, firstEventId };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW.toJSDate());
  db.delete(schema.auditLog).run();
  db.delete(schema.scheduledRuns).run();
  db.delete(schema.bellEventOverrides).run();
  db.delete(schema.calendarExceptions).run();
  db.delete(schema.weekSchedule).run();
  db.delete(schema.bellEvents).run();
  db.delete(schema.bellPlans).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.speakers).run();
  db.delete(schema.users).run();
});

afterEach(() => vi.useRealTimers());

describe("today actions", () => {
  it("delays the next bell and can undo the delay", async () => {
    const { firstEventId } = seedDay();

    const delayed = await changeNextBell("DELAY", 5);

    expect(delayed.ok).toBe(true);
    const override = db
      .select()
      .from(schema.bellEventOverrides)
      .where(eq(schema.bellEventOverrides.bellEventId, firstEventId))
      .get()!;
    expect(override.kind).toBe("DELAY");
    expect(override.effectiveTime).toBe("08:05");
    expect(
      db
        .select()
        .from(schema.scheduledRuns)
        .where(
          and(
            eq(schema.scheduledRuns.localDate, TODAY),
            eq(schema.scheduledRuns.bellEventId, firstEventId),
          ),
        )
        .get()?.localTime,
    ).toBe("08:05");

    const undone = await clearTodayBellOverride(override.id);

    expect(undone.ok).toBe(true);
    expect(db.select().from(schema.bellEventOverrides).all()).toHaveLength(0);
    expect(
      db
        .select()
        .from(schema.scheduledRuns)
        .where(eq(schema.scheduledRuns.bellEventId, firstEventId))
        .get()?.localTime,
    ).toBe("08:00");
  });

  it("persists a staff skip instead of leaving a pending run", async () => {
    const { firstEventId } = seedDay();

    const skipped = await changeNextBell("SKIP");

    expect(skipped.ok).toBe(true);
    expect(
      db
        .select()
        .from(schema.bellEventOverrides)
        .where(eq(schema.bellEventOverrides.bellEventId, firstEventId))
        .get()?.kind,
    ).toBe("SKIP");
    expect(
      db
        .select()
        .from(schema.scheduledRuns)
        .where(
          and(
            eq(schema.scheduledRuns.localDate, TODAY),
            eq(schema.scheduledRuns.bellEventId, firstEventId),
          ),
        )
        .all(),
    ).toHaveLength(0);
    expect(db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "schedule.skip_next")).get()).toBeTruthy();
  });

  it("refuses a delay that would overlap the following bell", async () => {
    seedDay("08:03");

    const result = await changeNextBell("DELAY", 5);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("overlap");
    expect(db.select().from(schema.bellEventOverrides).all()).toHaveLength(0);
  });

  it("switches only today's effective plan and audits the change", async () => {
    const { cueId } = seedDay();
    const earlyPlanId = seedPlan("Early Release Day");
    seedEvent(earlyPlanId, "08:30", cueId, "Delayed opening");

    const result = await setTodayPlan(earlyPlanId);

    expect(result.ok).toBe(true);
    const exception = db
      .select()
      .from(schema.calendarExceptions)
      .where(eq(schema.calendarExceptions.date, TODAY))
      .get();
    expect(exception?.bellPlanId).toBe(earlyPlanId);
    const pending = db
      .select()
      .from(schema.scheduledRuns)
      .where(and(eq(schema.scheduledRuns.localDate, TODAY), eq(schema.scheduledRuns.status, "PENDING")))
      .all();
    expect(pending.map((run) => run.localTime)).toEqual(["08:30"]);
    expect(db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "schedule.today_plan")).get()).toBeTruthy();
  });

  it("refuses to undo a delay once the original time has passed", async () => {
    const { firstEventId } = seedDay();

    // Delay the 08:00 bell to 08:10, then try to undo at 08:05: the original
    // moment is gone, so undoing would ring the bell at neither time.
    const delayed = await changeNextBell("DELAY", 10);
    expect(delayed.ok).toBe(true);
    vi.setSystemTime(NOW.set({ hour: 8, minute: 5 }).toJSDate());

    const override = db
      .select()
      .from(schema.bellEventOverrides)
      .where(eq(schema.bellEventOverrides.bellEventId, firstEventId))
      .get()!;
    const undone = await clearTodayBellOverride(override.id);

    expect(undone.ok).toBe(false);
    expect(undone.error).toMatch(/original time.*passed/i);
    expect(undone.error).toMatch(/skip it/i);
    // The delayed run is untouched and will still ring at 08:10.
    const run = db
      .select()
      .from(schema.scheduledRuns)
      .where(eq(schema.scheduledRuns.bellEventId, firstEventId))
      .get()!;
    expect(run.status).toBe("PENDING");
    expect(run.localTime).toBe("08:10");
  });
});
