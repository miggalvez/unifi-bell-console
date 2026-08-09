"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Compact in-browser preview. Replaces <audio controls>, whose native chrome
 * is bulky and looks nothing like the rest of the console.
 */
export function AudioPreview({
  src,
  className,
  label = "Preview",
}: {
  src: string;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnd = () => {
      setPlaying(false);
      setCurrent(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <audio ref={ref} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {playing ? <Pause className="size-3" /> : <Play className="ml-0.5 size-3" />}
      </button>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-1 w-24 overflow-hidden rounded-full bg-muted"
        onClick={(e) => {
          const el = ref.current;
          if (!el || !duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          el.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
        }}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
        {fmt(current)} / {fmt(duration)}
      </span>
    </div>
  );
}
