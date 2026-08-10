"use client";

import { useState, useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  CalendarCheck2,
  CheckCircle2,
  Clock3,
  Loader2,
  RotateCcw,
  SkipForward,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, SelectField } from "@/components/fields";
import { cn } from "@/lib/utils";
import { friendlyCountdown, friendlyTime, swrFetcher } from "@/lib/format";
import type { TodayScheduleSnapshot, TodayTimelineItem } from "@/lib/today";
import {
  changeNextBell,
  clearTodayBellOverride,
  setTodayPlan,
} from "@/app/(console)/today-actions";

interface StatusPayload {
  now: number;
  schoolTz: string;
  today: TodayScheduleSnapshot;
}

const STATUS: Record<
  TodayTimelineItem["status"],
  { label: string; className: string }
> = {
  PENDING: { label: "Upcoming", className: "bg-primary/10 text-primary" },
  CLAIMED: { label: "Starting", className: "bg-primary/10 text-primary" },
  EXECUTING: { label: "Playing", className: "bg-primary/10 text-primary" },
  SUCCESS: { label: "Played", className: "bg-success/10 text-success" },
  FAILED: { label: "Did not play", className: "bg-destructive/10 text-destructive" },
  MISSED: { label: "Missed", className: "bg-warning/10 text-warning" },
  DELIVERY_UNCERTAIN: { label: "Not confirmed", className: "bg-warning/10 text-warning" },
  SKIPPED_PAUSED: { label: "Skipped", className: "bg-muted text-muted-foreground" },
  SKIPPED_BY_STAFF: { label: "Skipped by staff", className: "bg-muted text-muted-foreground" },
  NOT_QUEUED: { label: "Not queued", className: "bg-warning/10 text-warning" },
};

function dateLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function nextTimeAfter(item: TodayTimelineItem, minutes: number, schoolTz: string): string {
  return new Date(item.scheduledAtUtc + minutes * 60_000).toLocaleTimeString(undefined, {
    timeZone: schoolTz,
    hour: "numeric",
    minute: "2-digit",
  });
}

