import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { deletePlan, renamePlan } from "@/app/(console)/plans/actions";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { assignAllWeekdays, seedEvent, seedPlan, seedUser, seedWebhookCue } from "./helpers";

let userId: number;

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: userId, role: "ADMIN", displayName: "Tester" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  db.delete(schema.calendarExceptions).run();
  db.delete(schema.weekSchedule).run();
  db.delete(schema.bellEvents).run();
  db.delete(schema.bellPlans).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.auditLog).run();
  db.delete(schema.users).run();
  userId = seedUser();
});

describe("deleting a bell plan", () => {
  it("refuses while the weekly schedule still uses it", async () => {
    const cueId = seedWebhookCue();
    const planId = seedPlan("Rings Weekly");
    seedEvent(planId, "08:00", cueId);
    assignAllWeekdays(planId);

    const r = await deletePlan(planId);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/still rings on the weekly schedule/i);
    expect(db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, planId)).get()).toBeTruthy();
  });

  it("refuses while upcoming calendar dates still use it", async () => {
    const planId = seedPlan("Special Day");
    const { localDate: today } = localDateTimeParts();
    db.insert(schema.calendarExceptions)
      .values({ date: today, type: "USE_PLAN", bellPlanId: planId, createdAt: Date.now() })
      .run();

    const r = await deletePlan(planId);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/upcoming date/i);
  });

  it("deletes an unused plan, purges its queued bells, and keeps rung history", async () => {
    const cueId = seedWebhookCue();
    const planId = seedPlan("Retired Plan");
    const eventId = seedEvent(planId, "08:00", cueId, "First bell");

    const now = Date.now();
    const base = {
      source: "SCHEDULE" as const,
      deliveryMethod: "PROTECT_WEBHOOK" as const,
      webhookId: "bell.test",
      bellEventId: eventId,
      cueName: "First bell",
      localDate: "2027-01-01",
      localTime: "08:00",
      createdAt: now,
    };
    const pending = db
      .insert(schema.scheduledRuns)
      .values({ ...base, scheduledAtUtc: now + 86_400_000, status: "PENDING" })
      .returning({ id: schema.scheduledRuns.id })
      .get();
    const rung = db
      .insert(schema.scheduledRuns)
      .values({ ...base, scheduledAtUtc: now - 86_400_000, status: "SUCCESS", executedAt: now - 86_400_000 })
      .returning({ id: schema.scheduledRuns.id })
      .get();
    // A past exception referencing the plan may cascade away — it is definition,
    // not history.
    db.insert(schema.calendarExceptions)
      .values({ date: "2020-01-01", type: "USE_PLAN", bellPlanId: planId, createdAt: now })
      .run();

    const r = await deletePlan(planId);
    expect(r.ok).toBe(true);

    expect(db.select().from(schema.bellPlans).all()).toHaveLength(0);
    expect(db.select().from(schema.bellEvents).all()).toHaveLength(0);
    // The queued bell died with the plan — no orphan will ring.
    expect(db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, pending.id)).get()).toBeUndefined();
    // The rung bell survives with its snapshot, its event link nulled.
    const history = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, rung.id)).get()!;
    expect(history.cueName).toBe("First bell");
    expect(history.bellEventId).toBeNull();
    // The audit trail records what was removed.
    const audit = db.select().from(schema.auditLog).all().at(-1)!;
    expect(audit.action).toBe("plan.delete");
  });
});

describe("renaming a bell plan", () => {
  it("saves the trimmed name and records who changed it", async () => {
    const planId = seedPlan("Nomral Day");

    const r = await renamePlan(planId, "  Normal Day  ");
    expect(r.ok).toBe(true);

    const plan = db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, planId)).get()!;
    expect(plan.name).toBe("Normal Day");
    const audit = db.select().from(schema.auditLog).all().at(-1)!;
    expect(audit.action).toBe("plan.rename");
    expect(JSON.parse(audit.detail!)).toMatchObject({ from: "Nomral Day", to: "Normal Day" });
  });

  it("rejects a blank name and one already taken", async () => {
    const planId = seedPlan("Normal Day");
    seedPlan("Half Day");

    const blank = await renamePlan(planId, "   ");
    expect(blank.ok).toBe(false);
    expect(blank.error).toMatch(/required/i);

    const taken = await renamePlan(planId, "Half Day");
    expect(taken.ok).toBe(false);
    expect(taken.error).toMatch(/exists/i);

    expect(db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, planId)).get()!.name).toBe("Normal Day");
  });

  it("keeps the bells and the schedule pointing at the same plan", async () => {
    const cueId = seedWebhookCue();
    const planId = seedPlan("Old Name");
    seedEvent(planId, "08:00", cueId, "First bell");
    assignAllWeekdays(planId);

    expect((await renamePlan(planId, "New Name")).ok).toBe(true);

    expect(db.select().from(schema.bellEvents).where(eq(schema.bellEvents.bellPlanId, planId)).all()).toHaveLength(1);
    expect(
      db.select().from(schema.weekSchedule).where(eq(schema.weekSchedule.bellPlanId, planId)).all().length,
    ).toBeGreaterThan(0);
  });
});
