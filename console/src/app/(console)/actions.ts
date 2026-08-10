"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";
import { DateTime } from "luxon";
import { env } from "@/env";

export interface PauseResult {
  ok: boolean;
  error?: string;
}

const FAR_FUTURE = 4102444800000; // 2100-01-01 — the "indefinite" sentinel

export async function setPause(formData: FormData): Promise<PauseResult> {
  const user = await requireAdmin();
  const reason = String(formData.get("reason") ?? "").trim();
  const minutesRaw = String(formData.get("minutes") ?? "");
  const pauseUntilRaw = String(formData.get("pauseUntil") ?? "");
  if (!reason) return { ok: false, error: "A visible reason is required." };

  const now = Date.now();
  const localNow = DateTime.fromMillis(now, { zone: env.schoolTz });
  let pausedUntil: number;
  if (minutesRaw === "indefinite") {
    pausedUntil = FAR_FUTURE;
  } else if (minutesRaw === "end_of_day") {
    pausedUntil = localNow.endOf("day").toMillis();
  } else if (minutesRaw === "until_time") {
    if (!/^\d{2}:\d{2}$/.test(pauseUntilRaw)) return { ok: false, error: "Pick a resume time." };
    pausedUntil = DateTime.fromISO(`${localNow.toFormat("yyyy-MM-dd")}T${pauseUntilRaw}`, {
      zone: env.schoolTz,
    }).toMillis();
  } else {
    pausedUntil = now + Number(minutesRaw) * 60_000;
  }
  if (!Number.isFinite(pausedUntil) || pausedUntil <= now) {
    return { ok: false, error: minutesRaw === "until_time" ? "Pick a time later today." : "Pick a duration." };
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
