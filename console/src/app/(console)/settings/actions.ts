"use server";

import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { revalidatePath } from "next/cache";
import { db, schema, sqlite } from "@/lib/db/client";
import { projectRoot } from "@/env";
import { requireAdmin } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";
import { getSettingNumber, setSetting, updateSystemState, getSystemState } from "@/lib/state";
import { realAdapter } from "@/lib/protect/adapter";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { resolveTargetMacs } from "@/lib/zones";
import { materialize } from "@/lib/scheduler/materializer";
import { createManualSnapshot } from "@/lib/backup";
import { isFobServiceUser } from "@/lib/fobs/service-user";
import {
  attemptFobReconcile,
  FOB_BASE_URL_KEY,
  requestFobReconcile,
  validateBaseUrl,
} from "@/lib/fobs/provision";

export interface SettingsResult {
  ok: boolean;
  error?: string;
}

const MAX_DISPLAY_NAME = 64;

/**
 * Shared by create and edit so the bound cannot hold on one path and not the
 * other — a name too long to save is also a name that should never be created.
 */
function normalizeDisplayName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "Name must be text." };
  const displayName = value.trim();
  if (displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME) {
    return { ok: false, error: `Name must be 1–${MAX_DISPLAY_NAME} characters.` };
  }
  return { ok: true, value: displayName };
}

export async function createUser(_prev: SettingsResult, formData: FormData): Promise<SettingsResult> {
  const admin = await requireAdmin();
  const username = String(formData.get("username") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim() || username;
  const password = String(formData.get("password") ?? "");
  const role = formData.get("role") === "ADMIN" ? "ADMIN" : "STAFF";
  const canEmergency = formData.get("canEmergency") === "on";

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return { ok: false, error: "Username must be 3–32 characters (letters, digits, . _ -)." };
  }
  const name = normalizeDisplayName(displayName);
  if (!name.ok) return { ok: false, error: name.error };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };

  const now = Date.now();
  try {
    const created = db
      .insert(schema.users)
      .values({
        username,
        displayName: name.value,
        passwordHash: await hashPassword(password),
        role,
        canEmergency,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.users.id })
      .get();
    writeAudit({ userId: admin.id, action: "user.create", targetType: "user", targetId: created.id, detail: { username, role, canEmergency } });
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, error: msg.includes("UNIQUE") ? "That username is taken." : msg.slice(0, 200) };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function updateUser(
  userId: number,
  patch: {
    displayName?: string;
    role?: "ADMIN" | "STAFF";
    canEmergency?: boolean;
    isDisabled?: boolean;
  },
): Promise<SettingsResult> {
  const admin = await requireAdmin();
  // The keychain-remote service account is hidden from the panel, but this is
  // a public POST — refuse by id so nobody can enable emergencies on it or
  // rename it into looking like a person.
  if (isFobServiceUser(userId)) return { ok: false, error: "That account is managed by the system." };

  // Named fields, never a spread of the caller's object. A server action is a
  // public POST endpoint and the parameter type above is erased at runtime, so
  // spreading would let any column of `users` through — password_hash and
  // username included.
  const changes: Partial<typeof schema.users.$inferInsert> = {};

  if (patch.displayName !== undefined) {
    const name = normalizeDisplayName(patch.displayName);
    if (!name.ok) return { ok: false, error: name.error };
    changes.displayName = name.value;
  }
  if (patch.role !== undefined) {
    if (patch.role !== "ADMIN" && patch.role !== "STAFF") {
      return { ok: false, error: "Unknown role." };
    }
    changes.role = patch.role;
  }
  // Checked rather than coerced: a truthy string quietly becoming "may play
  // emergency announcements" is not a mistake worth being forgiving about.
  for (const flag of ["canEmergency", "isDisabled"] as const) {
    if (patch[flag] === undefined) continue;
    if (typeof patch[flag] !== "boolean") return { ok: false, error: `${flag} must be true or false.` };
    changes[flag] = patch[flag];
  }

  if (userId === admin.id && (changes.isDisabled || changes.role === "STAFF")) {
    return { ok: false, error: "You cannot demote or disable your own account." };
  }
  if (Object.keys(changes).length === 0) return { ok: true };

  db.update(schema.users).set({ ...changes, updatedAt: Date.now() }).where(eq(schema.users.id, userId)).run();
  if (changes.isDisabled) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
  }
  writeAudit({ userId: admin.id, action: "user.update", targetType: "user", targetId: userId, detail: changes });
  revalidatePath("/settings");
  return { ok: true };
}

