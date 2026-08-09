/**
 * Verifies emergency priority against the real speaker (AUDIBLE).
 * Plays a routine sound, then fires an emergency into the middle of it.
 *
 * Usage: npx tsx scripts/priority-verify.ts
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { getSystemState, updateSystemState } from "@/lib/state";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { startAlert, stopAlert } from "@/lib/alerts";

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  updateSystemState({ speakerBusyUntil: null });
  const user = db.select().from(schema.users).limit(1).get()!;
  const routine = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEmergency, false), eq(schema.soundCues.isEnabled, true)))
    .get();
  const emergency = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEmergency, true), eq(schema.soundCues.isEnabled, true)))
    .get();
  if (!routine || !emergency) {
    step("need one routine and one emergency sound", false);
    return;
  }

  // 1. A routine cue starts and takes the speaker lock.
  console.log(`Playing routine "${routine.name}"…`);
  const first = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    cue: routine,
    ...localDateTimeParts(),
  });
  step("routine sound played", first.outcome.status === "SUCCESS");
  const heldUntil = getSystemState().speakerBusyUntil ?? 0;
  step("it holds the speaker", heldUntil > Date.now(), `${Math.round((heldUntil - Date.now()) / 1000)}s left`);

  // 2. An emergency fires while that lock is still held.
  console.log(`Firing emergency "${emergency.name}" into the middle of it…`);
  const second = await triggerManualRun(realAdapter, {
    source: "EMERGENCY",
    requestedBy: user.id,
    cue: emergency,
    ...localDateTimeParts(),
  });
  step(
    "emergency preempted the lock",
    second.outcome.status === "SUCCESS",
    `${second.outcome.status}${second.outcome.message ? ` — ${second.outcome.message}` : ""}`,
  );

  // 3. Routine playback is refused while an alert is repeating.
  startAlert({ cueId: emergency.id, userId: user.id, maxMinutes: 1 });
  const blocked = blockedByActiveAlert();
  step("routine playback blocked during an alert", blocked !== null, blocked?.message ?? "");
  stopAlert(user.id);
  step("unblocked once stopped", blockedByActiveAlert() === null);

  updateSystemState({ speakerBusyUntil: null });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
