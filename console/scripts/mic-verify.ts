/**
 * Verifies the mic-page pipeline end to end (AUDIBLE) using a browser-shaped
 * WebM/Opus blob — the format MediaRecorder produces. Runs everything the
 * server action does after the auth guard (which can only run in a request).
 *
 * Usage: npx tsx scripts/mic-verify.ts <recording.webm>
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { db, schema } from "@/lib/db/client";
import { audioPath, deleteStoredAudio, saveRecording } from "@/lib/audio";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { updateSystemState } from "@/lib/state";

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/mic-verify.ts <recording.webm>");
    process.exit(1);
  }
  updateSystemState({ speakerBusyUntil: null });

  const buf = readFileSync(path);
  const blob = new File([buf], basename(path), { type: "audio/webm;codecs=opus" });

  const saved = await saveRecording(blob);
  if ("error" in saved) {
    step("accept browser recording", false, saved.error);
    return;
  }
  step("accept browser recording (webm/opus)", true, `${Math.round((saved.durationMs ?? 0) / 1000)}s, ${(saved.sizeBytes / 1024).toFixed(0)}KB`);

  const user = db.select().from(schema.users).limit(1).get()!;
  const { runId, outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    audioFile: {
      name: `Live page — ${user.displayName}`,
      path: audioPath(saved.storedName),
      durationMs: saved.durationMs,
    },
    ...localDateTimeParts(),
  });
  step("played on speakers", outcome.status === "SUCCESS", `run ${runId}: ${outcome.message ?? outcome.status}`);

  // Un-saved pages must not leave staff voice recordings on disk.
  deleteStoredAudio(saved.storedName);
  step("discarded when not saved", !existsSync(audioPath(saved.storedName)));
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
