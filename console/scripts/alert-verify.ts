/**
 * Verifies repeating emergency alerts against the real speaker (AUDIBLE).
 * Runs the same worker tick the console uses, then stops the alert.
 *
 * Usage: npx tsx scripts/alert-verify.ts
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { realAdapter } from "@/lib/protect/adapter";
import { readAlertState, startAlert, stopAlert, tickAlert, minimumRepeatSeconds } from "@/lib/alerts";
import { updateSystemState } from "@/lib/state";

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  updateSystemState({ speakerBusyUntil: null });
  const user = db.select().from(schema.users).limit(1).get()!;
  const cue = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEmergency, true), eq(schema.soundCues.isEnabled, true)))
    .get();
  if (!cue) {
    step("emergency cue exists", false, "create one on the Sounds page first");
    return;
  }

  const repeat = minimumRepeatSeconds(cue);
  console.log(`Using "${cue.name}", repeating every ${repeat}s. Expect it twice.\n`);
  startAlert({ cueId: cue.id, userId: user.id, repeatSeconds: repeat, maxMinutes: 2 });
  step("alert started", readAlertState().active, `by ${readAlertState().startedByName}`);

  step("first repetition", (await tickAlert(realAdapter)) === "played");

  // A tick during the gap must not double up.
  step("does not overlap during the gap", (await tickAlert(realAdapter)) === "waiting");

  console.log(`  waiting ${repeat}s for the next repetition…`);
  await sleep(repeat * 1000 + 500);
  step("second repetition", (await tickAlert(realAdapter)) === "played");

  stopAlert(user.id);
  step("stopped", !readAlertState().active);
  step("silent after stopping", (await tickAlert(realAdapter)) === "idle");

  const runs = db
    .select()
    .from(schema.scheduledRuns)
    .where(eq(schema.scheduledRuns.source, "EMERGENCY"))
    .all();
  console.log(`\n${runs.length} emergency run(s) recorded in Activity.`);
  updateSystemState({ speakerBusyUntil: null });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