function ChangeDialog({
  item,
  kind,
  minutes,
  schoolTz,
}: {
  item: TodayTimelineItem;
  kind: "SKIP" | "DELAY";
  minutes?: 5 | 10;
  schoolTz: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isSkip = kind === "SKIP";
  const title = isSkip ? "Skip the next bell?" : `Delay the next bell ${minutes} minutes?`;
  const description = isSkip
    ? `${item.label ?? item.cueName} at ${friendlyTime(item.effectiveTime)} will not ring.`
    : `${item.label ?? item.cueName} will move from ${friendlyTime(item.effectiveTime)} to ${nextTimeAfter(item, minutes!, schoolTz)}.`;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {isSkip ? <SkipForward /> : <Clock3 />}
        {isSkip ? "Skip next" : `Delay ${minutes} min`}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
            <span className="font-medium">Only this bell changes.</span>{" "}
            The rest of today keeps its current times.
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Keep schedule
            </Button>
            <Button
              type="button"
              variant={isSkip ? "destructive" : "default"}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await changeNextBell(kind, minutes);
                  if (result.ok) {
                    toast.success(result.message);
                    setOpen(false);
                    await mutate("/api/status");
                  } else {
                    toast.error(result.error ?? "The bell could not be changed.");
                  }
                })
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {isSkip ? "Skip this bell" : "Confirm delay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TimelineRow({ item, isAdmin }: { item: TodayTimelineItem; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  const changed = item.override !== null;
  const time = item.effectiveTime;

  return (
    <li
      className={cn(
        "grid grid-cols-[4.75rem_1fr_auto] items-center gap-3 border-t py-2.5 first:border-t-0",
        item.status === "PENDING" && "text-foreground",
        (item.status === "SUCCESS" || item.historical) && "text-muted-foreground",
      )}
    >
      <div className="font-medium tabular-nums">
        {friendlyTime(time)}
        {item.override?.kind === "DELAY" ? (
          <div className="text-[0.68rem] font-normal text-muted-foreground line-through">
            {friendlyTime(item.originalTime)}
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className={cn("truncate text-sm", item.status === "SKIPPED_BY_STAFF" && "line-through")}>
          {item.label ?? item.cueName}
        </div>
        {item.label ? <div className="truncate text-xs text-muted-foreground">{item.cueName}</div> : null}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Badge variant="outline" className={cn("border-transparent", STATUS[item.status].className)}>
          {STATUS[item.status].label}
        </Badge>
        {isAdmin && changed && item.canUndo ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await clearTodayBellOverride(item.override!.id);
                if (result.ok) {
                  toast.success(result.message);
                  await mutate("/api/status");
                } else toast.error(result.error ?? "The change could not be undone.");
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Undo
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function PlanControl({ today }: { today: TodayScheduleSnapshot }) {
  const currentValue = today.exception?.type === "USE_PLAN" && today.plan
    ? String(today.plan.id)
    : "regular";
  const [selected, setSelected] = useState(currentValue);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const options = [
    { value: "regular", label: "Regular weekly schedule" },
    ...today.plans.map((plan) => ({ value: String(plan.id), label: plan.name })),
  ];

  const selectedLabel = options.find((option) => option.value === selected)?.label ?? "the selected plan";
  const unchanged =
    (selected === currentValue && today.exception?.type !== "NO_SCHOOL") ||
    (today.exception === null && selected !== "regular" && Number(selected) === today.plan?.id);
  const apply = () =>
    startTransition(async () => {
      const result = await setTodayPlan(selected === "regular" ? null : Number(selected));
      if (result.ok) {
        toast.success(result.message);
        setOpen(false);
        await mutate("/api/status");
      } else toast.error(result.error ?? "Today's plan could not be changed.");
    });

  return (
    <div className="flex flex-wrap items-end gap-2 border-t pt-3">
      <Field
        label="Plan for the rest of today"
        hint="Past bells stay in the activity record."
        className="min-w-56 flex-1"
      >
        <SelectField options={options} value={selected} onValueChange={setSelected} disabled={pending} />
      </Field>
      <Button
        variant="outline"
        size="sm"
        className="mb-5"
        disabled={pending || unchanged}
        onClick={() => setOpen(true)}
      >
        <CalendarCheck2 />
        Apply to today
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use {selectedLabel} for the rest of today?</DialogTitle>
            <DialogDescription>
              Bells that already played stay in Activity. Only future bells are replaced with the
              remaining times from {selectedLabel}.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
            Current plan: <span className="font-medium">{today.plan?.name ?? "No bell plan"}</span>
            <br />
            New plan: <span className="font-medium">{selectedLabel}</span>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Keep current plan
            </Button>
            <Button type="button" disabled={pending} onClick={apply}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              Confirm plan change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function TodayScheduleCard({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useSWR<StatusPayload>("/api/status", swrFetcher, { refreshInterval: 5000 });
  if (!data) {
    return <div className="h-80 animate-pulse rounded-xl bg-muted/50" aria-label="Loading today's schedule" />;
  }

  const { today } = data;
  const ready = today.readiness.tone === "ready";
  const attention = today.readiness.tone === "attention";
  const next = today.next;

  return (
    <Card className={cn(attention && "ring-destructive/40", ready && "ring-success/30")}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck2 className="size-4 text-muted-foreground" />
          Today · {dateLabel(today.localDate)}
        </CardTitle>
        <CardAction>
          <Badge
            variant="outline"
            className={cn(
              "border-transparent",
              ready && "bg-success/10 text-success",
              attention && "bg-destructive/10 text-destructive",
              today.readiness.tone === "quiet" && "bg-muted text-muted-foreground",
            )}
          >
            {ready ? <CheckCircle2 /> : attention ? <TriangleAlert /> : <CalendarCheck2 />}
            {today.readiness.title}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(14rem,0.8fr)_1.2fr]">
          <div
            className={cn(
              "rounded-lg px-4 py-3",
              attention ? "bg-destructive/5" : ready ? "bg-success/5" : "bg-muted/40",
            )}
          >
            {next ? (
              <>
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Next bell</div>
                <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                  {friendlyTime(next.effectiveTime)}
                </div>
                <div className="mt-1 truncate font-medium">{next.label ?? next.cueName}</div>
                <div className="text-xs text-muted-foreground">
                  {friendlyCountdown(next.scheduledAtUtc - data.now)}
                </div>
              </>
            ) : (
              <>
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Today</div>
                <div className="mt-2 text-lg font-semibold">{today.readiness.title}</div>
                <div className="mt-1 text-sm text-muted-foreground">{today.readiness.detail}</div>
              </>
            )}
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{today.plan?.name ?? "No bell plan"}</div>
                <div className={cn("mt-0.5 text-sm", attention ? "text-destructive" : "text-muted-foreground")}>
                  {today.readiness.detail}
                </div>
              </div>
              {today.exception ? <Badge variant="outline">Today’s override</Badge> : null}
            </div>
            {today.timeline.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                Nothing is scheduled to ring today.
              </div>
            ) : (
              <ol className="max-h-72 overflow-y-auto pr-1">
                {today.timeline.map((item, index) => (
                  <TimelineRow key={`${item.eventId ?? "run"}-${item.runId ?? index}-${item.effectiveTime}`} item={item} isAdmin={isAdmin} />
                ))}
              </ol>
            )}
          </div>
        </div>

        {isAdmin ? (
          <div className="space-y-3 rounded-lg bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Day-of controls</div>
                <div className="text-xs text-muted-foreground">Every change is recorded in Activity.</div>
              </div>
              {next ? (
                <div className="flex flex-wrap gap-1.5">
                  <ChangeDialog item={next} kind="DELAY" minutes={5} schoolTz={data.schoolTz} />
                  <ChangeDialog item={next} kind="DELAY" minutes={10} schoolTz={data.schoolTz} />
                  <ChangeDialog item={next} kind="SKIP" schoolTz={data.schoolTz} />
                </div>
              ) : null}
            </div>
            <PlanControl key={`${today.localDate}-${today.plan?.id ?? "none"}-${today.exception?.type ?? "regular"}`} today={today} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
