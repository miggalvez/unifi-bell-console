"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { materialize } from "@/lib/scheduler/materializer";

export interface PlanActionResult {
  ok: boolean;
  error?: string;
  planId?: number;
}

function rematerialize(): void {
  materialize();
  revalidatePath("/plans");
  revalidatePath("/schedule");
  revalidatePath("/");
}

export async function createPlan(name: string): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Plan name is required." };
  const now = Date.now();
  try {
    const created = db
      .insert(schema.bellPlans)
      .values({ name: trimmed, createdAt: now, updatedAt: now })
      .returning({ id: schema.bellPlans.id })
      .get();
    writeAudit({ userId: user.id, action: "plan.create", targetType: "plan", targetId: created.id, detail: { name: trimmed } });
    revalidatePath("/plans");
    return { ok: true, planId: created.id };
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, error: msg.includes("UNIQUE") ? "A plan with that name exists." : msg.slice(0, 200) };
  }
}

export async function duplicatePlan(id: number): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const plan = db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, id)).get();
  if (!plan) return { ok: false, error: "Plan not found." };
  const events = db.select().from(schema.bellEvents).where(eq(schema.bellEvents.bellPlanId, id)).all();
  const now = Date.now();
  let name = `${plan.name} (copy)`;
  let attempt = 2;
  while (db.select().from(schema.bellPlans).where(eq(schema.bellPlans.name, name)).get()) {
    name = `${plan.name} (copy ${attempt++})`;
  }
  const created = db
    .insert(schema.bellPlans)
    .values({ name, description: plan.description, createdAt: now, updatedAt: now })
    .returning({ id: schema.bellPlans.id })
    .get();
  for (const ev of events) {
    db.insert(schema.bellEvents)
      .values({ bellPlanId: created.id, time: ev.time, cueId: ev.cueId, label: ev.label, isEnabled: ev.isEnabled })
      .run();
  }
  writeAudit({ userId: user.id, action: "plan.duplicate", targetType: "plan", targetId: created.id, detail: { from: id } });
  revalidatePath("/plans");
  return { ok: true, planId: created.id };
}

export async function setPlanArchived(id: number, archived: boolean): Promise<PlanActionResult> {
  const user = await requireAdmin();
  db.update(schema.bellPlans).set({ isArchived: archived, updatedAt: Date.now() }).where(eq(schema.bellPlans.id, id)).run();
  writeAudit({ userId: user.id, action: archived ? "plan.archive" : "plan.unarchive", targetType: "plan", targetId: id });
  rematerialize();
  return { ok: true };
}

export async function addEvent(planId: number, formData: FormData): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const time = String(formData.get("time") ?? "");
  const cueId = Number(formData.get("cueId") ?? 0);
  const label = String(formData.get("label") ?? "").trim() || null;
  if (!/^\d{2}:\d{2}$/.test(time)) return { ok: false, error: "Time must be HH:MM." };
  if (!cueId) return { ok: false, error: "Choose a cue." };
  const created = db
    .insert(schema.bellEvents)
    .values({ bellPlanId: planId, time, cueId, label })
    .returning({ id: schema.bellEvents.id })
    .get();
  writeAudit({ userId: user.id, action: "plan.add_event", targetType: "event", targetId: created.id, detail: { planId, time, cueId, label } });
  rematerialize();
  revalidatePath(`/plans/${planId}`);
  return { ok: true };
}

export async function updateEvent(
  eventId: number,
  patch: { time?: string; cueId?: number; label?: string | null; isEnabled?: boolean },
): Promise<PlanActionResult> {
  const user = await requireAdmin();
  if (patch.time !== undefined && !/^\d{2}:\d{2}$/.test(patch.time)) {
    return { ok: false, error: "Time must be HH:MM." };
  }
  const ev = db.select().from(schema.bellEvents).where(eq(schema.bellEvents.id, eventId)).get();
  if (!ev) return { ok: false, error: "Event not found." };
  db.update(schema.bellEvents).set(patch).where(eq(schema.bellEvents.id, eventId)).run();
  writeAudit({ userId: user.id, action: "plan.update_event", targetType: "event", targetId: eventId, detail: patch });
  rematerialize();
  revalidatePath(`/plans/${ev.bellPlanId}`);
  return { ok: true };
}

export async function deleteEvent(eventId: number): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const ev = db.select().from(schema.bellEvents).where(eq(schema.bellEvents.id, eventId)).get();
  if (!ev) return { ok: true };
  db.delete(schema.bellEvents).where(eq(schema.bellEvents.id, eventId)).run();
  writeAudit({ userId: user.id, action: "plan.delete_event", targetType: "event", targetId: eventId });
  rematerialize();
  revalidatePath(`/plans/${ev.bellPlanId}`);
  return { ok: true };
}
