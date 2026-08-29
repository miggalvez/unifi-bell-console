"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { setSetting } from "@/lib/state";
import { normMac, realAdapter } from "@/lib/protect/adapter";
import { upsertFobsFromBootstrap } from "@/lib/fobs/sync";
import {
  FOB_BASE_URL_KEY,
  reconcileFobAlarms,
  requestFobReconcile,
  validateBaseUrl,
  type FobMappingRow,
} from "@/lib/fobs/provision";

export interface RemotesResult {
  ok: boolean;
  error?: string;
}

/**
 * Push the new config toward the NVR right away so the page shows Active
 * within a moment — but never make the admin wait on a slow or dead NVR. The
 * worker's flag-driven pass is the guaranteed path; this is the fast one.
 * The lease keeps the two from double-creating.
 */
async function nudgeReconcile(): Promise<void> {
  requestFobReconcile();
  const attempt = reconcileFobAlarms(realAdapter).catch(() => undefined);
  await Promise.race([attempt, new Promise((r) => setTimeout(r, 4000))]);
}

export async function setFobBaseUrl(formData: FormData): Promise<RemotesResult> {
  const admin = await requireAdmin();
  const parsed = validateBaseUrl(String(formData.get("baseUrl") ?? ""));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  setSetting(FOB_BASE_URL_KEY, parsed.value);
  writeAudit({ userId: admin.id, action: "fob.settings_update", detail: { baseUrl: parsed.value } });
  await nudgeReconcile();
  revalidatePath("/remotes");
  return { ok: true };
}

type MappingInput = {
  fobMac: string;
  button: FobMappingRow["button"];
  pressType: FobMappingRow["pressType"];
  action: FobMappingRow["action"];
  cueId: number | null;
  repeatSeconds: number | null;
};

const BUTTONS = new Set(["arm", "night", "disarm", "panic", "left", "right"]);
const PRESS_TYPES = new Set(["press", "longPress", "doublePress"]);
const ACTIONS = new Set(["START_ALERT", "TRIGGER_CUE", "STOP_ALERT"]);

/**
 * Server-side truth for what a mapping may be. The dialog enforces the same
 * rules for UX, but a server action is a public POST — nothing here trusts it.
 */
function validateMapping(input: MappingInput): { ok: true; value: MappingInput } | { ok: false; error: string } {
  const fobMac = normMac(input.fobMac);
  if (!/^[0-9A-F]{12}$/.test(fobMac)) return { ok: false, error: "Unknown remote." };
  if (!BUTTONS.has(input.button)) return { ok: false, error: "Unknown button." };
  if (!PRESS_TYPES.has(input.pressType)) return { ok: false, error: "Unknown press type." };
  if (!ACTIONS.has(input.action)) return { ok: false, error: "Unknown action." };

  if (input.action === "STOP_ALERT") {
    return { ok: true, value: { ...input, fobMac, cueId: null, repeatSeconds: null } };
  }

  if (input.cueId == null) return { ok: false, error: "Choose a sound or announcement." };
  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, input.cueId)).get();
  if (!cue) return { ok: false, error: "That announcement no longer exists." };
  if (!cue.isEnabled) return { ok: false, error: `"${cue.name}" is turned off — enable it first.` };

  if (input.action === "START_ALERT") {
    if (!cue.isEmergency) {
      return { ok: false, error: "Repeating alerts can only use emergency announcements." };
    }
    // A quick tap can happen in a pocket. Starting an emergency takes the
    // deliberate gestures only — a 3-second hold or a double press.
    if (input.pressType === "press") {
      return { ok: false, error: "Emergency alerts need a long press or double press." };
    }
    if (input.repeatSeconds != null) {
      if (!Number.isInteger(input.repeatSeconds) || input.repeatSeconds < 10 || input.repeatSeconds > 300) {
        return { ok: false, error: "Repeat must be 10–300 seconds." };
      }
    }
    return { ok: true, value: { ...input, fobMac } };
  }

  return { ok: true, value: { ...input, fobMac, repeatSeconds: null } };
}

export async function createFobMapping(input: MappingInput): Promise<RemotesResult> {
  const admin = await requireAdmin();
  const v = validateMapping(input);
  if (!v.ok) return v;
  const now = Date.now();
  try {
    const created = db
      .insert(schema.fobMappings)
      .values({ ...v.value, createdAt: now, updatedAt: now })
      .returning({ id: schema.fobMappings.id })
      .get();
    writeAudit({
      userId: admin.id,
      action: "fob.mapping_create",
      targetType: "fobMapping",
      targetId: created.id,
      detail: v.value,
    });
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: msg.includes("UNIQUE") ? "That button and press are already mapped." : msg.slice(0, 200),
    };
  }
  await nudgeReconcile();
  revalidatePath("/remotes");
  return { ok: true };
}

