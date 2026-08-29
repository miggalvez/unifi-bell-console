import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireAdmin } from "@/lib/auth/guards";
import { getSetting } from "@/lib/state";
import { FOB_BASE_URL_KEY } from "@/lib/fobs/provision";
import { PageHeader } from "@/components/page-header";
import { RemotesPanel } from "./remotes-panel";

export const dynamic = "force-dynamic";

export default async function RemotesPage() {
  await requireAdmin();

  const cues = db
    .select({
      id: schema.soundCues.id,
      name: schema.soundCues.name,
      isEmergency: schema.soundCues.isEmergency,
      isEnabled: schema.soundCues.isEnabled,
    })
    .from(schema.soundCues)
    .orderBy(asc(schema.soundCues.sortOrder), asc(schema.soundCues.name))
    .all();

  return (
    <>
      <PageHeader
        title="Remotes"
        description="Keychain remotes (fobs) adopted in UniFi Protect. Map buttons to announcements and alerts — the console sets up the NVR side automatically."
      />
      <RemotesPanel
        cues={cues.filter((c) => c.isEnabled)}
        initialBaseUrl={getSetting<string | null>(FOB_BASE_URL_KEY, null)}
      />
    </>
  );
}
