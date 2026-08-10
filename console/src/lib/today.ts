import { and, asc, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, schema } from "@/lib/db/client";
import { env } from "@/env";
import { getSystemState } from "@/lib/state";
import { effectivePlanIdFor } from "@/lib/scheduler/materializer";
import { localToUtcEpoch, weekdayOf } from "@/lib/scheduler/time";

const WORKER_STALE_MS = 15_000;
const HEALTH_STALE_MS = 90_000;

export type TodayTimelineStatus =
  | typeof schema.scheduledRuns.$inferSelect.status
  | "SKIPPED_BY_STAFF"
  | "NOT_QUEUED";

export interface TodayTimelineItem {
  eventId: number | null;
  runId: number | null;
  label: string | null;
  cueName: string;
  originalTime: string;
  effectiveTime: string;
  scheduledAtUtc: number;
  status: TodayTimelineStatus;
  historical: boolean;
  override: { id: number; kind: "SKIP" | "DELAY" } | null;
  canUndo: boolean;
}

export interface TodayScheduleSnapshot {
  localDate: string;
  plan: { id: number; name: string } | null;
  regularPlanId: number | null;
  exception: { type: "NO_SCHOOL" | "USE_PLAN"; note: string | null } | null;
  plans: { id: number; name: string }[];
  timeline: TodayTimelineItem[];
  next: TodayTimelineItem | null;
  readiness: {
    tone: "ready" | "attention" | "quiet";
    title: string;
    detail: string;
    workerHeartbeatAt: number | null;
  };
}

/**
 * Staff-facing projection of the schedule definition, one-day overrides, and
 * materialized runs. Keeping it in one helper makes the dashboard and tests
 * agree on what "today is ready" means.
 */
