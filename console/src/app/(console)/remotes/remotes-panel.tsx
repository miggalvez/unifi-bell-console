"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { BatteryFull, BatteryLow, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Field, SelectField, StatusDot } from "@/components/fields";
import { swrFetcher, timeAgo } from "@/lib/format";
import {
  createFobMapping,
  deleteFobMapping,
  reapplyFobAlarms,
  refreshFobs,
  setFobMappingEnabled,
  updateFobMapping,
} from "./actions";

// UI copies of the enum labels — the provisioning module is server-only.
const BUTTON_LABELS: Record<string, string> = {
  arm: "Arm",
  night: "Night Mode",
  disarm: "Disarm",
  panic: "Panic",
  left: "Left",
  right: "Right",
};
const PRESS_LABELS: Record<string, string> = {
  press: "Single press",
  longPress: "Long press (3s)",
  doublePress: "Double press",
};
const ACTION_LABELS: Record<string, string> = {
  START_ALERT: "Start repeating alert",
  TRIGGER_CUE: "Play once",
  STOP_ALERT: "Stop the alert",
};

export interface CueOption {
  id: number;
  name: string;
  isEmergency: boolean;
  isEnabled: boolean;
}

interface FobRow {
  mac: string;
  name: string | null;
  state: string | null;
  batteryStatus: string | null;
  firmwareVersion: string | null;
  lastSeenAt: number | null;
  lastPolledAt: number | null;
}

interface MappingRow {
  id: number;
  fobMac: string;
  button: string;
  pressType: string;
  action: "START_ALERT" | "TRIGGER_CUE" | "STOP_ALERT";
  cueId: number | null;
  repeatSeconds: number | null;
  isEnabled: boolean;
  provisionState: "PENDING" | "OK" | "ERROR" | "UNSUPPORTED";
  provisionError: string | null;
  lastTriggeredAt: number | null;
}

interface FobsData {
  fobs: FobRow[];
  mappings: MappingRow[];
  baseUrl: string | null;
  reconcile: { lastAt: number | null; lastError: string | null; pending: boolean };
}

const refresh = () => mutate("/api/fobs");

function ProvisionBadge({ m }: { m: MappingRow }) {
  if (!m.isEnabled) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <StatusDot tone="muted" /> Off
      </span>
    );
  }
  switch (m.provisionState) {
    case "OK":
      return (
        <span className="inline-flex items-center gap-2 text-sm text-success">
          <StatusDot tone="success" /> Active
        </span>
      );
    case "PENDING":
      return (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Applying…
        </span>
      );
    case "ERROR":
      return (
        <span className="inline-flex items-center gap-2 text-sm text-destructive" title={m.provisionError ?? undefined}>
          <StatusDot tone="danger" /> Error
        </span>
      );
    case "UNSUPPORTED":
      return (
        <span className="inline-flex items-center gap-2 text-sm text-warning" title={m.provisionError ?? undefined}>
          <StatusDot tone="warning" /> Unsupported
        </span>
      );
  }
}

