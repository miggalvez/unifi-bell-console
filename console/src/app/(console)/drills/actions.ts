"use server";

import { asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { saveUpload } from "@/lib/audio";
import { setSetting } from "@/lib/state";
import {
  MAX_REPEAT_FOR_SECONDS,
  MAX_WAIT_SECONDS,
  MIN_REPEAT_FOR_SECONDS,
  preambleCue,
  startDrill,
  stopDrill,
} from "@/lib/drills";

export interface DrillResult {
  ok: boolean;
  message?: string;
}

export interface StepInput {
  kind: "PLAY" | "WAIT";
  cueId?: number | null;
  waitSeconds?: number | null;
  /** Keep sounding for this long. Null = play once. No interval to pick: the
   *  alarm repeats back to back, with the drill tag between soundings. */
  repeatForSeconds?: number | null;
}

function validateSteps(steps: StepInput[]): string | null {
  if (steps.length === 0) return "Add at least one step.";
  const tagId = preambleCue()?.id;
  for (const [i, s] of steps.entries()) {
    if (s.kind === "PLAY") {
      if (!s.cueId) return `Step ${i + 1}: choose a sound.`;
      if (s.cueId === tagId) {
        return `Step ${i + 1}: the drill announcement is added around every sound automatically — it cannot also be a step.`;
      }
      const forSecs = s.repeatForSeconds ?? null;
      if (forSecs !== null) {
        if (!Number.isFinite(forSecs) || forSecs <= 0) {
          return `Step ${i + 1}: enter how many minutes to keep it sounding.`;
        }
        if (forSecs < MIN_REPEAT_FOR_SECONDS) {
          return `Step ${i + 1}: sound it for at least ${MIN_REPEAT_FOR_SECONDS} seconds.`;
        }
        if (forSecs > MAX_REPEAT_FOR_SECONDS) {
          return `Step ${i + 1}: sounding is capped at ${MAX_REPEAT_FOR_SECONDS / 60} minutes.`;
        }
      }
      continue;
    }
    const secs = s.waitSeconds ?? 0;
    if (!Number.isFinite(secs) || secs <= 0) return `Step ${i + 1}: enter how long to wait.`;
    if (secs > MAX_WAIT_SECONDS) return `Step ${i + 1}: waits are capped at ${MAX_WAIT_SECONDS / 60} minutes.`;
  }
  return null;
}

/** Replaces the whole step list in one transaction — no half-edited drills. */
function writeSteps(sequenceId: number, steps: StepInput[]): void {
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(schema.drillSteps).where(eq(schema.drillSteps.sequenceId, sequenceId)).run();
    steps.forEach((s, i) => {
      tx.insert(schema.drillSteps)
        .values({
          sequenceId,
          position: i,
          kind: s.kind,
          cueId: s.kind === "PLAY" ? s.cueId! : null,
          waitSeconds: s.kind === "WAIT" ? Math.round(s.waitSeconds!) : null,
          repeatForSeconds: s.kind === "PLAY" && s.repeatForSeconds ? Math.round(s.repeatForSeconds) : null,
          createdAt: now,
        })
        .run();
    });
    tx.update(schema.drillSequences).set({ updatedAt: now }).where(eq(schema.drillSequences.id, sequenceId)).run();
  });
}

export async function createDrill(input: {
  name: string;
  description?: string;
  steps: StepInput[];
}): Promise<DrillResult> {
  const admin = await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Give the drill a name." };
  const bad = validateSteps(input.steps);
  if (bad) return { ok: false, message: bad };

  const now = Date.now();
  let id: number;
  try {
    id = db
      .insert(schema.drillSequences)
      .values({ name, description: input.description?.trim() || null, createdBy: admin.id, createdAt: now, updatedAt: now })
      .returning({ id: schema.drillSequences.id })
      .get().id;
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, message: msg.includes("UNIQUE") ? "A drill with that name already exists." : msg.slice(0, 200) };
  }

  try {
    writeSteps(id, input.steps);
  } catch (err) {
    db.delete(schema.drillSequences).where(eq(schema.drillSequences.id, id)).run();
    return { ok: false, message: (err as Error).message.slice(0, 200) };
  }

  writeAudit({ userId: admin.id, action: "drill.create", targetType: "drill", targetId: id, detail: { name, steps: input.steps.length } });
  revalidatePath("/drills");
  return { ok: true };
}

export async function updateDrill(
  id: number,
  input: { name: string; description?: string; isEnabled?: boolean; steps: StepInput[] },
): Promise<DrillResult> {
  const admin = await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Give the drill a name." };
  const bad = validateSteps(input.steps);
  if (bad) return { ok: false, message: bad };

  try {
    db.update(schema.drillSequences)
      .set({
        name,
        description: input.description?.trim() || null,
        isEnabled: input.isEnabled ?? true,
        updatedAt: Date.now(),
      })
      .where(eq(schema.drillSequences.id, id))
      .run();
    writeSteps(id, input.steps);
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, message: msg.includes("UNIQUE") ? "A drill with that name already exists." : msg.slice(0, 200) };
  }

  writeAudit({ userId: admin.id, action: "drill.update", targetType: "drill", targetId: id, detail: { name, steps: input.steps.length } });
  revalidatePath("/drills");
  return { ok: true };
}

export async function deleteDrill(id: number): Promise<DrillResult> {
  const admin = await requireAdmin();
  // Stop it first: the running-drill state holds a foreign key to this row.
  stopDrill(admin.id, "the drill was deleted while running");
  const seq = db.select().from(schema.drillSequences).where(eq(schema.drillSequences.id, id)).get();
  db.delete(schema.drillSequences).where(eq(schema.drillSequences.id, id)).run();
  writeAudit({ userId: admin.id, action: "drill.delete", targetType: "drill", targetId: id, detail: { name: seq?.name } });
  revalidatePath("/drills");
  return { ok: true };
}

