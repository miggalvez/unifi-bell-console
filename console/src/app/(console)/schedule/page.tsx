import { asc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { nowLocal } from "@/lib/scheduler/time";
import { PageHeader } from "@/components/page-header";
import { ExceptionsEditor, WeekEditor, type ExceptionItem } from "./schedule-editor";

export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";

  const plans = db
    .select({ id: schema.bellPlans.id, name: schema.bellPlans.name })
    .from(schema.bellPlans)
    .where(eq(schema.bellPlans.isArchived, false))
    .orderBy(asc(schema.bellPlans.name))
    .all();

  const week = db.select().from(schema.weekSchedule).all();
  const assignments: (number | null)[] = Array.from({ length: 7 }, (_, d) => {
    return week.find((w) => w.dayOfWeek === d)?.bellPlanId ?? null;
  });

  const today = nowLocal().toFormat("yyyy-MM-dd");
  const exceptions = db
    .select({
      id: schema.calendarExceptions.id,
      date: schema.calendarExceptions.date,
      type: schema.calendarExceptions.type,
      note: schema.calendarExceptions.note,
      planName: schema.bellPlans.name,
    })
    .from(schema.calendarExceptions)
    .leftJoin(schema.bellPlans, eq(schema.calendarExceptions.bellPlanId, schema.bellPlans.id))
    .where(gte(schema.calendarExceptions.date, today))
    .orderBy(asc(schema.calendarExceptions.date))
    .all() as ExceptionItem[];

  return (
    <>
      <PageHeader
        title="Schedule"
        description="Assign bell plans to weekdays and manage single-date exceptions."
      />
      <div className="space-y-6">
        <WeekEditor assignments={assignments} plans={plans} isAdmin={isAdmin} />
        <ExceptionsEditor exceptions={exceptions} plans={plans} isAdmin={isAdmin} />
      </div>
    </>
  );
}
