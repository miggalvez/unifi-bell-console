"use server";

import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireEmergency, requireUser } from "@/lib/auth/guards";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { resolveTargetMacs } from "@/lib/zones";
import { coerceTone, TTS_MAX_CHARS } from "@/lib/protect/tones";
import { minimumRepeatSeconds, startAlert, stopAlert } from "@/lib/alerts";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { revalidatePath } from "next/cache";

export interface SpeakResult {
  ok: boolean;
  status: string;
  message?: string;
}

export async function speakText(formData: FormData): Promise<SpeakResult> {
  const user = await requireUser();
  const blocked = blockedByActiveAlert();
  if (blocked) return blocked;
  const text = String(formData.get("text") ?? "").trim();
  // Protect rejects anything outside its small voice list with HTTP 400.
  const tone = coerceTone(String(formData.get("tone") ?? ""));
  const zoneRaw = String(formData.get("zoneId") ?? "all");
  const zoneId = zoneRaw !== "all" ? Number(zoneRaw) : null;

  if (!text) return { ok: false, status: "FAILED", message: "Type a message first." };
  if (text.length > TTS_MAX_CHARS) {
    return {
      ok: false,
      status: "FAILED",
      message: `The speakers can say at most ${TTS_MAX_CHARS} characters at a time — this is ${text.length}. Split it, or record it instead (recordings have no length limit).`,
    };
  }

  const targetMacs = resolveTargetMacs(zoneId);
  if (targetMacs.length === 0) {
    return { ok: false, status: "FAILED", message: "No speakers found yet — check the Speakers page." };
  }

  const { outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: user.id,
    adhoc: { ttsText: text, ttsTone: tone, targetMacs },
    ...localDateTimeParts(),
  });
  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}

/**
 * Starts a repeating emergency alert. The loop itself runs in the worker, so
 * it continues if this browser closes.
 */
export async function startEmergencyAlert(id: number, repeatSeconds?: number): Promise<SpeakResult> {
  const user = await requireEmergency();
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, id)).get();
  if (!cue) return { ok: false, status: "FAILED", message: "That announcement is no longer available." };
  if (!cue.isEmergency) return { ok: false, status: "FAILED", message: "That is not an emergency announcement." };
  if (!cue.isEnabled) return { ok: false, status: "FAILED", message: "This one is turned off." };

  // Never repeat faster than the sound itself lasts.
  const floor = minimumRepeatSeconds(cue);
  startAlert({ cueId: id, userId: user.id, repeatSeconds: Math.max(floor, repeatSeconds ?? floor) });
  revalidatePath("/", "layout");
  return { ok: true, status: "STARTED" };
}

/**
 * Stops the alert. Deliberately available to ANY signed-in user, not just
 * those with emergency permission: an alert that cannot be silenced is its own
 * hazard, and every stop is recorded with who did it.
 */
export async function stopEmergencyAlert(): Promise<SpeakResult> {
  const user = await requireUser();
  stopAlert(user.id);
  revalidatePath("/", "layout");
  return { ok: true, status: "STOPPED" };
}

/**
 * Emergency cues: separate permission, bypasses pause by construction (runs
 * in the web process with source EMERGENCY). The press-and-hold UI is only
 * friction — this server-side check is the authorization.
 */
export async function triggerEmergencyCue(id: number): Promise<SpeakResult> {
  const user = await requireEmergency();
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, id)).get();
  if (!cue) return { ok: false, status: "FAILED", message: "That announcement is no longer available." };
  if (!cue.isEmergency) return { ok: false, status: "FAILED", message: "That is not an emergency announcement." };
  if (!cue.isEnabled) return { ok: false, status: "FAILED", message: "This one is turned off." };

  const { outcome } = await triggerManualRun(realAdapter, {
    source: "EMERGENCY",
    requestedBy: user.id,
    cue,
    ...localDateTimeParts(),
  });
  return { ok: outcome.status === "SUCCESS", status: outcome.status, message: outcome.message };
}
