import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { listZonesWithMembers } from "@/lib/zones";
import { PageHeader } from "@/components/page-header";
import { SpeakersTable } from "./speakers-table";
import { ZonesPanel } from "./zones-panel";

export const dynamic = "force-dynamic";

export default async function SpeakersPage() {
  const user = await requireUser();
  const zones = listZonesWithMembers();
  const speakers = db
    .select({ mac: schema.speakers.mac, name: schema.speakers.name })
    .from(schema.speakers)
    .orderBy(asc(schema.speakers.name))
    .all();

  return (
    <>
      <PageHeader
        title="Speakers"
        description="Your speakers and how they're grouped. Updates every few seconds."
      />
      <div className="space-y-6">
        <SpeakersTable />
        <ZonesPanel zones={zones} speakers={speakers} isAdmin={user.role === "ADMIN"} />
      </div>
    </>
  );
}
