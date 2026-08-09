"use client";

import { useState, useTransition } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Play, Loader2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { StatusDot } from "@/components/fields";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { swrFetcher, timeAgo } from "@/lib/format";
import { setSpeakerVolume, testSpeakerSound } from "./actions";

interface SpeakerRow {
  id: string;
  mac: string;
  name: string | null;
  state: string | null;
  status: string | null;
  volume: number | null;
  firmwareVersion: string | null;
  lastSeenOnlineAt: number | null;
  lastPolledAt: number | null;
}

interface SpeakersData {
  speakers: SpeakerRow[];
}

function VolumeCell({ speaker }: { speaker: SpeakerRow }) {
  const [value, setValue] = useState(speaker.volume ?? 0);
  const [dragging, setDragging] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * Writes the new volume into the SWR cache as well as the server. Without
   * the cache write there is a window between "action finished" and "next
   * 5s poll" where the cache still holds the old volume — long enough for the
   * handle to visibly snap back and then jump forward again.
   */
  const commit = (v: number) => {
    setDragging(false);
    const withNewVolume = (d?: SpeakersData): SpeakersData => ({
      speakers: (d?.speakers ?? []).map((s) => (s.id === speaker.id ? { ...s, volume: v } : s)),
    });

    startTransition(async () => {
      try {
        await mutate<SpeakersData>(
          "/api/speakers",
          async (current) => {
            const r = await setSpeakerVolume(speaker.id, v);
            if (!r.ok) throw new Error(r.message ?? "unknown error");
            return withNewVolume(current);
          },
          // rollbackOnError puts the handle back where it really is if the
          // speaker refused, rather than lying about a volume that never took.
          { optimisticData: withNewVolume, rollbackOnError: true, revalidate: false },
        );
      } catch (err) {
        toast.error(`Volume change failed: ${(err as Error).message}`);
      }
    });
  };

  const shown = dragging || pending ? value : (speaker.volume ?? 0);
  return (
    <div className="flex items-center gap-3">
      <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
      <Slider
        min={0}
        max={100}
        value={shown}
        disabled={pending}
        className="w-32"
        onValueChange={(v) => {
          setDragging(true);
          setValue(Array.isArray(v) ? v[0] : v);
        }}
        onValueCommitted={(v) => commit(Array.isArray(v) ? v[0] : v)}
      />
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{shown}%</span>
    </div>
  );
}

function TestButton({ speaker }: { speaker: SpeakerRow }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending || speaker.state !== "CONNECTED"}
      onClick={() =>
        startTransition(async () => {
          const r = await testSpeakerSound(speaker.id);
          if (r.ok) toast.success(`Test sound sent to ${speaker.name ?? speaker.id}`);
          else toast.error(`Test failed: ${r.message ?? "unknown error"}`);
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
      Test
    </Button>
  );
}

export function SpeakersTable() {
  const { data, error, isLoading } = useSWR<SpeakersData>("/api/speakers", swrFetcher, {
    refreshInterval: 5000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading speakers…</p>;
  if (error) return <p className="text-sm text-destructive">Failed to load speakers.</p>;
  const speakers = data?.speakers ?? [];
  if (speakers.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed bg-card">
        <p className="text-sm text-muted-foreground">
          No speakers discovered yet — the worker polls Protect every 30 seconds.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Speaker</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Activity</TableHead>
            <TableHead>Volume</TableHead>
            <TableHead>Firmware</TableHead>
            <TableHead>Last online</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {speakers.map((s) => {
            const online = s.state === "CONNECTED";
            return (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="font-medium">{s.name ?? "(unnamed)"}</div>
                  <div className="font-mono text-xs text-muted-foreground">{s.mac}</div>
                </TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-2 text-sm">
                    <StatusDot tone={online ? "success" : "danger"} />
                    <span className={online ? "text-success" : "text-destructive"}>
                      {online ? "Online" : (s.state ?? "Unknown")}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.status ?? "—"}</TableCell>
                <TableCell>
                  <VolumeCell speaker={s} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.firmwareVersion ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{timeAgo(s.lastSeenOnlineAt)}</TableCell>
                <TableCell className="text-right">
                  <TestButton speaker={s} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
