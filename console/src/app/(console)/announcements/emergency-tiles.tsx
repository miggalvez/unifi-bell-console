"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import { AlertTriangle, Loader2, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startEmergencyAlert, triggerEmergencyCue } from "./actions";
import type { CueRow } from "../sounds/types";

const HOLD_MS = 1500;
const ARM_WINDOW_MS = 5000;

export function EmergencyTiles({ cues }: { cues: CueRow[] }) {
  if (cues.length === 0) return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="size-4 text-destructive" />
        <h2 className="text-sm font-semibold text-destructive">Emergency</h2>
        <span className="text-xs text-muted-foreground">
          Press and hold to arm, then choose. Repeating alerts keep sounding until someone stops
          them — including if you close this page. Plays even while bells are paused.
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cues.map((cue) => (
          <EmergencyTile key={cue.id} cue={cue} />
        ))}
      </div>
    </div>
  );
}

function EmergencyTile({ cue }: { cue: CueRow }) {
  const [progress, setProgress] = useState(0);
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStart = useRef(0);

  const stopHold = () => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = null;
    setProgress(0);
  };

  const beginHold = () => {
    if (armed || pending) return;
    holdStart.current = Date.now();
    holdTimer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - holdStart.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        stopHold();
        setArmed(true);
        armTimer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      }
    }, 50);
  };

  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
  };

  const playOnce = () => {
    disarm();
    startTransition(async () => {
      const r = await triggerEmergencyCue(cue.id);
      if (r.ok) toast.success(`Emergency "${cue.name}" playing`);
      else toast.error(`"${cue.name}": ${r.message ?? r.status}`);
    });
  };

  const repeat = () => {
    disarm();
    startTransition(async () => {
      const r = await startEmergencyAlert(cue.id);
      if (r.ok) toast.success(`"${cue.name}" now repeating — stop it from the red bar`);
      else toast.error(`"${cue.name}": ${r.message ?? r.status}`);
      mutate("/api/status");
    });
  };

  if (armed) {
    return (
      <div className="space-y-2 rounded-lg border border-destructive bg-card p-3">
        <div className="truncate text-sm font-medium">{cue.name}</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" size="sm" onClick={repeat}>
            <Repeat className="size-3.5" /> Repeat until stopped
          </Button>
          <Button variant="outline" size="sm" onClick={playOnce}>
            Play once
          </Button>
          <Button variant="ghost" size="sm" onClick={disarm}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      onPointerDown={beginHold}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onContextMenu={(e) => e.preventDefault()}
      className="relative select-none overflow-hidden rounded-lg border border-destructive/40 bg-card p-4 text-left disabled:opacity-60"
    >
      <span
        className="absolute inset-y-0 left-0 bg-destructive/15 transition-none"
        style={{ width: `${progress * 100}%` }}
      />
      {/* The panel is already bordered, tinted and headed "Emergency"; a warning
          icon on every tile as well is noise. The corner slot is kept for the
          sending spinner, which is real state rather than decoration. */}
      {pending ? (
        <Loader2 className="absolute top-3 right-3 size-4 animate-spin text-destructive" />
      ) : null}
      <span className="relative block min-w-0">
        <span className="block truncate text-sm font-medium text-destructive">{cue.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {cue.description ?? "Hold to arm"}
        </span>
      </span>
    </button>
  );
}
