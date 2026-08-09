import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { EventEditor } from "./event-editor";

export const dynamic = "force-dynamic";

export default async function PlanDetailPage({ params }: PageProps<"/plans/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  const plan = db.select().from(schema.bellPlans).where(eq(schema.bellPlans.id, Number(id))).get();
  if (!plan) notFound();

  const events = db
    .select()
    .from(schema.bellEvents)
    .where(eq(schema.bellEvents.bellPlanId, plan.id))
    .orderBy(asc(schema.bellEvents.time))
    .all();
  const cues = db
    .select({ id: schema.soundCues.id, name: schema.soundCues.name })
    .from(schema.soundCues)
    .where(eq(schema.soundCues.isEnabled, true))
    .orderBy(asc(schema.soundCues.name))
    .all();

  return (
    <>
      <Link
        href="/plans"
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> All plans
      </Link>
      <PageHeader
        title={plan.name}
        description={plan.description ?? "These bells ring on any day this plan is used."}
      />
      <EventEditor
        planId={plan.id}
        events={events.map((e) => ({
          id: e.id,
          time: e.time,
          label: e.label,
          cueId: e.cueId,
          isEnabled: e.isEnabled,
        }))}
        cues={cues}
        isAdmin={user.role === "ADMIN"}
      />
    </>
  );
}