export function getTodaySchedule(now = Date.now()): TodayScheduleSnapshot {
  const local = DateTime.fromMillis(now, { zone: env.schoolTz });
  const localDate = local.toFormat("yyyy-MM-dd");
  const state = getSystemState();

  const exception = db
    .select({ type: schema.calendarExceptions.type, note: schema.calendarExceptions.note })
    .from(schema.calendarExceptions)
    .where(eq(schema.calendarExceptions.date, localDate))
    .get() ?? null;

  const regularPlanId = db
    .select({ planId: schema.weekSchedule.bellPlanId })
    .from(schema.weekSchedule)
    .where(eq(schema.weekSchedule.dayOfWeek, weekdayOf(localDate)))
    .get()?.planId ?? null;
  const planId = effectivePlanIdFor(localDate);
  const plan = planId === null
    ? null
    : db
        .select({ id: schema.bellPlans.id, name: schema.bellPlans.name })
        .from(schema.bellPlans)
        .where(eq(schema.bellPlans.id, planId))
        .get() ?? null;

  const plans = db
    .select({ id: schema.bellPlans.id, name: schema.bellPlans.name })
    .from(schema.bellPlans)
    .where(eq(schema.bellPlans.isArchived, false))
    .orderBy(asc(schema.bellPlans.name))
    .all();

  const events = planId === null
    ? []
    : db
        .select({
          id: schema.bellEvents.id,
          time: schema.bellEvents.time,
          label: schema.bellEvents.label,
          cueName: schema.soundCues.name,
          deliveryMethod: schema.soundCues.deliveryMethod,
        })
        .from(schema.bellEvents)
        .innerJoin(schema.soundCues, eq(schema.bellEvents.cueId, schema.soundCues.id))
        .where(
          and(
            eq(schema.bellEvents.bellPlanId, planId),
            eq(schema.bellEvents.isEnabled, true),
            eq(schema.soundCues.isEnabled, true),
          ),
        )
        .orderBy(asc(schema.bellEvents.time))
        .all();

  const overrides = db
    .select()
    .from(schema.bellEventOverrides)
    .where(eq(schema.bellEventOverrides.localDate, localDate))
    .all();
  const overrideByEvent = new Map(overrides.map((override) => [override.bellEventId, override]));

  const runs = db
    .select()
    .from(schema.scheduledRuns)
    .where(and(eq(schema.scheduledRuns.source, "SCHEDULE"), eq(schema.scheduledRuns.localDate, localDate)))
    .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
    .all();
  const matchedRunIds = new Set<number>();

  const timeline: TodayTimelineItem[] = events.map((event) => {
    const override = overrideByEvent.get(event.id);
    const effectiveTime = override?.kind === "DELAY" && override.effectiveTime
      ? override.effectiveTime
      : event.time;
    const scheduledAtUtc = localToUtcEpoch(localDate, effectiveTime);
    const run = override?.kind === "SKIP"
      ? null
      : runs.find((candidate) => candidate.bellEventId === event.id && candidate.localTime === effectiveTime) ?? null;
    if (run) matchedRunIds.add(run.id);

    return {
      eventId: event.id,
      runId: run?.id ?? null,
      label: event.label,
      cueName: event.cueName,
      originalTime: event.time,
      effectiveTime,
      scheduledAtUtc,
      status: override?.kind === "SKIP" ? "SKIPPED_BY_STAFF" : (run?.status ?? "NOT_QUEUED"),
      historical: false,
      override: override ? { id: override.id, kind: override.kind } : null,
      canUndo: Boolean(override && scheduledAtUtc - now > 10_000),
    };
  });

  // A day-of plan switch keeps completed history from the previous plan. Show
  // those rows too, rather than making a bell disappear after it has rung.
  for (const run of runs) {
    if (matchedRunIds.has(run.id) || run.status === "PENDING") continue;
    timeline.push({
      eventId: run.bellEventId,
      runId: run.id,
      label: null,
      cueName: run.cueName ?? "Bell",
      originalTime: run.localTime,
      effectiveTime: run.localTime,
      scheduledAtUtc: run.scheduledAtUtc,
      status: run.status,
      historical: true,
      override: null,
      canUndo: false,
    });
  }
  timeline.sort((a, b) => a.scheduledAtUtc - b.scheduledAtUtc || Number(a.historical) - Number(b.historical));

  const next = timeline.find((item) => item.status === "PENDING" && item.scheduledAtUtc > now) ?? null;
  const upcomingExpected = timeline.filter(
    (item) => !item.historical && item.status !== "SKIPPED_BY_STAFF" && item.scheduledAtUtc > now,
  );
  const issues: string[] = [];
  const workerFresh = state.workerHeartbeatAt !== null && now - state.workerHeartbeatAt <= WORKER_STALE_MS;
  const healthFresh = state.lastHealthOkAt !== null && now - state.lastHealthOkAt <= HEALTH_STALE_MS;

  if (!workerFresh) issues.push("The automatic bell scheduler is not checking in.");
  if (state.consecutiveHealthFailures >= 3 || !healthFresh) {
    issues.push("The speaker system has not passed a recent connection check.");
  }
  const speakers = db.select({ state: schema.speakers.state }).from(schema.speakers).all();
  const online = speakers.filter((speaker) => speaker.state === "CONNECTED").length;
  if (speakers.length === 0) issues.push("No speakers have been discovered.");
  else if (online < speakers.length) issues.push(`${speakers.length - online} speaker${speakers.length - online === 1 ? " is" : "s are"} offline.`);
  if (state.lastMaterializedThrough === null || state.lastMaterializedThrough < localDate) {
    issues.push("Today's bell schedule has not been prepared.");
  }
  if (upcomingExpected.some((item) => item.status !== "PENDING")) {
    issues.push("One or more upcoming bells are not queued.");
  }
  if (events.some((event) => event.deliveryMethod === "PROTECT_NATIVE_TTS") && state.ttsRevalidateFlag) {
    issues.push("A spoken bell in today's plan needs testing after a system update.");
  }
  if (state.apiKeyExpiresAt !== null && state.apiKeyExpiresAt < now) {
    issues.push("The connection key for the speaker system has expired.");
  }

  let readiness: TodayScheduleSnapshot["readiness"];
  const intentionallyQuiet = exception?.type === "NO_SCHOOL" || plan === null;
  if (issues.length > 0) {
    readiness = {
      tone: "attention",
      title: "Scheduled bells need support",
      detail: issues[0],
      workerHeartbeatAt: state.workerHeartbeatAt,
    };
  } else if (intentionallyQuiet) {
    readiness = {
      tone: "quiet",
      title: "No bells scheduled today",
      detail: exception?.note ?? "The weekly schedule does not assign a bell plan today.",
      workerHeartbeatAt: state.workerHeartbeatAt,
    };
  } else if (events.length === 0) {
    readiness = {
      tone: "attention",
      title: "Today's plan has no bells",
      detail: "An administrator should review the selected bell plan.",
      workerHeartbeatAt: state.workerHeartbeatAt,
    };
  } else {
    const remaining = upcomingExpected.length;
    readiness = {
      tone: "ready",
      title: remaining === 0 ? "Today's bells are complete" : "Today is ready",
      detail: remaining === 0
        ? `${events.length} scheduled bell${events.length === 1 ? " has" : "s have"} finished for the day.`
        : `${remaining} bell${remaining === 1 ? "" : "s"} remaining on ${plan?.name ?? "today's plan"}.`,
      workerHeartbeatAt: state.workerHeartbeatAt,
    };
  }

  return { localDate, plan, regularPlanId, exception, plans, timeline, next, readiness };
}
