/**
 * Transactional claim of due runs. BEGIN IMMEDIATE takes SQLite's write lock
 * up front so a run can never be claimed twice — even if a second worker is
 * ever started by accident, and across the web/worker process split.
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { db, schema, sqlite } from "@/lib/db/client";
import { getSettingNumber, getSystemState, isPaused } from "@/lib/state";
import { writeAudit } from "@/lib/audit";

export type ClaimDecision =
  | { kind: "none" }
  | { kind: "execute"; runId: number }
  | { kind: "missed"; runId: number }
  | { kind: "skipped_paused"; runId: number };

export function claimNextDueRun(now = Date.now()): ClaimDecision {
  const claimTx = sqlite.transaction(() => {
    const row = db
      .select({
        id: schema.scheduledRuns.id,
        scheduledAtUtc: schema.scheduledRuns.scheduledAtUtc,
        source: schema.scheduledRuns.source,
        cueName: schema.scheduledRuns.cueName,
      })
      .from(schema.scheduledRuns)
      .where(and(eq(schema.scheduledRuns.status, "PENDING"), lte(schema.scheduledRuns.scheduledAtUtc, now)))
      .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
      .limit(1)
      .get();
    if (!row) return null;
    db.update(schema.scheduledRuns)
      .set({ status: "CLAIMED", claimedAt: now })
      .where(and(eq(schema.scheduledRuns.id, row.id), eq(schema.scheduledRuns.status, "PENDING")))
      .run();
    return row;
  });

  const row = claimTx.immediate();
  if (!row) return { kind: "none" };

  const graceMs = getSettingNumber("missedGraceMinutes", 2) * 60_000;
  const lateMs = now - row.scheduledAtUtc;
  if (lateMs > graceMs) {
    // Catch-up policy: a bell that is too late must never play — a 10:35
    // period bell at 10:41 causes chaos, not order.
    db.update(schema.scheduledRuns)
      .set({
        status: "MISSED",
        executedAt: now,
        resultMessage: `claimed ${Math.round(lateMs / 1000)}s late (grace ${Math.round(graceMs / 1000)}s) — worker down?`,
      })
      .where(eq(schema.scheduledRuns.id, row.id))
      .run();
    writeAudit({ action: "bell.missed", targetType: "run", targetId: row.id, detail: { cue: row.cueName, lateMs } });
    return { kind: "missed", runId: row.id };
  }

  const state = getSystemState();

  // A class bell in the middle of a lockdown alert would be actively
  // dangerous — it reads as "all clear" to anyone who hears it. Scheduled
  // bells stand down for the duration.
  if (row.source === "SCHEDULE" && state.alertCueId !== null && (state.alertUntil ?? 0) > now) {
    db.update(schema.scheduledRuns)
      .set({
        status: "SKIPPED_PAUSED",
        executedAt: now,
        resultMessage: "skipped — an emergency alert was sounding",
      })
      .where(eq(schema.scheduledRuns.id, row.id))
      .run();
    writeAudit({
      action: "bell.skipped_alert",
      targetType: "run",
      targetId: row.id,
      isEmergency: true,
      detail: { cue: row.cueName },
    });
    return { kind: "skipped_paused", runId: row.id };
  }

  // Same reasoning for a drill: a period bell landing between drill steps
  // makes the drill ambiguous to everyone hearing it.
  if (row.source === "SCHEDULE" && state.drillSequenceId !== null && (state.drillUntil ?? 0) > now) {
    db.update(schema.scheduledRuns)
      .set({
        status: "SKIPPED_PAUSED",
        executedAt: now,
        resultMessage: "skipped — a drill was running",
      })
      .where(eq(schema.scheduledRuns.id, row.id))
      .run();
    writeAudit({
      action: "bell.skipped_drill",
      targetType: "run",
      targetId: row.id,
      detail: { cue: row.cueName },
    });
    return { kind: "skipped_paused", runId: row.id };
  }

  if (row.source === "SCHEDULE" && isPaused(state, now)) {
    db.update(schema.scheduledRuns)
      .set({ status: "SKIPPED_PAUSED", executedAt: now, resultMessage: state.pauseReason ?? "schedule paused" })
      .where(eq(schema.scheduledRuns.id, row.id))
      .run();
    writeAudit({
      action: "bell.skipped_paused",
      targetType: "run",
      targetId: row.id,
      detail: { cue: row.cueName, reason: state.pauseReason },
    });
    return { kind: "skipped_paused", runId: row.id };
  }

  return { kind: "execute", runId: row.id };
}
