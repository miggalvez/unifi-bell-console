import { describe, expect, it, beforeAll } from "vitest";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { materialize } from "@/lib/scheduler/materializer";
import { localToUtcEpoch } from "@/lib/scheduler/time";
import { assignAllWeekdays, seedEvent, seedPlan, seedWebhookCue } from "./helpers";

// Fixed "now" long before the DST dates under test. 2027: spring forward
// Mar 14, fall back Nov 7 (America/Chicago).
const NOW = DateTime.fromISO("2027-03-08T06:00", { zone: "America/Chicago" });

let planId: number;
let cueId: number;
let eventId0800: number;

function runsOn(localDate: string) {
  return db
    .select()
    .from(schema.scheduledRuns)
    .where(eq(schema.scheduledRuns.localDate, localDate))
    .all();
}

beforeAll(() => {
  cueId = seedWebhookCue();
  planId = seedPlan();
  eventId0800 = seedEvent(planId, "08:00", cueId, "Morning Bell");
  seedEvent(planId, "02:30", cueId, "DST Edge Bell");
  assignAllWeekdays(planId);
});

describe("materializer", () => {
  it("materializes the horizon with DST-correct UTC epochs", () => {
    const { inserted, horizonEnd } = materialize(NOW);
    expect(inserted).toBeGreaterThan(0);
    expect(horizonEnd >= "2027-04-01").toBe(true);

    // Before spring-forward: CST (UTC-6) → 08:00 local = 14:00Z
    const before = runsOn("2027-03-12").find((r) => r.localTime === "08:00")!;
    expect(before.scheduledAtUtc).toBe(Date.parse("2027-03-12T14:00:00Z"));

    // After spring-forward: CDT (UTC-5) → 08:00 local = 13:00Z
    const after = runsOn("2027-03-15").find((r) => r.localTime === "08:00")!;
    expect(after.scheduledAtUtc).toBe(Date.parse("2027-03-15T13:00:00Z"));
  });

  it("pins Luxon's nonexistent-time mapping on spring-forward day", () => {
    // 02:30 does not exist on 2027-03-14; Luxon maps it forward into CDT.
    const run = runsOn("2027-03-14").find((r) => r.localTime === "02:30")!;
    expect(run.scheduledAtUtc).toBe(localToUtcEpoch("2027-03-14", "02:30"));
    // Concretely: maps to 03:30-05:00 = 08:30Z
    expect(run.scheduledAtUtc).toBe(Date.parse("2027-03-14T08:30:00Z"));
  });

  it("pins ambiguous fall-back times to the first occurrence", () => {
    const nowFall = DateTime.fromISO("2027-11-01T06:00", { zone: "America/Chicago" });
    db.insert(schema.bellEvents).values({ bellPlanId: planId, time: "01:30", cueId }).run();
    materialize(nowFall);
    const run = runsOn("2027-11-07").find((r) => r.localTime === "01:30")!;
    // First occurrence is CDT (-5): 01:30 local = 06:30Z
    expect(run.scheduledAtUtc).toBe(Date.parse("2027-11-07T06:30:00Z"));
  });

  it("NO_SCHOOL exception removes a day's runs", () => {
    db.insert(schema.calendarExceptions)
      .values({ date: "2027-03-16", type: "NO_SCHOOL", createdAt: Date.now() })
      .run();
    materialize(NOW);
    expect(runsOn("2027-03-16")).toHaveLength(0);
  });

  it("USE_PLAN exception overrides the weekday plan", () => {
    const altCue = seedWebhookCue("Alt Bell", "bell.alt");
    const altPlan = seedPlan("Mass Day");
    seedEvent(altPlan, "10:00", altCue);
    db.insert(schema.calendarExceptions)
      .values({ date: "2027-03-17", type: "USE_PLAN", bellPlanId: altPlan, createdAt: Date.now() })
      .run();
    materialize(NOW);
    const runs = runsOn("2027-03-17");
    expect(runs).toHaveLength(1);
    expect(runs[0].localTime).toBe("10:00");
    expect(runs[0].cueName).toBe("Alt Bell");
  });

  it("is idempotent — two runs produce the identical row set", () => {
    materialize(NOW);
    const first = db.select().from(schema.scheduledRuns).all();
    materialize(NOW);
    const second = db.select().from(schema.scheduledRuns).all();
    expect(second.map((r) => `${r.bellEventId}@${r.scheduledAtUtc}`).sort()).toEqual(
      first.map((r) => `${r.bellEventId}@${r.scheduledAtUtc}`).sort(),
    );
  });

  it("preserves executed history and manual runs across regeneration", () => {
    // Mark one future run as SUCCESS (as if it played), add a manual run.
    const victim = db
      .select()
      .from(schema.scheduledRuns)
      .where(and(eq(schema.scheduledRuns.localDate, "2027-03-12"), eq(schema.scheduledRuns.localTime, "08:00")))
      .get()!;
    db.update(schema.scheduledRuns)
      .set({ status: "SUCCESS", executedAt: Date.now() })
      .where(eq(schema.scheduledRuns.id, victim.id))
      .run();
    const manualId = db
      .insert(schema.scheduledRuns)
      .values({
        source: "MANUAL",
        deliveryMethod: "PROTECT_WEBHOOK",
        webhookId: "bell.manual",
        cueName: "Manual",
        scheduledAtUtc: Date.parse("2027-03-12T15:00:00Z"),
        localDate: "2027-03-12",
        localTime: "09:00",
        status: "SUCCESS",
        createdAt: Date.now(),
      })
      .returning({ id: schema.scheduledRuns.id })
      .get().id;

    materialize(NOW);

    const kept = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, victim.id)).get();
    expect(kept?.status).toBe("SUCCESS");
    const manual = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, manualId)).get();
    expect(manual?.status).toBe("SUCCESS");
    // And no duplicate PENDING row was created for the executed (event, time)
    const dupes = db
      .select()
      .from(schema.scheduledRuns)
      .where(
        and(
          eq(schema.scheduledRuns.bellEventId, eventId0800),
          eq(schema.scheduledRuns.scheduledAtUtc, victim.scheduledAtUtc),
        ),
      )
      .all();
    expect(dupes).toHaveLength(1);
  });

  it("skips times already past on the current day", () => {
    const lateNow = DateTime.fromISO("2027-03-12T09:00", { zone: "America/Chicago" });
    materialize(lateNow);
    const today = runsOn("2027-03-12").filter((r) => r.status === "PENDING");
    // 08:00 and 02:30 are both past 09:00 local — nothing pending today.
    expect(today).toHaveLength(0);
  });
});
