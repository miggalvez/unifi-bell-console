"use client";

import { useRef, useState, useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "@/components/fields";
import { TimePicker } from "@/components/pickers";
import { swrFetcher } from "@/lib/format";
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
  const [pauseMode, setPauseMode] = useState("60");
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
              : ` — resumes ${new Date(data.pausedUntil!).toLocaleTimeString(undefined, { timeZone: data.schoolTz, hour: "2-digit", minute: "2-digit" })}`}
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
                setPauseMode("60");
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
              value={pauseMode}
              onValueChange={setPauseMode}
              options={[
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
                { value: "120", label: "2 hours" },
                { value: "240", label: "4 hours" },
                { value: "until_time", label: "Until a specific time" },
                { value: "end_of_day", label: "Rest of the day" },
                { value: "indefinite", label: "Until resumed" },
              ]}
            />
          </Field>
          {pauseMode === "until_time" ? (
            <Field label="Resume at" className="w-40">
              <TimePicker name="pauseUntil" required disabled={pending} />
            </Field>
          ) : null}
          <Button type="submit" variant="outline" disabled={pending}>
            <Pause className="size-4" /> Pause
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

