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

export interface SettingsResult {
  ok: boolean;
  error?: string;
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
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };

  const now = Date.now();
  try {
    const created = db
      .insert(schema.users)
      .values({
        username,
        displayName,
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
  patch: { role?: "ADMIN" | "STAFF"; canEmergency?: boolean; isDisabled?: boolean },
): Promise<SettingsResult> {
  const admin = await requireAdmin();
  if (userId === admin.id && (patch.isDisabled || patch.role === "STAFF")) {
    return { ok: false, error: "You cannot demote or disable your own account." };
  }
  db.update(schema.users).set({ ...patch, updatedAt: Date.now() }).where(eq(schema.users.id, userId)).run();
  if (patch.isDisabled) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).run();
  }
  writeAudit({ userId: admin.id, action: "user.update", targetType: "user", targetId: userId, detail: patch });
  revalidatePath("/settings");
  return { ok: true };
}

export async function resetUserPassword(userId: number, password: string): Promise<SettingsResult> {
  const admin = await requireAdmin();
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
