"use client";

import { useActionState, useRef, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Cloud, DatabaseBackup, HardDrive, KeyRound, Plus, ShieldAlert, ShieldCheck, Volume2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckboxField, Field, SelectField } from "@/components/fields";
import { DatePicker } from "@/components/pickers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  backupNow,
  clearTtsFlag,
  createUser,
  resetUserPassword,
  updateSystemSettings,
  updateUser,
  type SettingsResult,
} from "./actions";

export interface UserItem {
  id: number;
  username: string;
  displayName: string;
  role: "ADMIN" | "STAFF";
  canEmergency: boolean;
  isDisabled: boolean;
}

export interface BackupChannel {
  lastAttempt: string;
  lastSuccess: string;
  error: string | null;
  healthy: boolean;
}

const initial: SettingsResult = { ok: false };

export function UsersPanel({ users, selfId }: { users: UserItem[]; selfId: number }) {
  const [state, formAction, pending] = useActionState(createUser, initial);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff accounts</CardTitle>
        <CardDescription>
          Staff can play announcements and see everything. Administrators can also change the
          schedule, sounds, accounts, and settings. Emergency permission is granted separately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Emergency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === selfId} />
              ))}
            </TableBody>
          </Table>
        </div>

        <form ref={formRef} action={formAction} className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">Add someone</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field label="Username">
              <Input name="username" placeholder="jsmith" required />
            </Field>
            <Field label="Display name">
              <Input name="displayName" placeholder="Jane Smith" />
            </Field>
            <Field label="Temporary password">
              <Input name="password" type="password" required />
            </Field>
            <Field label="Role">
              <SelectField
                name="role"
                defaultValue="STAFF"
                options={[
                  { value: "STAFF", label: "Staff" },
                  { value: "ADMIN", label: "Administrator" },
                ]}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <CheckboxField
              name="canEmergency"
              label="Can play emergency announcements"
              description="Granted separately from the role"
            />
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" /> Add
            </Button>
          </div>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}

