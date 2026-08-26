"use server";

import { and, eq, gte, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema, sqlite } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { materialize } from "@/lib/scheduler/materializer";
import { localDateTimeParts } from "@/lib/scheduler/time";

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

/**
 * The name is the plan's identity everywhere it appears — the Schedule page,
 * today's card, the audit trail — so a rename is a plain update: queued bells
 * carry no name snapshot and nothing needs re-materializing.
 */
export async function renamePlan(id: number, name: string): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Plan name is required." };
  const plan = db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, id)).get();
  if (!plan) return { ok: false, error: "Plan not found." };
  if (trimmed === plan.name) return { ok: true, planId: id };
  try {
    db.update(schema.bellPlans).set({ name: trimmed, updatedAt: Date.now() }).where(eq(schema.bellPlans.id, id)).run();
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, error: msg.includes("UNIQUE") ? "A plan with that name exists." : msg.slice(0, 200) };
  }
  writeAudit({
    userId: user.id,
    action: "plan.rename",
    targetType: "plan",
    targetId: id,
    detail: { from: plan.name, to: trimmed },
  });
  revalidatePath("/plans");
  revalidatePath(`/plans/${id}`);
  revalidatePath("/schedule");
  revalidatePath("/");
  return { ok: true, planId: id };
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

/**
 * Deleting a plan is allowed only once nothing FUTURE depends on it: weekday
 * assignments and upcoming calendar dates refuse loudly, because cascading
 * through them would silently change what rings. History is safe by design —
 * past runs keep their name/time snapshots, and their event links go null.
 */
export async function deletePlan(id: number): Promise<PlanActionResult> {
  const user = await requireAdmin();
  const plan = db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, id)).get();
  if (!plan) return { ok: true };

  const assignedDays = db
    .select({ day: schema.weekSchedule.dayOfWeek })
    .from(schema.weekSchedule)
    .where(eq(schema.weekSchedule.bellPlanId, id))
    .all();
  if (assignedDays.length > 0) {
    return {
      ok: false,
      error: `"${plan.name}" still rings on the weekly schedule — assign those days to another plan first (Schedule page).`,
    };
  }

  const { localDate: today } = localDateTimeParts();
  const upcoming = db
    .select({ date: schema.calendarExceptions.date })
    .from(schema.calendarExceptions)
    .where(and(eq(schema.calendarExceptions.bellPlanId, id), gte(schema.calendarExceptions.date, today)))
    .all();
  if (upcoming.length > 0) {
    return {
      ok: false,
      error: `${upcoming.length} upcoming date${upcoming.length === 1 ? "" : "s"} (first: ${upcoming[0].date}) still use${upcoming.length === 1 ? "s" : ""} "${plan.name}" — change those days first (Schedule page).`,
    };
  }

  const eventIds = db
    .select({ id: schema.bellEvents.id })
    .from(schema.bellEvents)
    .where(eq(schema.bellEvents.bellPlanId, id))
    .all()
    .map((e) => e.id);

  const tx = sqlite.transaction(() => {
    // Any still-queued bells from this plan must not outlive it: their event
    // link would go null on cascade and they would ring as orphans.
    if (eventIds.length > 0) {
      db.delete(schema.scheduledRuns)
        .where(
          and(
            eq(schema.scheduledRuns.source, "SCHEDULE"),
            eq(schema.scheduledRuns.status, "PENDING"),
            inArray(schema.scheduledRuns.bellEventId, eventIds),
          ),
        )
        .run();
    }
    // Cascades: bell_events (and their one-day overrides), past calendar
    // exceptions. Run history keeps its snapshots with event links nulled.
    db.delete(schema.bellPlans).where(eq(schema.bellPlans.id, id)).run();
  });
  tx.immediate();

  writeAudit({
    userId: user.id,
    action: "plan.delete",
    targetType: "plan",
    targetId: id,
    detail: { name: plan.name, bells: eventIds.length },
  });
  rematerialize();
  return { ok: true };
}
