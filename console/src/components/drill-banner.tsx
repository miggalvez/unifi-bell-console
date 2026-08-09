"use client";

import { useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { GraduationCap, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { swrFetcher } from "@/lib/format";
import { stopRunningDrill } from "@/app/(console)/drills/actions";

interface DrillStatus {
  now: number;
  drill: {
    active: boolean;
    sequenceName: string | null;
    startedByName: string | null;
    stepIndex: number | null;
    totalSteps: number | null;
    currentStepLabel: string | null;
    nextStepAt: number | null;
  };
}

/**
 * Amber, never red, and a tinted notice rather than a solid fill. A drill is
 * not an emergency, so it should not carry an emergency's visual weight — and
 * this bar has real status to read (which step, what is next, how long), which
 * a saturated fill makes harder. The colour identity comes from the border,
 * icon and button; the text sits on a near-page surface where it is easiest to
 * read. Someone glancing at a screen still tells it from the red alert bar
 * instantly, without reading a word.
 */
export function DrillBanner() {
  const { data } = useSWR<DrillStatus>("/api/status", swrFetcher, { refreshInterval: 3000 });
  const [pending, startTransition] = useTransition();

  if (!data?.drill?.active) return null;
  const { sequenceName, startedByName, stepIndex, totalSteps, currentStepLabel, nextStepAt } = data.drill;
  const step = (stepIndex ?? 0) + 1;
  const nextIn = nextStepAt ? Math.max(0, Math.round((nextStepAt - data.now) / 1000)) : null;

  return (
    <div className="sticky top-0 z-30 border-b-2 border-warning bg-warning/15">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
        <GraduationCap className="size-4 shrink-0 text-warning-strong" />
        <span className="font-semibold text-foreground">
          Drill in progress — this is not a real emergency: {sequenceName}
        </span>
        <span className="text-sm text-foreground">
          step {step} of {totalSteps ?? "?"}
          {currentStepLabel ? ` · next: ${currentStepLabel}` : ""}
          {nextIn !== null && nextIn > 0 ? ` in ${nextIn}s` : ""}
          {startedByName ? ` · started by ${startedByName}` : ""}
        </span>
        <Button
          size="sm"
          className="ml-auto gap-1.5 bg-warning-strong text-warning-strong-foreground shadow-xs hover:bg-warning-strong/90"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await stopRunningDrill();
              if (r.ok) toast.success("Drill stopped");
              else toast.error(r.message ?? "Could not stop it");
              mutate("/api/status");
            })
          }
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
          Stop drill
        </Button>
      </div>
    </div>
  );
}
