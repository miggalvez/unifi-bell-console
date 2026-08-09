"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";

export interface PauseResult {
  ok: boolean;
  error?: string;
}

const FAR_FUTURE = 4102444800000; // 2100-01-01 — the "indefinite" sentinel

export async function setPause(formData: FormData): Promise<PauseResult> {
  const user = await requireAdmin();
  const reason = String(formData.get("reason") ?? "").trim();
  const minutesRaw = String(formData.get("minutes") ?? "");
  if (!reason) return { ok: false, error: "A visible reason is required." };

  const now = Date.now();
  const pausedUntil = minutesRaw === "indefinite" ? FAR_FUTURE : now + Number(minutesRaw) * 60_000;
  if (!Number.isFinite(pausedUntil) || pausedUntil <= now) {
    return { ok: false, error: "Pick a duration." };
  }

  updateSystemState({ pausedUntil, pauseReason: reason, pausedBy: user.id, pausedAt: now });
  writeAudit({ userId: user.id, action: "pause.enable", detail: { reason, pausedUntil } });
  return { ok: true };
}

export async function clearPause(): Promise<PauseResult> {
  const user = await requireAdmin();
  updateSystemState({ pausedUntil: null, pauseReason: null, pausedBy: null, pausedAt: null });
  writeAudit({ userId: user.id, action: "pause.disable" });
  return { ok: true };
}
