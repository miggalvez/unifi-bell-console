"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { materialize } from "@/lib/scheduler/materializer";

export interface ScheduleActionResult {
  ok: boolean;
  error?: string;
}

function rematerialize(): void {
  materialize();
  revalidatePath("/schedule");
  revalidatePath("/");
}

export async function setWeekDay(dayOfWeek: number, planId: number | null): Promise<ScheduleActionResult> {
  const user = await requireAdmin();
  if (dayOfWeek < 0 || dayOfWeek > 6) return { ok: false, error: "Invalid weekday." };
  db.insert(schema.weekSchedule)
    .values({ dayOfWeek, bellPlanId: planId })
    .onConflictDoUpdate({ target: schema.weekSchedule.dayOfWeek, set: { bellPlanId: planId } })
    .run();
  writeAudit({ userId: user.id, action: "schedule.set_weekday", detail: { dayOfWeek, planId } });
  rematerialize();
  return { ok: true };
}

export async function upsertException(formData: FormData): Promise<ScheduleActionResult> {
  const user = await requireAdmin();
  const date = String(formData.get("date") ?? "");
  const type = String(formData.get("type") ?? "");
  const planRaw = String(formData.get("bellPlanId") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Pick a date." };
  if (type !== "NO_SCHOOL" && type !== "USE_PLAN") return { ok: false, error: "Pick an exception type." };
  const bellPlanId = type === "USE_PLAN" ? Number(planRaw) : null;
  if (type === "USE_PLAN" && !bellPlanId) return { ok: false, error: "Choose the plan to use." };

  db.insert(schema.calendarExceptions)
    .values({ date, type, bellPlanId, note, createdBy: user.id, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.calendarExceptions.date,
      set: { type, bellPlanId, note, createdBy: user.id, createdAt: Date.now() },
    })
    .run();
  writeAudit({ userId: user.id, action: "schedule.set_exception", detail: { date, type, bellPlanId, note } });
  rematerialize();
  return { ok: true };
}

export async function deleteException(id: number): Promise<ScheduleActionResult> {
  const user = await requireAdmin();
  db.delete(schema.calendarExceptions).where(eq(schema.calendarExceptions.id, id)).run();
  writeAudit({ userId: user.id, action: "schedule.delete_exception", targetType: "exception", targetId: id });
  rematerialize();
  return { ok: true };
}
