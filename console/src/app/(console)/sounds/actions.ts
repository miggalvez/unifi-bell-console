"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { TTS_MAX_CHARS, coerceTone } from "@/lib/protect/tones";
import { stopAlert } from "@/lib/alerts";
import { preambleCue } from "@/lib/drills";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { getSystemState } from "@/lib/state";

export interface CueFormResult {
  ok: boolean;
  error?: string;
}

interface CueInput {
  /** Ordered recordings for a combined announcement — persisted separately. */
  partIds?: number[];
  name: string;
  description: string | null;
  deliveryMethod: "PROTECT_WEBHOOK" | "PROTECT_NATIVE_TTS" | "PROTECT_TALKBACK_AUDIO" | "PROTECT_TALKBACK_COMPOSITE";
  webhookId: string | null;
  ttsText: string | null;
  ttsTone: string;
  audioFileId: number | null;
  estimatedDurationMs: number | null;
  zoneId: number | null;
  isEmergency: boolean;
  isEnabled: boolean;
}

function parseCueForm(formData: FormData): CueInput | { error: string } {
  const name = String(formData.get("name") ?? "").trim();
  const deliveryMethod = String(formData.get("deliveryMethod") ?? "");
  const webhookId = String(formData.get("webhookId") ?? "").trim() || null;
  const ttsText = String(formData.get("ttsText") ?? "").trim() || null;
  const ttsTone = coerceTone(String(formData.get("ttsTone") ?? ""));
  const zoneRaw = String(formData.get("zoneId") ?? "");
  const zoneId = zoneRaw && zoneRaw !== "all" ? Number(zoneRaw) : null;

  const audioRaw = String(formData.get("audioFileId") ?? "");
  const audioFileId = audioRaw ? Number(audioRaw) : null;

  if (!name) return { error: "Name is required." };
  const methods = ["PROTECT_WEBHOOK", "PROTECT_NATIVE_TTS", "PROTECT_TALKBACK_AUDIO", "PROTECT_TALKBACK_COMPOSITE"];
  if (!methods.includes(deliveryMethod)) return { error: "Choose what it plays." };
  if (deliveryMethod === "PROTECT_WEBHOOK" && !webhookId) {
    return { error: "Enter the automation ID from UniFi Protect." };
  }
  if (deliveryMethod === "PROTECT_NATIVE_TTS" && !ttsText) {
    return { error: "Type the words you want spoken." };
  }
  if (deliveryMethod === "PROTECT_NATIVE_TTS" && ttsText && ttsText.length > TTS_MAX_CHARS) {
    return {
      error: `The speakers can say at most ${TTS_MAX_CHARS} characters — this is ${ttsText.length}. Shorten it, or upload a recording instead.`,
    };
  }
  if (deliveryMethod === "PROTECT_TALKBACK_AUDIO" && !audioFileId) {
    return { error: "Choose one of your recordings." };
  }

  // A combined announcement: ordered recordings, spliced into one stream at
  // play time. Two minimum — one part is just a recording with extra steps.
  let partIds: number[] | undefined;
  if (deliveryMethod === "PROTECT_TALKBACK_COMPOSITE") {
    try {
      const parsed = JSON.parse(String(formData.get("partIds") ?? "[]")) as unknown;
      partIds = Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    } catch {
      partIds = [];
    }
    if (partIds.length < 2) {
      return { error: "Pick at least two recordings to combine — e.g. a chime, then the message." };
    }
    const found = db
      .select({ id: schema.audioFiles.id, durationMs: schema.audioFiles.durationMs })
      .from(schema.audioFiles)
      .where(inArray(schema.audioFiles.id, partIds))
      .all();
    if (found.length !== new Set(partIds).size) {
      return { error: "One of those recordings no longer exists." };
    }
  }

  // The lock uses the real length so the next cue waits exactly long enough.
  // Uploads carry their own duration; for a Protect sound only a human can
  // tell us, because the API never reports it. A combined announcement is the
  // sum of its parts.
  let estimatedDurationMs: number | null = null;
  if (partIds) {
    const durations = db
      .select({ id: schema.audioFiles.id, d: schema.audioFiles.durationMs })
      .from(schema.audioFiles)
      .where(inArray(schema.audioFiles.id, partIds))
      .all();
    estimatedDurationMs = partIds.reduce((sum, id) => sum + (durations.find((x) => x.id === id)?.d ?? 0), 0) || null;
  } else if (audioFileId) {
    estimatedDurationMs =
      db
        .select({ d: schema.audioFiles.durationMs })
        .from(schema.audioFiles)
        .where(eq(schema.audioFiles.id, audioFileId))
        .get()?.d ?? null;
  } else if (deliveryMethod === "PROTECT_WEBHOOK") {
    const secs = Number(formData.get("durationSeconds"));
    if (Number.isFinite(secs) && secs > 0 && secs <= 600) estimatedDurationMs = Math.round(secs * 1000);
  }

  return {
    partIds,
    name,
    description: String(formData.get("description") ?? "").trim() || null,
    deliveryMethod: deliveryMethod as CueInput["deliveryMethod"],
    webhookId: deliveryMethod === "PROTECT_WEBHOOK" ? webhookId : null,
    ttsText: deliveryMethod === "PROTECT_NATIVE_TTS" ? ttsText : null,
    ttsTone,
    audioFileId: deliveryMethod === "PROTECT_TALKBACK_AUDIO" ? audioFileId : null,
    estimatedDurationMs,
    zoneId,
    isEmergency: formData.get("isEmergency") === "on",
    isEnabled: formData.get("isEnabled") === "on",
  };
}

