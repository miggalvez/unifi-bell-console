/**
 * Watches a real drill sequence run end to end on the real speaker (AUDIBLE).
 *
 * This script does NOT tick the drill itself — the worker does that, once a
 * second, and two tickers racing on the same state machine is exactly the bug
 * an earlier version of this script had. It starts a temporary drill and then
 * only observes, which also makes it a genuine test of the worker loop.
 *
 * Requires the worker to be running (`npm run dev`, or start:worker).
 *
 * Checks: the drill tag brackets every sound (before AND after, including each
 * repetition), a repeating step really repeats, the pause is silent, a real
 * alert aborts the rest, and nothing is left behind.
 *
 * Usage: npx tsx scripts/drill-verify.ts
 */
import { and, asc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { updateSystemState } from "@/lib/state";
import { startAlert, stopAlert } from "@/lib/alerts";
import { effectiveSteps, readDrillState, startDrill, stopDrill } from "@/lib/drills";

const WAIT_SECONDS = 20;
const REPEAT_FOR = 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  updateSystemState({ speakerBusyUntil: null });
  stopDrill(null, "verification script starting from a clean slate");
  stopAlert(null);

  const user = db.select().from(schema.users).limit(1).get()!;
  const cues = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEnabled, true), eq(schema.soundCues.isEmergency, false)))
    .all()
    .filter((c) => c.name !== "Drill preamble");
  if (cues.length === 0) {
    step("need at least one ordinary sound to drill with", false);
    return;
  }
  const emergency = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEmergency, true), eq(schema.soundCues.isEnabled, true)))
    .get();

  const startedAt = Date.now();
  const seqId = db
    .insert(schema.drillSequences)
    .values({
      name: `Verification drill ${startedAt}`,
      description: "Created by scripts/drill-verify.ts",
      createdBy: user.id,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .returning({ id: schema.drillSequences.id })
    .get().id;
  [
    // A repeating "alarm" phase, the way a real lockdown alert behaves.
    {
      kind: "PLAY" as const,
      cueId: cues[0].id,
      waitSeconds: null,
      repeatForSeconds: REPEAT_FOR,
    },
    { kind: "WAIT" as const, cueId: null, waitSeconds: WAIT_SECONDS, repeatForSeconds: null },
    {
      kind: "PLAY" as const,
      cueId: cues[Math.min(1, cues.length - 1)].id,
      waitSeconds: null,
      repeatForSeconds: null,
    },
  ].forEach((s, i) =>
    db.insert(schema.drillSteps).values({ sequenceId: seqId, position: i, ...s, createdAt: startedAt }).run(),
  );

  // Baseline: the table keeps drill history from previous verification runs,
  // so everything below counts only rows newer than this.
  const lastRunId =
    db.select({ id: schema.scheduledRuns.id }).from(schema.scheduledRuns).orderBy(asc(schema.scheduledRuns.id)).all().at(-1)
      ?.id ?? 0;

  /** Runs this drill has produced, oldest first. */
  const runs = () =>
    db
      .select({ id: schema.scheduledRuns.id, cueName: schema.scheduledRuns.cueName, status: schema.scheduledRuns.status })
      .from(schema.scheduledRuns)
      .where(and(eq(schema.scheduledRuns.source, "DRILL"), gt(schema.scheduledRuns.id, lastRunId)))
      .orderBy(asc(schema.scheduledRuns.id))
      .all();

  /** Polls until `done`, logging step changes the worker makes. */
  async function watch(done: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastStep = -1;
    while (Date.now() < deadline) {
      const s = readDrillState();
      if (s.stepIndex !== null && s.stepIndex !== lastStep) {
        lastStep = s.stepIndex;
        console.log(`  worker advanced to step ${s.stepIndex + 1}/${s.totalSteps} (next: ${s.currentStepLabel ?? "—"})`);
      }
      if (done()) return true;
      await sleep(500);
    }
    console.log(`  timed out waiting for ${label}`);
    return false;
  }

  try {
    const steps = effectiveSteps(seqId)!;
    console.log(`  script: ${steps.map((s) => s.label).join(" → ")}`);
    console.log("  (the drill announcement is added before each sound automatically)");

    step("drill starts", startDrill({ sequenceId: seqId, userId: user.id }).ok);
    console.log("Handing over to the worker — listen for the announcement, then a sound…");

    const isTag = (n?: string | null) => /drill announcement/i.test(n ?? "");
    const names = () => runs().map((r) => r.cueName ?? "");
    const tones = () => names().filter((n) => !isTag(n)).length;

    // Tag, sound, tag.
    const bracketed = await watch(() => runs().length >= 3, 90_000, "the first bracketed sound");
    step("worker played tag → sound → tag", bracketed, names().slice(0, 3).join(" → "));

    // The repeating phase: several tones, each one bracketed.
    console.log(`Watching the sounding phase (${REPEAT_FOR}s)…`);
    const repeated = await watch(() => tones() >= 3, (REPEAT_FOR + 90) * 1000, "the tone to repeat");
    step("the tone repeated rather than playing once", repeated, `${tones()} tones`);

    // Then the pause: genuinely silent for its whole length.
    console.log(`Waiting for the repeat to end, then checking the ${WAIT_SECONDS}s pause is silent…`);
    await watch(() => (readDrillState().stepIndex ?? 0) >= 1, (REPEAT_FOR + 90) * 1000, "the repeat phase to end");

    // Assert bracketing only once the phase is over — sampling mid-cycle would
    // catch a sound whose trailing tag has not gone out yet.
    const list = names();
    const unbracketed = list.filter((n, i) => !isTag(n) && !(isTag(list[i - 1]) && isTag(list[i + 1])));
    step("every sound has the tag on both sides", unbracketed.length === 0, unbracketed.join(", ") || "none bare");
    step(
      "the tag between soundings is shared, not doubled",
      list.filter(isTag).length === tones() + 1,
      `${list.filter(isTag).length} tags / ${tones()} sounds`,
    );

    const beforePause = runs().length;
    await sleep(Math.min(10_000, WAIT_SECONDS * 500));
    step("nothing was sent during the pause", runs().length === beforePause, `${runs().length - beforePause} extra runs`);
    step("the drill is still running", readDrillState().active === true);

    // A real emergency mid-pause must kill the rest of the script, including
    // the all-clear that would otherwise land during a live alert.
    if (emergency) {
      console.log(`Starting a REAL alert ("${emergency.name}") mid-pause…`);
      const beforeAlert = runs().length;
      startAlert({ cueId: emergency.id, userId: user.id, maxMinutes: 1 });
      const aborted = await watch(() => readDrillState().active === false, 15_000, "the worker to abort the drill");
      step("the worker aborted the drill", aborted);

      const abort = db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "drill.abort"))
        .all()
        .at(-1);
      step("the reason was recorded", /real emergency/i.test(abort?.detail ?? ""), abort?.detail ?? "—");

      stopAlert(user.id);
      updateSystemState({ speakerBusyUntil: null });
      // Well past when the all-clear was due.
      await sleep(Math.max(6000, WAIT_SECONDS * 1000 - 8000));
      const drillRuns = runs().filter((r) => !/drill announcement/i.test(r.cueName ?? ""));
      step(
        "the drill's remaining steps never fired",
        runs().length === beforeAlert,
        `${runs().length - beforeAlert} extra runs after the abort (${drillRuns.length} sounds total)`,
      );
    } else {
      console.log("- no emergency sound configured; skipped the abort check");
    }
  } finally {
    stopDrill(null, "verification finished");
    stopAlert(null);
    db.delete(schema.drillSteps).where(eq(schema.drillSteps.sequenceId, seqId)).run();
    db.delete(schema.drillSequences).where(eq(schema.drillSequences.id, seqId)).run();
    updateSystemState({ speakerBusyUntil: null });
    console.log("cleaned up the temporary drill");
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
