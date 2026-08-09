"use client";

import { useState, useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { retriggerRun } from "./actions";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { swrFetcher } from "@/lib/format";

interface RunItem {
  id: number;
  at: number;
  source: "SCHEDULE" | "MANUAL" | "EMERGENCY" | "DRILL";
  cueName: string | null;
  deliveryMethod: string;
  ttsText: string | null;
  status: string;
  httpStatus: number | null;
  latencyMs: number | null;
  resultMessage: string | null;
  localDate: string;
  localTime: string;
  requestedByName: string | null;
}

interface AuditItem {
  id: number;
  at: number;
  action: string;
  targetType: string | null;
  targetId: string | null;
  isEmergency: boolean;
  detail: string | null;
  userName: string | null;
}

const SOURCE_LABEL: Record<RunItem["source"], string> = {
  SCHEDULE: "Scheduled",
  MANUAL: "Manual",
  EMERGENCY: "EMERGENCY",
  DRILL: "Drill",
};

/** Plain-English status wording — staff should never meet a raw status code. */
const STATUS: Record<string, { label: string; style: string; hint: string }> = {
  SUCCESS: { label: "Played", style: "bg-success/10 text-success", hint: "Sent to the speakers successfully" },
  FAILED: { label: "Did not play", style: "bg-destructive/10 text-destructive", hint: "Something went wrong — nothing was heard" },
  DELIVERY_UNCERTAIN: {
    label: "Not confirmed",
    style: "bg-warning/10 text-warning",
    hint: "The connection dropped mid-send, so we can't tell whether it played. Check with someone in the building, or play it again.",
  },
  MISSED: {
    label: "Missed",
    style: "bg-warning/10 text-warning",
    hint: "The console wasn't running at the scheduled time, so this bell was skipped rather than rung late",
  },
  SKIPPED_PAUSED: { label: "Skipped (paused)", style: "bg-muted text-muted-foreground", hint: "Bells were paused at this time" },
  PENDING: { label: "Waiting", style: "bg-muted text-muted-foreground", hint: "Scheduled, hasn't happened yet" },
  CLAIMED: { label: "Starting", style: "bg-muted text-muted-foreground", hint: "About to play" },
  EXECUTING: { label: "Playing", style: "bg-accent text-accent-foreground", hint: "Playing now" },
};

function fmtWhen(epoch: number): string {
  return new Date(epoch).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function RunsTable({ runs }: { runs: RunItem[] }) {
  if (runs.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">No playback yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>What played</TableHead>
          <TableHead>Started by</TableHead>
          <TableHead>Result</TableHead>
          <TableHead>Details</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => (
          <TableRow
            key={r.id}
            className={
              r.source === "EMERGENCY" ? "bg-destructive/5" : r.source === "DRILL" ? "bg-warning/5" : ""
            }
          >
            <TableCell className="whitespace-nowrap text-sm tabular-nums">{fmtWhen(r.at)}</TableCell>
            <TableCell>
              <div className="text-sm font-medium">{r.cueName ?? "—"}</div>
              {r.ttsText ? (
                <div className="max-w-xs truncate text-xs text-muted-foreground">“{r.ttsText}”</div>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge
                variant="outline"
                className={
                  r.source === "EMERGENCY"
                    ? "border-transparent bg-destructive/10 text-destructive"
                    : r.source === "DRILL"
                      ? "border-transparent bg-warning/10 text-warning"
                      : ""
                }
              >
                {SOURCE_LABEL[r.source]}
              </Badge>
              {r.requestedByName ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{r.requestedByName}</div>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge
                variant="outline"
                title={STATUS[r.status]?.hint}
                className={`border-transparent ${STATUS[r.status]?.style ?? ""}`}
              >
                {STATUS[r.status]?.label ?? r.status}
              </Badge>
            </TableCell>
            {/* max-w + truncate, or a long unbroken message (a raw upstream
                error, say) stretches the table several screens wide and every
                other column lands off-screen. Hover shows the full text. */}
            <TableCell
              className="max-w-md truncate text-xs text-muted-foreground"
              title={r.resultMessage ?? undefined}
            >
              {r.latencyMs != null ? `${Math.round(r.latencyMs)}ms` : ""}
              {r.resultMessage ? ` ${r.resultMessage}` : ""}
            </TableCell>
            <TableCell className="text-right">
              {r.status === "DELIVERY_UNCERTAIN" || r.status === "FAILED" ? (
                <RetriggerButton runId={r.id} />
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RetriggerButton({ runId }: { runId: number }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await retriggerRun(runId);
          if (r.ok) toast.success("Re-triggered successfully");
          else toast.error(r.message ?? r.status);
          mutate("/api/activity");
        })
      }
    >
      <RotateCcw className="size-3.5" /> Play again
    </Button>
  );
}

function AuditsTable({ audits }: { audits: AuditItem[] }) {
  if (audits.length === 0)
    return <p className="p-6 text-sm text-muted-foreground">No audit entries yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Who</TableHead>
          <TableHead>Detail</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {audits.map((a) => (
          <TableRow key={a.id} className={a.isEmergency ? "bg-destructive/5" : ""}>
            <TableCell className="whitespace-nowrap text-sm tabular-nums">{fmtWhen(a.at)}</TableCell>
            <TableCell className="font-mono text-xs">{a.action}</TableCell>
            <TableCell className="text-sm">{a.userName ?? "system"}</TableCell>
            <TableCell className="max-w-md truncate text-xs text-muted-foreground">
              {a.detail ?? ""}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ActivityFeed() {
  const [tab, setTab] = useState("playback");
  const { data } = useSWR<{ runs: RunItem[]; audits: AuditItem[] }>("/api/activity", swrFetcher, {
    refreshInterval: 5000,
  });

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="playback">Bells &amp; announcements</TabsTrigger>
          <TabsTrigger value="audit">Changes &amp; sign-ins</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="overflow-hidden rounded-lg border bg-card">
        {!data ? (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        ) : tab === "playback" ? (
          <RunsTable runs={data.runs} />
        ) : (
          <AuditsTable audits={data.audits} />
        )}
      </div>
    </div>
  );
}