/** Replaces a combined announcement's part list (no-op for other methods). */
function writeParts(cueId: number, partIds: number[] | undefined): void {
  db.delete(schema.soundCueParts).where(eq(schema.soundCueParts.cueId, cueId)).run();
  if (!partIds) return;
  partIds.forEach((audioFileId, i) => {
    db.insert(schema.soundCueParts).values({ cueId, position: i, audioFileId }).run();
  });
}

export async function createCue(_prev: CueFormResult, formData: FormData): Promise<CueFormResult> {
  const user = await requireAdmin();
  const parsed = parseCueForm(formData);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const { partIds, ...cueValues } = parsed;
  const now = Date.now();
  try {
    const created = db
      .insert(schema.soundCues)
      .values({ ...cueValues, createdAt: now, updatedAt: now })
      .returning({ id: schema.soundCues.id })
      .get();
    writeParts(created.id, partIds);
    writeAudit({ userId: user.id, action: "cue.create", targetType: "cue", targetId: created.id, detail: parsed });
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, error: msg.includes("UNIQUE") ? "Something with that name already exists." : msg.slice(0, 200) };
  }
  revalidatePath("/sounds");
  return { ok: true };
}

export async function updateCue(id: number, _prev: CueFormResult, formData: FormData): Promise<CueFormResult> {
  const user = await requireAdmin();
  const parsed = parseCueForm(formData);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const { partIds, ...cueValues } = parsed;
  try {
    db.update(schema.soundCues)
      .set({ ...cueValues, updatedAt: Date.now() })
      .where(eq(schema.soundCues.id, id))
      .run();
    writeParts(id, partIds);
    writeAudit({ userId: user.id, action: "cue.update", targetType: "cue", targetId: id, detail: parsed });
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, error: msg.includes("UNIQUE") ? "Something with that name already exists." : msg.slice(0, 200) };
  }
  revalidatePath("/sounds");
  return { ok: true };
}

export async function deleteCue(id: number): Promise<CueFormResult> {
  const user = await requireAdmin();
  // If this sound is the one currently repeating, stop the alert first —
  // deleting out from under a live alert would leave it looping on nothing.
  if (getSystemState().alertCueId === id) stopAlert(user.id);
  // The drill announcement is structural, not a normal sound: without it no
  // drill can start, so it must not be deletable by accident.
  if (preambleCue()?.id === id) {
    return {
      ok: false,
      error: "This is the drill announcement every drill opens with — it cannot be deleted.",
    };
  }
  try {
    db.delete(schema.soundCues).where(eq(schema.soundCues.id, id)).run();
    writeAudit({ userId: user.id, action: "cue.delete", targetType: "cue", targetId: id });
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: msg.includes("FOREIGN KEY")
        ? "A bell plan, drill, or keychain remote uses this — remove it there first."
        : msg.slice(0, 200),
    };
  }
  revalidatePath("/sounds");
  return { ok: true };
}

export interface TriggerResult {
  ok: boolean;
  status: string;
  message?: string;
}

/** Plays a cue right now (STAFF). Emergency cues are excluded here — they go
 * through the dedicated emergency action with its own permission. */
export async function triggerCue(id: number): Promise<TriggerResult> {
  const user = await requireUser();
  const blocked = blockedByActiveAlert();
  if (blocked) return blocked;
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, id)).get();
  if (!cue) return { ok: false, status: "FAILED", message: "That sound is no longer available." };
  if (cue.isEmergency) return { ok: false, status: "FAILED", message: "Emergency announcements are played from the Emergency section." };
  if (!cue.isEnabled) return { ok: false, status: "FAILED", message: "This one is turned off." };

  const { outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    cue,
    ...localDateTimeParts(),
  });
  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}
