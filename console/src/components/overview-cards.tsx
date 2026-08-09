"use client";

import { useRef, useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { CalendarClock, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "@/components/fields";
import { SchoolClock } from "@/components/school-clock";
import { friendlyCountdown, friendlyDate, friendlyTime, swrFetcher } from "@/lib/format";
import { setPause, clearPause } from "@/app/(console)/actions";

interface NextRun {
  id: number;
  cueName: string | null;
  localDate: string;
  localTime: string;
  scheduledAtUtc: number;
}

interface StatusForPause {
  now: number;
  schoolTz: string;
  paused: boolean;
  pausedUntil: number | null;
  pauseReason: string | null;
  nextRuns: NextRun[];
}

const FAR_FUTURE = 4000000000000;

export function PauseCard({ isAdmin }: { isAdmin: boolean }) {
  const { data } = useSWR<StatusForPause>("/api/status", swrFetcher, { refreshInterval: 5000 });
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  if (!data) return null;

  if (data.paused) {
    const indefinite = (data.pausedUntil ?? 0) > FAR_FUTURE;
    return (
      <Card className="border-warning/40 bg-warning/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-warning">
            <Pause className="size-4" /> Scheduled bells are paused
          </CardTitle>
          <CardDescription>
            {data.pauseReason}
            {indefinite
              ? " — until resumed"
              : ` — resumes ${new Date(data.pausedUntil!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
            . Manual and emergency playback still works.
          </CardDescription>
        </CardHeader>
        {isAdmin ? (
          <CardContent>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const r = await clearPause();
                  if (r.ok) {
                    toast.success("Schedule resumed");
                    mutate("/api/status");
                  } else toast.error(r.error ?? "Failed");
                })
              }
            >
              <Play className="size-4" /> Resume schedule
            </Button>
          </CardContent>
        ) : null}
      </Card>
    );
  }

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Pause className="size-4 text-muted-foreground" /> Pause scheduled bells
        </CardTitle>
        <CardDescription>
          Skips scheduled bells (recorded as skipped) until resumed. Manual and emergency playback keeps working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={(fd) =>
            startTransition(async () => {
              const r = await setPause(fd);
              if (r.ok) {
                toast.success("Schedule paused");
                formRef.current?.reset();
                mutate("/api/status");
              } else toast.error(r.error ?? "Failed");
            })
          }
          className="flex flex-wrap items-end gap-2"
        >
          <Field label="Reason (shown to everyone)" className="min-w-52 flex-1">
            <Input name="reason" placeholder="e.g. Standardized testing in progress" disabled={pending} />
          </Field>
          <Field label="Duration" className="w-44">
            <SelectField
              name="minutes"
              defaultValue="60"
              options={[
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
                { value: "120", label: "2 hours" },
                { value: "240", label: "4 hours" },
                { value: "480", label: "Rest of the day" },
                { value: "indefinite", label: "Until resumed" },
              ]}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={pending}>
            <Pause className="size-4" /> Pause
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function NextRunsCard() {
  const { data } = useSWR<StatusForPause>("/api/status", swrFetcher, { refreshInterval: 5000 });
  if (!data) return null;
  const runs = data.nextRuns ?? [];

  // "sv" formats as YYYY-MM-DD, matching how run dates are stored.
  const toIso = (d: Date) => d.toLocaleDateString("sv", { timeZone: data.schoolTz });
  const todayIso = toIso(new Date(data.now));
  const tomorrowIso = toIso(new Date(data.now + 86_400_000));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" /> Coming up
        </CardTitle>
        <CardDescription>The next scheduled bells.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border-b pb-4">
          <SchoolClock />
        </div>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing scheduled — assign a bell plan on the Schedule page.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <li key={r.id} className="flex items-baseline gap-3 text-sm">
                <span className="w-20 shrink-0 font-medium tabular-nums">{friendlyTime(r.localTime)}</span>
                <span className="w-24 shrink-0 text-muted-foreground">
                  {friendlyDate(r.localDate, todayIso, tomorrowIso)}
                </span>
                <span className="min-w-0 flex-1 truncate">{r.cueName}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {friendlyCountdown(r.scheduledAtUtc - data.now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
