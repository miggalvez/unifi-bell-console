import { asc, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/env";
import { requireAdmin } from "@/lib/auth/guards";
import { getSettingNumber, getSystemState } from "@/lib/state";
import { PageHeader } from "@/components/page-header";
import { SystemPanel, UsersPanel, type UserItem } from "./settings-panels";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const admin = await requireAdmin();
  const users = db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      role: schema.users.role,
      canEmergency: schema.users.canEmergency,
      isDisabled: schema.users.isDisabled,
    })
    .from(schema.users)
    .orderBy(asc(schema.users.username))
    .all() as UserItem[];

  const state = getSystemState();
  const latestVersion = db
    .select()
    .from(schema.protectVersions)
    .orderBy(desc(schema.protectVersions.id))
    .limit(1)
    .get();

  return (
    <>
      <PageHeader title="Settings" description="Accounts, scheduler configuration, and maintenance." />
      <div className="space-y-6">
        <UsersPanel users={users} selfId={admin.id} />
        <SystemPanel
          horizonDays={getSettingNumber("horizonDays", 35)}
          missedGraceMinutes={getSettingNumber("missedGraceMinutes", 2)}
          apiKeyExpiresAt={state.apiKeyExpiresAt}
          ttsRevalidate={state.ttsRevalidateFlag}
          protectVersion={latestVersion?.protectVersion ?? null}
          protectHost={env.protectHost}
        />
      </div>
    </>
  );
}