export async function updateFobMapping(
  id: number,
  input: Omit<MappingInput, "fobMac">,
): Promise<RemotesResult> {
  const admin = await requireAdmin();
  const existing = db.select().from(schema.fobMappings).where(eq(schema.fobMappings.id, id)).get();
  if (!existing) return { ok: false, error: "That mapping no longer exists." };
  const v = validateMapping({ ...input, fobMac: existing.fobMac });
  if (!v.ok) return v;
  try {
    db.update(schema.fobMappings)
      .set({
        button: v.value.button,
        pressType: v.value.pressType,
        action: v.value.action,
        cueId: v.value.cueId,
        repeatSeconds: v.value.repeatSeconds,
        updatedAt: Date.now(),
      })
      .where(eq(schema.fobMappings.id, id))
      .run();
  } catch (err) {
    const msg = (err as Error).message;
    return {
      ok: false,
      error: msg.includes("UNIQUE") ? "That button and press are already mapped." : msg.slice(0, 200),
    };
  }
  writeAudit({
    userId: admin.id,
    action: "fob.mapping_update",
    targetType: "fobMapping",
    targetId: id,
    detail: input,
  });
  await nudgeReconcile();
  revalidatePath("/remotes");
  return { ok: true };
}

export async function setFobMappingEnabled(id: number, enabled: boolean): Promise<RemotesResult> {
  const admin = await requireAdmin();
  if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
  const existing = db.select().from(schema.fobMappings).where(eq(schema.fobMappings.id, id)).get();
  if (!existing) return { ok: false, error: "That mapping no longer exists." };
  db.update(schema.fobMappings)
    .set({ isEnabled: enabled, ...(enabled ? { provisionState: "PENDING" as const } : {}), updatedAt: Date.now() })
    .where(eq(schema.fobMappings.id, id))
    .run();
  writeAudit({
    userId: admin.id,
    action: enabled ? "fob.mapping_enable" : "fob.mapping_disable",
    targetType: "fobMapping",
    targetId: id,
  });
  await nudgeReconcile();
  revalidatePath("/remotes");
  return { ok: true };
}

export async function deleteFobMapping(id: number): Promise<RemotesResult> {
  const admin = await requireAdmin();
  const existing = db.select().from(schema.fobMappings).where(eq(schema.fobMappings.id, id)).get();
  if (!existing) return { ok: true };
  db.delete(schema.fobMappings).where(eq(schema.fobMappings.id, id)).run();
  writeAudit({
    userId: admin.id,
    action: "fob.mapping_delete",
    targetType: "fobMapping",
    targetId: id,
    detail: { fobMac: existing.fobMac, button: existing.button, pressType: existing.pressType },
  });
  // The NVR alarm is now an orphan; the sweep in the next pass removes it.
  await nudgeReconcile();
  revalidatePath("/remotes");
  return { ok: true };
}

/** Pull the fob list from the NVR right now (otherwise it refreshes hourly). */
export async function refreshFobs(): Promise<RemotesResult> {
  await requireAdmin();
  try {
    const b = await realAdapter.bootstrap();
    upsertFobsFromBootstrap(b);
  } catch (err) {
    return { ok: false, error: `Could not reach the NVR: ${String((err as Error).message ?? err).slice(0, 200)}` };
  }
  revalidatePath("/remotes");
  return { ok: true };
}

/**
 * Recreate every alarm from scratch with fresh tokens — the recovery story
 * for edited-on-the-NVR alarms and the token-rotation story in one.
 */
export async function reapplyFobAlarms(): Promise<RemotesResult> {
  const admin = await requireAdmin();
  writeAudit({ userId: admin.id, action: "fob.reapply" });
  const r = await reconcileFobAlarms(realAdapter, { force: true });
  if (!r.ran) {
    requestFobReconcile();
    return { ok: true }; // another pass holds the lease; the flag covers us
  }
  revalidatePath("/remotes");
  if (r.errors > 0) {
    return { ok: false, error: `${r.errors} alarm(s) could not be applied — see the status badges.` };
  }
  return { ok: true };
}
