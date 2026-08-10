import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { HealthCard } from "@/components/health-card";
import { PauseCard } from "@/components/overview-cards";
import { TodayScheduleCard } from "@/components/today-schedule-card";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Overview" description="Today's bell plan, system status, and quick actions." />
      <div className="space-y-6">
        <HealthCard />
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
          <TodayScheduleCard isAdmin={user.role === "ADMIN"} />
          <PauseCard isAdmin={user.role === "ADMIN"} />
        </div>
      </div>
    </>
  );
}
