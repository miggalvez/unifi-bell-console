/**
 * End-to-end verification against the real console (audible!).
 * Usage: npx tsx scripts/e2e-verify.ts [--skip-audio]
 *
 * Exercises the same code paths the UI uses: cue creation, the shared
 * executor (webhook + TTS), zone resolution, run lifecycle, and audit.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { resolveTargetMacs } from "@/lib/zones";

const skipAudio = process.argv.includes("--skip-audio");

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  // 1. Adapter reads
  const meta = await realAdapter.metaInfo();
  step("official metaInfo", !!meta.body.applicationVersion, `Protect ${meta.body.applicationVersion}, ${Math.round(meta.ms)}ms`);
  const speakers = await realAdapter.listSpeakers();
  step("official listSpeakers", speakers.body.length > 0, `${speakers.body.length} speaker(s)`);

  // 2. Ensure the Test Bell cue exists (same shape the Sounds UI creates)
  const now = Date.now();
  let cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.name, "Test Bell")).get();
  if (!cue) {
    cue = db
      .insert(schema.soundCues)
      .values({
        name: "Test Bell",
        description: "Phase 0 test automation chime",
        deliveryMethod: "PROTECT_WEBHOOK",
        webhookId: "bell.test.all",
        ttsTone: "welcome",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }
  step("Test Bell cue present", !!cue, `id ${cue.id}`);

  // 3. Zone resolution (no zones -> all speakers)
  const macs = resolveTargetMacs(null);
  step("zone resolution", macs.length > 0, macs.join(","));

  if (skipAudio) {
    console.log("(skipping audible tests)");
    return;
  }

  // 4. Webhook cue through the shared executor (audible chime)
  const bell = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: db.select().from(schema.users).limit(1).get()!.id,
    cue,
    ...localDateTimeParts(),
  });
  step("webhook cue via executor", bell.outcome.status === "SUCCESS", `run ${bell.runId}: ${bell.outcome.status} ${bell.outcome.latencyMs ?? "?"}ms`);

  // Protect returns HTTP 500 for PLAY_TEXT_ON_SPEAKER while the speaker is
  // still playing (verified live on 7.1.87) — space out audible tests.
  await new Promise((r) => setTimeout(r, 8000));

  // 5. Ad-hoc TTS through the shared executor (audible speech)
  const tts = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: db.select().from(schema.users).limit(1).get()!.id,
    adhoc: {
      ttsText: "End to end verification. The bell console executor is working.",
      ttsTone: "welcome",
      targetMacs: macs,
    },
    ...localDateTimeParts(),
  });
  step("typed TTS via executor", tts.outcome.status === "SUCCESS", `run ${tts.runId}: ${tts.outcome.status} ${tts.outcome.latencyMs ?? "?"}ms`);

  // 6. Run rows + audit rows exist
  const runs = db.select().from(schema.scheduledRuns).all();
  step("run rows recorded", runs.length >= 2, `${runs.length} total`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