export async function resetUserPassword(userId: number, password: string): Promise<SettingsResult> {
  const admin = await requireAdmin();
  // Never give the keychain-remote service account a real password — its
  // unparseable hash is what keeps it from ever logging in.
  if (isFobServiceUser(userId)) return { ok: false, error: "That account is managed by the system." };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
  db.update(schema.users)
    .set({ passwordHash: await hashPassword(password), updatedAt: Date.now() })
    .where(eq(schema.users.id, userId))
    .run();
  db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
  writeAudit({ userId: admin.id, action: "user.reset_password", targetType: "user", targetId: userId });
  return { ok: true };
}

export async function updateSystemSettings(formData: FormData): Promise<SettingsResult> {
  const admin = await requireAdmin();
  const horizonDays = Number(formData.get("horizonDays"));
  const missedGraceMinutes = Number(formData.get("missedGraceMinutes"));
  const keyExpiry = String(formData.get("apiKeyExpiresAt") ?? "");

  if (Number.isFinite(horizonDays) && horizonDays >= 7 && horizonDays <= 90) {
    setSetting("horizonDays", horizonDays);
  }
  if (Number.isFinite(missedGraceMinutes) && missedGraceMinutes >= 1 && missedGraceMinutes <= 30) {
    setSetting("missedGraceMinutes", missedGraceMinutes);
  }
  updateSystemState({
    apiKeyExpiresAt: /^\d{4}-\d{2}-\d{2}$/.test(keyExpiry) ? Date.parse(`${keyExpiry}T23:59:59`) : null,
  });
  writeAudit({ userId: admin.id, action: "settings.update", detail: { horizonDays, missedGraceMinutes, keyExpiry } });
  materialize();
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * The console's own network address — where devices (today: the NVR delivering
 * keychain-remote presses) reach this machine. The reverse of PROTECT_HOST,
 * which is where this machine reaches the NVR.
 */
export async function setConsoleAddress(formData: FormData): Promise<SettingsResult> {
  const admin = await requireAdmin();
  const parsed = validateBaseUrl(String(formData.get("baseUrl") ?? ""));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  setSetting(FOB_BASE_URL_KEY, parsed.value);
  writeAudit({ userId: admin.id, action: "fob.settings_update", detail: { baseUrl: parsed.value } });
  requestFobReconcile();
  await attemptFobReconcile(realAdapter);
  revalidatePath("/settings");
  revalidatePath("/remotes");
  return { ok: true };
}

/** Clears the TTS re-validate flag by running a live TTS smoke test first. */
export async function clearTtsFlag(): Promise<SettingsResult> {
  const admin = await requireAdmin();
  const macs = resolveTargetMacs(null);
  if (macs.length === 0) return { ok: false, error: "No speakers found." };
  const { outcome } = await triggerManualRun(realAdapter, {
    source: "MANUAL",
    requestedBy: admin.id,
    adhoc: { ttsText: "Announcement check. This is a system test.", ttsTone: "welcome", targetMacs: macs },
    ...localDateTimeParts(),
  });
  if (outcome.status !== "SUCCESS") {
    return {
      ok: false,
      error: `The test did not play (${outcome.message ?? outcome.status}). Spoken announcements still need attention.`,
    };
  }
  updateSystemState({ ttsRevalidateFlag: false, ttsFlagReason: null });
  writeAudit({ userId: admin.id, action: "protect.tts_revalidated" });
  revalidatePath("/settings");
  return { ok: true };
}

export async function backupNow(): Promise<SettingsResult> {
  const admin = await requireAdmin();
  try {
    const result = createManualSnapshot({ sqlite, backupRoot: resolve(projectRoot, "backups") });
    writeAudit({ userId: admin.id, action: "system.backup", detail: { path: result.path, kind: "manual" } });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not save the local backup: ${(error as Error).message}`.slice(0, 240) };
  }
}

export async function getRetentionInfo(): Promise<{ horizonDays: number; missedGraceMinutes: number }> {
  await requireAdmin();
  return {
    horizonDays: getSettingNumber("horizonDays", 35),
    missedGraceMinutes: getSettingNumber("missedGraceMinutes", 2),
  };
}

export async function getKeyExpiry(): Promise<number | null> {
  await requireAdmin();
  return getSystemState().apiKeyExpiresAt;
}