function Battery({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let status: { percentage?: number; isLow?: boolean };
  try {
    status = JSON.parse(raw);
  } catch {
    return null;
  }
  if (status.percentage == null && status.isLow == null) return null;
  const low = status.isLow === true;
  const Icon = low ? BatteryLow : BatteryFull;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${low ? "text-destructive" : "text-muted-foreground"}`}>
      <Icon className="size-3.5" />
      {status.percentage != null ? `${status.percentage}%` : low ? "Low" : "OK"}
    </span>
  );
}

/**
 * Add/edit one mapping. The rules here (emergency needs a deliberate press,
 * cue lists filtered by action) mirror the server action's validation — the
 * server remains the authority.
 */
function MappingDialog({
  cues,
  fobMac,
  mapping,
  open,
  onOpenChange,
}: {
  cues: CueOption[];
  fobMac: string;
  mapping: MappingRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [button, setButton] = useState(mapping?.button ?? "panic");
  const [pressType, setPressType] = useState(mapping?.pressType ?? "longPress");
  const [action, setAction] = useState<MappingRow["action"]>(mapping?.action ?? "START_ALERT");
  const [cueId, setCueId] = useState<string>(mapping?.cueId != null ? String(mapping.cueId) : "");
  const [repeat, setRepeat] = useState<string>(mapping?.repeatSeconds != null ? String(mapping.repeatSeconds) : "");
  const [pending, startTransition] = useTransition();

  const emergencyOnly = action === "START_ALERT";
  const cueChoices = (emergencyOnly ? cues.filter((c) => c.isEmergency) : cues).map((c) => ({
    value: String(c.id),
    label: c.isEmergency ? `${c.name} (emergency)` : c.name,
  }));

  const save = () =>
    startTransition(async () => {
      const input = {
        button: button as never,
        pressType: pressType as never,
        action,
        cueId: action === "STOP_ALERT" ? null : cueId ? Number(cueId) : null,
        repeatSeconds: action === "START_ALERT" && repeat ? Number(repeat) : null,
      };
      const r = mapping
        ? await updateFobMapping(mapping.id, input)
        : await createFobMapping({ ...input, fobMac });
      if (r.ok) {
        toast.success(mapping ? "Saved — applying to the NVR" : "Mapped — applying to the NVR");
        onOpenChange(false);
        refresh();
      } else {
        toast.error(r.error ?? "Could not save.");
      }
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mapping ? "Edit button mapping" : "Map a button"}</DialogTitle>
          <DialogDescription>
            What this remote&apos;s button does when pressed. The console creates the matching
            alarm on the NVR for you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Button">
              <SelectField
                value={button}
                onValueChange={setButton}
                options={Object.entries(BUTTON_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Field
              label="Press"
              hint={emergencyOnly ? "Emergencies need a deliberate press — no single taps." : undefined}
            >
              <SelectField
                value={pressType}
                onValueChange={setPressType}
                options={Object.entries(PRESS_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </Field>
          </div>
          <Field label="Action">
            <SelectField
              value={action}
              onValueChange={(v) => {
                const next = v as MappingRow["action"];
                setAction(next);
                // A single tap cannot start an emergency; move to the safe default.
                if (next === "START_ALERT" && pressType === "press") setPressType("longPress");
              }}
              options={Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }))}
            />
          </Field>
          {action !== "STOP_ALERT" ? (
            <Field label={action === "START_ALERT" ? "Emergency announcement" : "Sound or announcement"}>
              <SelectField
                value={cueId}
                onValueChange={setCueId}
                placeholder="Choose…"
                options={cueChoices}
              />
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">
              Silences a sounding emergency alert. Does nothing when no alert is active.
            </p>
          )}
          {action === "START_ALERT" ? (
            <Field
              label="Repeat every (seconds)"
              hint="Leave blank for the sound's own pace. Never faster than the sound lasts."
            >
              <Input
                type="number"
                min={10}
                max={300}
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                placeholder="auto"
              />
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={pending || (action !== "STOP_ALERT" && !cueId) || (emergencyOnly && pressType === "press")}
            >
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {mapping ? "Save" : "Map button"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MappingRows({
  mappings,
  cues,
  onEdit,
}: {
  mappings: MappingRow[];
  cues: CueOption[];
  onEdit: (m: MappingRow) => void;
}) {
  const [pending, startTransition] = useTransition();
  const cueName = (id: number | null) => cues.find((c) => c.id === id)?.name ?? (id != null ? `#${id}` : null);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Button</TableHead>
          <TableHead>Press</TableHead>
          <TableHead>Does</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last pressed</TableHead>
          <TableHead className="text-right">On</TableHead>
          <TableHead className="w-20" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.map((m) => (
          <TableRow key={m.id}>
            <TableCell className="font-medium">{BUTTON_LABELS[m.button] ?? m.button}</TableCell>
            <TableCell className="text-sm text-muted-foreground">{PRESS_LABELS[m.pressType] ?? m.pressType}</TableCell>
            <TableCell className="text-sm">
              {ACTION_LABELS[m.action]}
              {m.cueId != null ? <span className="text-muted-foreground"> — {cueName(m.cueId)}</span> : null}
            </TableCell>
            <TableCell>
              <ProvisionBadge m={m} />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{timeAgo(m.lastTriggeredAt)}</TableCell>
            <TableCell className="text-right">
              <Switch
                checked={m.isEnabled}
                disabled={pending}
                onCheckedChange={(on) =>
                  startTransition(async () => {
                    const r = await setFobMappingEnabled(m.id, on === true);
                    if (!r.ok) toast.error(r.error ?? "Could not change it.");
                    refresh();
                  })
                }
              />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => onEdit(m)} aria-label="Edit mapping">
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete mapping"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await deleteFobMapping(m.id);
                      if (r.ok) toast.success("Mapping removed");
                      else toast.error(r.error ?? "Could not remove it.");
                      refresh();
                    })
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RemotesPanel({
  cues,
  initialBaseUrl,
}: {
  cues: CueOption[];
  initialBaseUrl: string | null;
}) {
  const { data, error, isLoading } = useSWR<FobsData>("/api/fobs", swrFetcher, {
    refreshInterval: 5000,
  });
  const [dialog, setDialog] = useState<{ fobMac: string; mapping: MappingRow | null } | null>(null);
  const [toolsPending, startToolsTransition] = useTransition();

  const baseUrl = data?.baseUrl ?? initialBaseUrl;
  const fobs = data?.fobs ?? [];
  const mappings = data?.mappings ?? [];
  const reconcile = data?.reconcile;

  // Mappings whose fob never showed up in the cache still deserve a card —
  // they hold provisioned alarms and can fire.
  const orphanMacs = [...new Set(mappings.map((m) => m.fobMac))].filter(
    (mac) => !fobs.some((f) => f.mac === mac),
  );

  return (
    <div className="space-y-6">
      {!isLoading && !baseUrl ? (
        <div className="rounded-lg border border-warning/50 bg-card p-4 text-sm">
          Before buttons can do anything, set the <span className="font-medium">console
          address</span> in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings
          </Link>{" "}
          — the NVR needs it to deliver presses back here.
        </div>
      ) : reconcile ? (
        <p className="text-xs text-muted-foreground">
          {reconcile.lastError
            ? `NVR problem: ${reconcile.lastError}`
            : reconcile.pending
              ? "Applying changes to the NVR…"
              : reconcile.lastAt
                ? `NVR alarms checked ${timeAgo(reconcile.lastAt)}.`
                : "Not applied yet."}
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading remotes…</p>
      ) : error ? (
        <p className="text-sm text-destructive">Failed to load remotes.</p>
      ) : fobs.length === 0 && orphanMacs.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card">
          <p className="text-sm text-muted-foreground">
            No keychain remotes found. Adopt one in UniFi Protect, then refresh.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={toolsPending}
            onClick={() =>
              startToolsTransition(async () => {
                const r = await refreshFobs();
                if (!r.ok) toast.error(r.error ?? "Refresh failed.");
                refresh();
              })
            }
          >
            <RefreshCw className="size-3.5" /> Refresh from NVR
          </Button>
        </div>
      ) : (
        <>
          {[...fobs.map((f) => ({ fob: f as FobRow | null, mac: f.mac })), ...orphanMacs.map((mac) => ({ fob: null as FobRow | null, mac }))].map(
            ({ fob, mac }) => {
              const rows = mappings.filter((m) => m.fobMac === mac);
              const online = fob?.state === "CONNECTED";
              return (
                <Card key={mac}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <CardTitle className="flex items-center gap-2.5">
                          {fob?.name ?? "Remote"}
                          <span className="inline-flex items-center gap-1.5 text-xs font-normal">
                            <StatusDot tone={online ? "success" : "muted"} />
                            <span className="text-muted-foreground">{online ? "Connected" : (fob?.state ?? "Not seen")}</span>
                          </span>
                          <Battery raw={fob?.batteryStatus ?? null} />
                        </CardTitle>
                        <CardDescription className="mt-1 font-mono text-xs">
                          {mac}
                          {fob?.firmwareVersion ? ` · fw ${fob.firmwareVersion}` : ""}
                          {fob?.lastSeenAt ? ` · seen ${timeAgo(fob.lastSeenAt)}` : ""}
                        </CardDescription>
                      </div>
                      <Button size="sm" onClick={() => setDialog({ fobMac: mac, mapping: null })}>
                        <Plus className="size-3.5" /> Map a button
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No buttons mapped yet. Map one, then press it once to test — the row
                        updates within a few seconds.
                      </p>
                    ) : (
                      <div className="overflow-hidden rounded-lg border">
                        <MappingRows mappings={rows} cues={cues} onEdit={(m) => setDialog({ fobMac: mac, mapping: m })} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            },
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={toolsPending}
              onClick={() =>
                startToolsTransition(async () => {
                  const r = await refreshFobs();
                  if (r.ok) toast.success("Refreshed from the NVR");
                  else toast.error(r.error ?? "Refresh failed.");
                  refresh();
                })
              }
            >
              <RefreshCw className="size-3.5" /> Refresh from NVR
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={toolsPending}
              onClick={() =>
                startToolsTransition(async () => {
                  const r = await reapplyFobAlarms();
                  if (r.ok) toast.success("All alarms re-applied with fresh tokens");
                  else toast.error(r.error ?? "Re-apply failed.");
                  refresh();
                })
              }
            >
              Re-apply all NVR alarms
            </Button>
            <p className="text-xs text-muted-foreground">
              Re-apply recreates the console&apos;s alarms on the NVR and rotates their tokens.
            </p>
          </div>
        </>
      )}

      {dialog ? (
        <MappingDialog
          key={dialog.mapping?.id ?? `new-${dialog.fobMac}`}
          cues={cues}
          fobMac={dialog.fobMac}
          mapping={dialog.mapping}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
