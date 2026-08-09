"use server";

import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { audioPath, deleteStoredAudio, saveRecording } from "@/lib/audio";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";

export interface PageResult {
  ok: boolean;
  status: string;
  message?: string;
}

/**
 * Plays a staff member's recorded message on the speakers. The recording is
 * kept only if they asked to save it — a one-off page shouldn't quietly
 * accumulate voice recordings of school staff on disk.
 */
export async function sendRecordedPage(formData: FormData): Promise<PageResult> {
  const user = await requireUser();
  const blocked = blockedByActiveAlert();
  if (blocked) return blocked;
  const blob = formData.get("recording");
  const keep = formData.get("keep") === "on";
  const saveName = String(formData.get("name") ?? "").trim();

  if (!(blob instanceof File)) return { ok: false, status: "FAILED", message: "No recording received." };

  const saved = await saveRecording(blob);
  if ("error" in saved) return { ok: false, status: "FAILED", message: saved.error };

  const label = keep && saveName ? saveName : `Live page — ${user.displayName}`;
  const { outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    audioFile: { name: label, path: audioPath(saved.storedName), durationMs: saved.durationMs },
    ...localDateTimeParts(),
  });

  if (keep) {
    db.insert(schema.audioFiles)
      .values({
        name: saveName || `Page by ${user.displayName}`,
        storedName: saved.storedName,
        originalName: blob.name || "recording",
        mimeType: blob.type || null,
        sizeBytes: saved.sizeBytes,
        durationMs: saved.durationMs,
        uploadedBy: user.id,
        createdAt: Date.now(),
      })
      .run();
  } else {
    deleteStoredAudio(saved.storedName);
  }

  writeAudit({
    userId: user.id,
    action: "page.live",
    detail: { durationMs: saved.durationMs, kept: keep, status: outcome.status },
  });

  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}
