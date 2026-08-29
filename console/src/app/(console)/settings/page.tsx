import { asc, desc, ne } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { db, schema } from "@/lib/db/client";
import { env, projectRoot } from "@/env";
import { requireAdmin } from "@/lib/auth/guards";
import { FOB_SERVICE_USERNAME } from "@/lib/fobs/service-user";
import { FOB_BASE_URL_KEY } from "@/lib/fobs/provision";
import { getSetting, getSettingNumber, getSystemState } from "@/lib/state";
import { PageHeader } from "@/components/page-header";
import { BackupHealthPanel, SystemPanel, UsersPanel, type BackupChannel, type UserItem } from "./settings-panels";
import { ConsoleAddressPanel } from "./console-address-panel";

export const dynamic = "force-dynamic";

const BACKUP_STALE_MS = 36 * 60 * 60_000;

function backupTime(value: number | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: env.schoolTz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function backupChannel(lastAttempt: number | null, lastSuccess: number | null, error: string | null): BackupChannel {
  const unfinished = lastAttempt !== null && (lastSuccess === null || lastAttempt > lastSuccess);
  return {
    lastAttempt: backupTime(lastAttempt),
    lastSuccess: backupTime(lastSuccess),
    error: error ?? (unfinished ? "The latest attempt did not complete." : null),
    healthy: lastSuccess !== null && Date.now() - lastSuccess <= BACKUP_STALE_MS && !unfinished && error === null,
  };
}

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
    // The keychain-remote service account is machinery, not an account anyone
    // manages here — hiding it also keeps its no-login hash unresettable.
    .where(ne(schema.users.username, FOB_SERVICE_USERNAME))
    .orderBy(asc(schema.users.username))
    .all() as UserItem[];

  const state = getSystemState();
  const latestVersion = db
    .select()
    .from(schema.protectVersions)
    .orderBy(desc(schema.protectVersions.id))
    .limit(1)
    .get();
  const dailyDir = resolve(projectRoot, "backups", "daily");
  const dailyCount = existsSync(dailyDir)
    ? readdirSync(dailyDir).filter((name) => /^bell-\d{4}-\d{2}-\d{2}\.db$/.test(name)).length
    : 0;

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
        <ConsoleAddressPanel baseUrl={getSetting<string | null>(FOB_BASE_URL_KEY, null)} />
        <BackupHealthPanel
          local={backupChannel(state.localBackupLastAttemptAt, state.localBackupLastSuccessAt, state.localBackupLastError)}
          offsite={backupChannel(
            state.offsiteBackupLastAttemptAt,
            state.offsiteBackupLastSuccessAt,
            state.offsiteBackupLastError,
          )}
          dailyCount={dailyCount}
          latestRemoteKey={state.lastCompletedR2Key}
        />
      </div>
    </>
  );
}
