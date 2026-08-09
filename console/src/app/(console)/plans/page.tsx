import { asc, eq, gte, and } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { PlansList, type PlanListItem } from "./plans-list";

export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const user = await requireUser();
  const plans = db.select().from(schema.bellPlans).orderBy(asc(schema.bellPlans.name)).all();
  const events = db
    .select({
      planId: schema.bellEvents.bellPlanId,
      time: schema.bellEvents.time,
      isEnabled: schema.bellEvents.isEnabled,
    })
    .from(schema.bellEvents)
    .orderBy(asc(schema.bellEvents.time))
    .all();
  const week = db.select().from(schema.weekSchedule).all();
  const { localDate: today } = localDateTimeParts();
  const upcoming = db
    .select({ planId: schema.calendarExceptions.bellPlanId })
    .from(schema.calendarExceptions)
    .where(and(eq(schema.calendarExceptions.type, "USE_PLAN"), gte(schema.calendarExceptions.date, today)))
    .all();

  const items: PlanListItem[] = plans.map((p) => {
    const mine = events.filter((e) => e.planId === p.id);
    const ringing = mine.filter((e) => e.isEnabled);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      isArchived: p.isArchived,
      bellCount: ringing.length,
      offCount: mine.length - ringing.length,
      // Events arrive time-sorted, so the day's shape is the two ends.
      firstTime: ringing[0]?.time ?? null,
      lastTime: ringing.at(-1)?.time ?? null,
      days: week.filter((w) => w.bellPlanId === p.id).map((w) => w.dayOfWeek),
      upcomingDates: upcoming.filter((u) => u.planId === p.id).length,
    };
  });

  return (
    <>
      <PageHeader
        title="Bell Plans"
        description="Reusable daily templates — assign them to weekdays or specific dates on the Schedule page."
      />
      <PlansList plans={items} isAdmin={user.role === "ADMIN"} />
    </>
  );
}
