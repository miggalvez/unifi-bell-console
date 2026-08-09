"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { AlertTriangle } from "lucide-react";
import { swrFetcher } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ClockStatus {
  now: number;
  schoolTz: string;
}

/** Beyond this the console would ring bells noticeably off the wall clock. */
const DRIFT_WARN_MS = 60_000;

/**
 * Shows the time the *scheduler* is working from, not the browser's. Bells fire
 * on the console's clock, so that is the clock staff need to trust — and if the
 * two disagree, that is worth saying out loud rather than hiding.
 */
export function SchoolClock({ compact = false }: { compact?: boolean }) {
  const { data } = useSWR<ClockStatus>("/api/status", swrFetcher, { refreshInterval: 30_000 });
  const [now, setNow] = useState<Date | null>(null);
  // Difference between the console's clock and this device's, held across ticks
  // so the display advances smoothly between polls.
  const offsetRef = useRef(0);
  const driftRef = useRef(0);

  useEffect(() => {
    if (!data) return;
    const diff = data.now - Date.now();
    offsetRef.current = diff;
    driftRef.current = Math.abs(diff);
  }, [data]);

  useEffect(() => {
    const tick = () => setNow(new Date(Date.now() + offsetRef.current));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // The time is only known once the console reports it, so show a placeholder
  // of the same height rather than an empty gap that reads as a glitch.
  if (!now || !data) {
    return (
      <div className={cn("animate-pulse space-y-1.5", compact ? "" : "space-y-2")} aria-hidden>
        <div className={cn("rounded bg-muted", compact ? "h-5 w-24" : "h-9 w-44")} />
        <div className={cn("rounded bg-muted", compact ? "h-3 w-32" : "h-4 w-40")} />
      </div>
    );
  }

  const tz = data.schoolTz;
  const time = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: tz,
  });
  const date = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const elsewhere = deviceTz !== tz;
  const drifted = driftRef.current > DRIFT_WARN_MS;

  return (
    <div className={cn(compact ? "px-1" : "")}>
      <div className={cn("font-semibold tabular-nums", compact ? "text-base" : "text-3xl")}>{time}</div>
      <div className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>{date}</div>
      {elsewhere ? (
        <div className="mt-0.5 text-xs text-muted-foreground">school time ({tz.split("/").pop()?.replace("_", " ")})</div>
      ) : null}
      {drifted ? (
        <div className="mt-1 flex items-start gap-1 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            This console&apos;s clock is {Math.round(driftRef.current / 1000)}s off from your device.
            Bells ring on the console&apos;s clock.
          </span>
        </div>
      ) : null}
    </div>
  );
}
