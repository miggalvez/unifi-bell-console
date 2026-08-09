import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { HealthCard } from "@/components/health-card";
import { NextRunsCard, PauseCard } from "@/components/overview-cards";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Overview" description="System status, next bells, and quick actions." />
      <div className="space-y-6">
        <HealthCard />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <NextRunsCard />
          <PauseCard isAdmin={user.role === "ADMIN"} />
        </div>
      </div>
    </>
  );
}
