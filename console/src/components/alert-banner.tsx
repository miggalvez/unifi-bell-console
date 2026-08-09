"use client";

import { useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { swrFetcher } from "@/lib/format";
import { stopEmergencyAlert } from "@/app/(console)/announcements/actions";

interface AlertStatus {
  now: number;
  alert: {
    active: boolean;
    cueName: string | null;
    startedByName: string | null;
    startedAt: number | null;
    repeatSeconds: number | null;
    until: number | null;
  };
}

/**
 * Sits above every page while an alert is repeating. Someone silencing a false
 * alarm should never have to work out which page the stop button is on.
 */
export function AlertBanner() {
  // Polled faster than everything else: this is the one piece of state where
  // being a few seconds stale actually matters.
  const { data } = useSWR<AlertStatus>("/api/status", swrFetcher, { refreshInterval: 3000 });
  const [pending, startTransition] = useTransition();

  if (!data?.alert?.active) return null;
  const { cueName, startedByName, startedAt, repeatSeconds, until } = data.alert;
  const elapsed = startedAt ? Math.round((data.now - startedAt) / 1000) : 0;
  const elapsedLabel =
    elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, "0")}s`;
  const stopsIn = until ? Math.max(0, Math.round((until - data.now) / 60_000)) : null;

  return (
    <div className="sticky top-0 z-40 border-b border-emergency bg-emergency text-emergency-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
        <span className="relative flex size-3 shrink-0" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emergency-foreground opacity-75" />
          <span className="relative inline-flex size-3 rounded-full bg-emergency-foreground" />
        </span>
        <AlertTriangle className="size-4 shrink-0" />
        <span className="font-semibold">Emergency alert repeating: {cueName}</span>
        {/* Full opacity, not dimmed: how often it repeats and when it stops on
            its own are exactly what someone needs while it is sounding. */}
        <span className="text-sm">
          every {repeatSeconds}s · running {elapsedLabel}
          {startedByName ? ` · started by ${startedByName}` : ""}
          {stopsIn !== null ? ` · stops on its own in ${stopsIn} min` : ""}
        </span>
        <Button
          size="sm"
          className="ml-auto gap-1.5 bg-emergency-foreground text-emergency shadow-xs hover:bg-emergency-foreground/90"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await stopEmergencyAlert();
              if (r.ok) toast.success("Emergency alert stopped");
              else toast.error(r.message ?? "Could not stop it");
              mutate("/api/status");
            })
          }
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
          Stop alert
        </Button>
      </div>
    </div>
  );
}