function UserRow({ user, isSelf }: { user: UserItem; isSelf: boolean }) {
  const [pending, startTransition] = useTransition();

  const patch = (p: Parameters<typeof updateUser>[1]) =>
    startTransition(async () => {
      const r = await updateUser(user.id, p);
      if (!r.ok) toast.error(r.error ?? "Failed");
    });

  return (
    <TableRow className={user.isDisabled ? "opacity-50" : ""}>
      <TableCell>
        <div className="text-sm font-medium">{user.displayName}</div>
        <div className="text-xs text-muted-foreground">
          {user.username}
          {isSelf ? " (you)" : ""}
        </div>
      </TableCell>
      <TableCell>
        <SelectField
          size="sm"
          className="w-36"
          value={user.role}
          disabled={pending || isSelf}
          options={[
            { value: "STAFF", label: "Staff" },
            { value: "ADMIN", label: "Administrator" },
          ]}
          onValueChange={(v) => patch({ role: v as "ADMIN" | "STAFF" })}
        />
      </TableCell>
      <TableCell>
        <button
          type="button"
          disabled={pending}
          onClick={() => patch({ canEmergency: !user.canEmergency })}
          title="Click to change emergency permission"
        >
          {user.canEmergency ? (
            <Badge className="border-transparent bg-destructive/10 text-destructive">
              <ShieldAlert className="size-3" /> Allowed
            </Badge>
          ) : (
            <Badge variant="outline">
              <ShieldCheck className="size-3" /> No
            </Badge>
          )}
        </button>
      </TableCell>
      <TableCell>
        {user.isDisabled ? <Badge variant="outline">Disabled</Badge> : <Badge variant="secondary">Active</Badge>}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              const pw = prompt(`New password for ${user.username} (min 8 chars):`);
              if (!pw) return;
              startTransition(async () => {
                const r = await resetUserPassword(user.id, pw);
                if (r.ok) toast.success("Password reset");
                else toast.error(r.error ?? "Failed");
              });
            }}
          >
            Reset password
          </Button>
          {!isSelf ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => patch({ isDisabled: !user.isDisabled })}
            >
              {user.isDisabled ? "Enable" : "Disable"}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function SystemPanel({
  horizonDays,
  missedGraceMinutes,
  apiKeyExpiresAt,
  ttsRevalidate,
  protectVersion,
  protectHost,
}: {
  horizonDays: number;
  missedGraceMinutes: number;
  apiKeyExpiresAt: number | null;
  ttsRevalidate: boolean;
  protectVersion: string | null;
  protectHost: string;
}) {
  const [pending, startTransition] = useTransition();
  const keyDate = apiKeyExpiresAt ? new Date(apiKeyExpiresAt).toLocaleDateString("sv") : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
        <CardDescription>
          Connected to the speaker system at {protectHost} (UniFi Protect {protectVersion ?? "—"}).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={(fd) =>
            startTransition(async () => {
              const r = await updateSystemSettings(fd);
              if (r.ok) toast.success("Settings saved");
              else toast.error(r.error ?? "Failed");
            })
          }
          className="space-y-4"
        >
          {/* A grid, not a flex row: hint text of differing heights would
              otherwise push the inputs out of line with each other. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Plan bells this far ahead" hint="days">
              <Input type="number" name="horizonDays" defaultValue={horizonDays} min={7} max={90} className="max-w-28" />
            </Field>
            <Field label="Skip a bell if it's this late" hint="minutes — a late bell confuses more than it helps">
              <Input type="number" name="missedGraceMinutes" defaultValue={missedGraceMinutes} min={1} max={30} className="max-w-28" />
            </Field>
            <Field
              label="Speaker connection expires"
              hint={
                <span className="flex items-center gap-1">
                  <KeyRound className="size-3" /> from UniFi Protect → Integrations
                </span>
              }
            >
              <DatePicker name="apiKeyExpiresAt" defaultValue={keyDate} className="max-w-52" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="outline" disabled={pending}>
              Save
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap gap-2 border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await clearTtsFlag();
                if (r.ok) toast.success("Spoken announcements are working — you should have heard the test");
                else toast.error(r.error ?? "Failed");
              })
            }
          >
            <Volume2 className="size-4" />
            {ttsRevalidate ? "Test spoken announcements now" : "Test a spoken announcement"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BackupHealthPanel({
  local,
  offsite,
  dailyCount,
  latestRemoteKey,
}: {
  local: BackupChannel;
  offsite: BackupChannel;
  dailyCount: number;
  latestRemoteKey: string | null;
}) {
  const [pending, startTransition] = useTransition();

  const channel = (label: string, icon: ReactNode, value: BackupChannel, detail: string) => (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-medium">
          {icon} {label}
        </div>
        <Badge variant={value.healthy ? "secondary" : "outline"} className={value.healthy ? "" : "text-destructive"}>
          {value.healthy ? "Healthy" : "Needs attention"}
        </Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Last success</dt>
        <dd>{value.lastSuccess}</dd>
        <dt className="text-muted-foreground">Last attempt</dt>
        <dd>{value.lastAttempt}</dd>
        <dt className="text-muted-foreground">Retention</dt>
        <dd>{detail}</dd>
      </dl>
      {value.error ? <p className="text-sm text-destructive">{value.error}</p> : null}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backup health</CardTitle>
        <CardDescription>
          Local and off-site backups are independent. A valid backup includes the database and every catalogued recording.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-2">
          {channel("Local daily snapshots", <HardDrive className="size-4" />, local, `${dailyCount} of 14 daily snapshots retained`)}
          {channel("Cloudflare R2", <Cloud className="size-4" />, offsite, "30-day lock; expires after 90 days")}
        </div>
        {latestRemoteKey ? (
          <p className="break-all text-xs text-muted-foreground">Latest completed R2 backup: {latestRemoteKey}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">Manual backups are local-only and do not replace the daily or R2 jobs.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await backupNow();
                if (r.ok) toast.success("Manual local backup saved");
                else toast.error(r.error ?? "Failed");
              })
            }
          >
            <DatabaseBackup className="size-4" /> Save a manual local backup
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
