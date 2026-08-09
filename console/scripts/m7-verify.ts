/**
 * M7 verification against the live console (AUDIBLE).
 * Exercises the real app paths: upload → catalogue → cue → executor → speaker,
 * plus the speaker lock's no-overlap guarantee.
 *
 * Usage: npx tsx scripts/m7-verify.ts <path-to-audio-file>
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { saveUpload, audioPath, ffmpegAvailable, formatDuration } from "@/lib/audio";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { updateSystemState, getSystemState } from "@/lib/state";
import { tryClaimSpeaker } from "@/lib/speaker-lock";

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/m7-verify.ts <audio file>");
    process.exit(1);
  }

  step("ffmpeg available", await ffmpegAvailable());
  updateSystemState({ speakerBusyUntil: null });

  // 1. Upload through the same code the server action uses
  const buf = readFileSync(path);
  const file = new File([buf], basename(path), { type: "audio/mpeg" });
  const saved = await saveUpload(file);
  if ("error" in saved) {
    step("upload", false, saved.error);
    return;
  }
  step("upload + probe", saved.durationMs !== null, `${formatDuration(saved.durationMs)}, ${(saved.sizeBytes / 1024).toFixed(0)}KB`);

  const user = db.select().from(schema.users).limit(1).get()!;
  const now = Date.now();
  const audioRow = db
    .insert(schema.audioFiles)
    .values({
      name: "M7 Verification Clip",
      storedName: saved.storedName,
      originalName: file.name,
      mimeType: "audio/mpeg",
      sizeBytes: saved.sizeBytes,
      durationMs: saved.durationMs,
      uploadedBy: user.id,
      createdAt: now,
    })
    .returning({ id: schema.audioFiles.id })
    .get();
  step("catalogued", !!audioRow.id, `audio_files id ${audioRow.id}`);

  // 2. Play the file directly (the "Play on speakers" button path)
  const direct = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    audioFile: { name: "M7 direct play", path: audioPath(saved.storedName), durationMs: saved.durationMs },
    ...localDateTimeParts(),
  });
  step("stream file to speakers", direct.outcome.status === "SUCCESS", `run ${direct.runId}: ${direct.outcome.message ?? direct.outcome.status}`);

  // 3. The lock must refuse an overlapping cue while that audio plays
  const blocked = tryClaimSpeaker(1000);
  step("speaker lock blocks overlap", blocked !== null, blocked ? `busy for ${Math.round(blocked / 1000)}s more` : "NOT BLOCKED");

  // 4. Wait out the lock, then play via a saved cue (the cue path)
  const busyUntil = getSystemState().speakerBusyUntil ?? 0;
  const waitMs = Math.max(0, busyUntil - Date.now()) + 500;
  console.log(`  waiting ${(waitMs / 1000).toFixed(1)}s for the speaker to free…`);
  await sleep(waitMs);

  const cue = db
    .insert(schema.soundCues)
    .values({
      name: "M7 Audio Cue",
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      audioFileId: audioRow.id,
      estimatedDurationMs: saved.durationMs,
      ttsTone: "welcome",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const viaCue = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    cue,
    ...localDateTimeParts(),
  });
  step("play via saved cue", viaCue.outcome.status === "SUCCESS", `run ${viaCue.runId}: ${viaCue.outcome.status}`);

  // 5. Clean up the artifacts this script created
  db.delete(schema.soundCues).where(eq(schema.soundCues.id, cue.id)).run();
  db.delete(schema.audioFiles).where(eq(schema.audioFiles.id, audioRow.id)).run();
  updateSystemState({ speakerBusyUntil: null });
  console.log("\n(cue and catalogue row removed; the uploaded file remains in data/audio/)");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