/** Any signed-in user may start a drill; only admins may edit the scripts. */
export async function runDrill(id: number): Promise<DrillResult> {
  const user = await requireUser();
  const r = startDrill({ sequenceId: id, userId: user.id });
  revalidatePath("/drills");
  return r;
}

/**
 * Any signed-in user can stop a drill, for the same reason anyone can stop an
 * alert: a drill nobody present can silence is its own hazard.
 */
export async function stopRunningDrill(): Promise<DrillResult> {
  const user = await requireUser();
  stopDrill(user.id, "stopped by hand");
  revalidatePath("/drills");
  return { ok: true };
}

export interface DrillListItem {
  id: number;
  name: string;
  description: string | null;
  isEnabled: boolean;
  stepCount: number;
}

export async function listDrills(): Promise<DrillListItem[]> {
  await requireUser();
  return db
    .select({
      id: schema.drillSequences.id,
      name: schema.drillSequences.name,
      description: schema.drillSequences.description,
      isEnabled: schema.drillSequences.isEnabled,
      stepCount: sql<number>`(SELECT COUNT(*) FROM drill_steps WHERE sequence_id = ${schema.drillSequences.id})`,
    })
    .from(schema.drillSequences)
    .orderBy(asc(schema.drillSequences.name))
    .all();
}

export async function getDrillSteps(id: number): Promise<StepInput[]> {
  await requireUser();
  return db
    .select({
      kind: schema.drillSteps.kind,
      cueId: schema.drillSteps.cueId,
      waitSeconds: schema.drillSteps.waitSeconds,
      repeatForSeconds: schema.drillSteps.repeatForSeconds,
    })
    .from(schema.drillSteps)
    .where(eq(schema.drillSteps.sequenceId, id))
    .orderBy(asc(schema.drillSteps.position))
    .all();
}


/** A unique cue name, so an upload never collides with an existing sound. */
function freeCueName(base: string): string {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base} ${n + 1}`;
    const taken = db.select({ id: schema.soundCues.id }).from(schema.soundCues).where(eq(schema.soundCues.name, candidate)).get();
    if (!taken) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Chooses which sound announces a drill — either an existing one, or a
 * recording uploaded here and turned into a sound in one step.
 *
 * A recording is usually the better choice: it is a real human voice rather
 * than Protect's synthetic one, it sounds the same every time, and because the
 * file's length is measured on upload the console knows exactly how long the
 * announcement takes instead of estimating it from the text.
 */
export async function setDrillAnnouncement(formData: FormData): Promise<DrillResult> {
  const admin = await requireAdmin();
  const file = formData.get("file");
  const chosen = String(formData.get("cueId") ?? "").trim();

  if (file instanceof File && file.size > 0) {
    const label = String(formData.get("name") ?? "").trim() || "Drill announcement (recorded)";
    const saved = await saveUpload(file);
    if ("error" in saved) return { ok: false, message: saved.error };

    const now = Date.now();
    const audioId = db
      .insert(schema.audioFiles)
      .values({
        name: label,
        storedName: saved.storedName,
        originalName: file.name,
        mimeType: file.type || null,
        sizeBytes: saved.sizeBytes,
        durationMs: saved.durationMs,
        uploadedBy: admin.id,
        createdAt: now,
      })
      .returning({ id: schema.audioFiles.id })
      .get().id;

    const cueId = db
      .insert(schema.soundCues)
      .values({
        name: freeCueName(label),
        description: "Spoken before and after every sound in a drill.",
        deliveryMethod: "PROTECT_TALKBACK_AUDIO",
        audioFileId: audioId,
        // Measured from the file, so drill pacing is exact rather than guessed.
        estimatedDurationMs: saved.durationMs,
        ttsTone: "neutral",
        isEmergency: false,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.soundCues.id })
      .get().id;

    setSetting("drillPreambleCueId", cueId);
    writeAudit({
      userId: admin.id,
      action: "drill.set_announcement",
      targetType: "cue",
      targetId: cueId,
      detail: { via: "upload", name: label, durationMs: saved.durationMs },
    });
    revalidatePath("/drills");
    revalidatePath("/sounds");
    return { ok: true };
  }

  if (!chosen) return { ok: false, message: "Choose a sound, or upload a recording." };
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, Number(chosen))).get();
  if (!cue) return { ok: false, message: "That sound no longer exists." };
  // Otherwise that drill would announce itself three times over.
  const usedAsStep = db
    .select({ sequenceId: schema.drillSteps.sequenceId })
    .from(schema.drillSteps)
    .where(eq(schema.drillSteps.cueId, cue.id))
    .get();
  if (usedAsStep) {
    const seq = db
      .select({ name: schema.drillSequences.name })
      .from(schema.drillSequences)
      .where(eq(schema.drillSequences.id, usedAsStep.sequenceId))
      .get();
    return {
      ok: false,
      message: `"${cue.name}" is a step in ${seq?.name ?? "a drill"}. Remove it from that drill first, or choose another announcement.`,
    };
  }
  if (!cue.isEnabled) return { ok: false, message: `"${cue.name}" is turned off — turn it on first.` };
  if (cue.isEmergency) {
    return { ok: false, message: "An emergency sound cannot be the drill announcement — it would say the opposite of what it means." };
  }

  setSetting("drillPreambleCueId", cue.id);
  writeAudit({
    userId: admin.id,
    action: "drill.set_announcement",
    targetType: "cue",
    targetId: cue.id,
    detail: { via: "existing", name: cue.name },
  });
  revalidatePath("/drills");
  return { ok: true };
}
