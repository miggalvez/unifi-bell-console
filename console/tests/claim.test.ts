import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { claimNextDueRun } from "@/lib/scheduler/claim";
import { updateSystemState } from "@/lib/state";

let seq = 0;
function insertPending(offsetMs: number, source: "SCHEDULE" | "MANUAL" | "EMERGENCY" = "SCHEDULE"): number {
  const now = Date.now();
  return db
    .insert(schema.scheduledRuns)
    .values({
      source,
      deliveryMethod: "PROTECT_WEBHOOK",
      webhookId: "bell.test",
      cueName: `Bell ${seq++}`,
      scheduledAtUtc: now + offsetMs,
      localDate: "2027-01-01",
      localTime: "08:00",
      status: "PENDING",
      createdAt: now,
    })
    .returning({ id: schema.scheduledRuns.id })
    .get().id;
}

function statusOf(id: number): string {
  return db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, id)).get()!.status;
}

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  updateSystemState({ pausedUntil: null, pauseReason: null });
});

describe("claimNextDueRun", () => {
  it("claims a due run exactly once", () => {
    const id = insertPending(-1000);
    const first = claimNextDueRun();
    expect(first).toEqual({ kind: "execute", runId: id });
    expect(statusOf(id)).toBe("CLAIMED");
    expect(claimNextDueRun().kind).toBe("none");
  });

  it("ignores future runs", () => {
    insertPending(60_000);
    expect(claimNextDueRun().kind).toBe("none");
  });

  it("drains in scheduled order", () => {
    const later = insertPending(-1000);
    const earlier = insertPending(-5000);
    const first = claimNextDueRun();
    const second = claimNextDueRun();
    expect(first).toEqual({ kind: "execute", runId: earlier });
    expect(second).toEqual({ kind: "execute", runId: later });
  });

  it("marks runs beyond the grace window MISSED without executing", () => {
    const id = insertPending(-10 * 60_000); // 10 min late, default grace 2 min
    const decision = claimNextDueRun();
    expect(decision).toEqual({ kind: "missed", runId: id });
    expect(statusOf(id)).toBe("MISSED");
  });

  it("skips scheduled runs while paused, recording SKIPPED_PAUSED", () => {
    updateSystemState({ pausedUntil: Date.now() + 60 * 60_000, pauseReason: "testing pause" });
    const id = insertPending(-1000);
    const decision = claimNextDueRun();
    expect(decision).toEqual({ kind: "skipped_paused", runId: id });
    const row = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, id)).get()!;
    expect(row.status).toBe("SKIPPED_PAUSED");
    expect(row.resultMessage).toBe("testing pause");
  });

  it("lets EMERGENCY runs through a pause", () => {
    updateSystemState({ pausedUntil: Date.now() + 60 * 60_000, pauseReason: "testing pause" });
    const id = insertPending(-1000, "EMERGENCY");
    expect(claimNextDueRun()).toEqual({ kind: "execute", runId: id });
  });

  it("treats an expired pause as unpaused", () => {
    updateSystemState({ pausedUntil: Date.now() - 1000, pauseReason: "old pause" });
    const id = insertPending(-1000);
    expect(claimNextDueRun()).toEqual({ kind: "execute", runId: id });
  });
});
