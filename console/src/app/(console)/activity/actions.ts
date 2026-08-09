"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireEmergency, requireUser } from "@/lib/auth/guards";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";

export interface RetriggerResult {
  ok: boolean;
  status: string;
  message?: string;
}

/** Manually replay a run whose delivery failed or was uncertain. */
export async function retriggerRun(runId: number): Promise<RetriggerResult> {
  let user = await requireUser();
  const run = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, runId)).get();
  if (!run) return { ok: false, status: "FAILED", message: "Run not found." };
  if (run.source === "EMERGENCY") user = await requireEmergency();
  if (run.status !== "DELIVERY_UNCERTAIN" && run.status !== "FAILED") {
    return { ok: false, status: "FAILED", message: `Run is ${run.status} — only failed or uncertain runs can be re-triggered.` };
  }
  const { outcome } = await triggerManualRun(realAdapter, {
    source: run.source === "EMERGENCY" ? "EMERGENCY" : "MANUAL",
    requestedBy: user.id,
    copyOf: run,
    ...localDateTimeParts(),
  });
  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}
