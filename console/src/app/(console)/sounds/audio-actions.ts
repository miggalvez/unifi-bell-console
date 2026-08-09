"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { audioPath, deleteStoredAudio, saveUpload } from "@/lib/audio";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";

export interface AudioResult {
  ok: boolean;
  error?: string;
  audioFileId?: number;
}

export async function uploadAudio(_prev: AudioResult, formData: FormData): Promise<AudioResult> {
  const user = await requireAdmin();
  const file = formData.get("file");
  const name = String(formData.get("name") ?? "").trim();
  if (!(file instanceof File)) return { ok: false, error: "Choose a file first." };

  const saved = await saveUpload(file);
  if ("error" in saved) return { ok: false, error: saved.error };

  const created = db
    .insert(schema.audioFiles)
    .values({
      name: name || file.name.replace(/\.[^.]+$/, ""),
      storedName: saved.storedName,
      originalName: file.name,
      mimeType: file.type || null,
      sizeBytes: saved.sizeBytes,
      durationMs: saved.durationMs,
      uploadedBy: user.id,
      createdAt: Date.now(),
    })
    .returning({ id: schema.audioFiles.id })
    .get();

  writeAudit({
    userId: user.id,
    action: "audio.upload",
    targetType: "audio",
    targetId: created.id,
    detail: { name, originalName: file.name, sizeBytes: saved.sizeBytes, durationMs: saved.durationMs },
  });
  revalidatePath("/sounds");
  return { ok: true, audioFileId: created.id };
}

export async function deleteAudio(id: number): Promise<AudioResult> {
  const user = await requireAdmin();
  const f = db.select().from(schema.audioFiles).where(eq(schema.audioFiles.id, id)).get();
  if (!f) return { ok: true };
  try {
    db.delete(schema.audioFiles).where(eq(schema.audioFiles.id, id)).run();
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: msg.includes("FOREIGN KEY")
        ? "A sound or message uses this recording — change that first."
        : msg.slice(0, 200),
    };
  }
  deleteStoredAudio(f.storedName);
  writeAudit({ userId: user.id, action: "audio.delete", targetType: "audio", targetId: id, detail: { name: f.name } });
  revalidatePath("/sounds");
  return { ok: true };
}

/** Streams an uploaded file to the speakers right now, without creating a cue. */
export async function playAudioNow(id: number): Promise<{ ok: boolean; status: string; message?: string }> {
  const user = await requireUser();
  const blocked = blockedByActiveAlert();
  if (blocked) return blocked;
  const f = db.select().from(schema.audioFiles).where(eq(schema.audioFiles.id, id)).get();
  if (!f) return { ok: false, status: "FAILED", message: "That recording is no longer available." };

  const { outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    audioFile: { name: `${f.name} (file)`, path: audioPath(f.storedName), durationMs: f.durationMs },
    ...localDateTimeParts(),
  });
  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}
