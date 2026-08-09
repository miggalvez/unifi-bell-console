"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { deleteCue, triggerCue } from "./actions";
import { CueDialog } from "./cue-dialog";
import { METHOD_LABEL, type AudioOption, type CueRow, type ZoneOption } from "./types";

function PlayButton({ cue }: { cue: CueRow }) {
  const [pending, startTransition] = useTransition();
  if (cue.isEmergency) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending || !cue.isEnabled}
      onClick={() =>
        startTransition(async () => {
          const r = await triggerCue(cue.id);
          if (r.ok) toast.success(`"${cue.name}" played`);
          else toast.error(`"${cue.name}" did not play${r.message ? ` — ${r.message}` : ""}`);
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
      Play
    </Button>
  );
}

function DeleteButton({ cue, isAdmin, isDrillTag }: { cue: CueRow; isAdmin: boolean; isDrillTag: boolean }) {
  const [pending, startTransition] = useTransition();
  if (!isAdmin) return null;
  // Deleting this is refused server-side — offering the button would only
  // ever produce an error. Pick a different announcement on Drills first.
  if (isDrillTag) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      disabled={pending}
      onClick={() => {
        if (!confirm(`Delete "${cue.name}"? Any bell plan using it must be updated.`)) return;
        startTransition(async () => {
          const r = await deleteCue(cue.id);
          if (r.ok) toast.success("Deleted");
          else toast.error(r.error ?? "Could not delete it");
        });
      }}
    >
      <Trash2 className="size-3.5 text-muted-foreground" />
    </Button>
  );
}

export function CuesTable({
  cues,
  zones,
  audioFiles,
  isAdmin,
  drillTagCueId,
}: {
  cues: CueRow[];
  zones: ZoneOption[];
  audioFiles: AudioOption[];
  isAdmin: boolean;
  /** The sound drills announce themselves with — protected from deletion. */
  drillTagCueId: number | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sounds &amp; messages</CardTitle>
        <CardDescription>
          Add them here, then use them in a bell plan or on the Announcements page.
        </CardDescription>
        {isAdmin ? (
          <CardAction>
            <CueDialog
              zones={zones}
              audioFiles={audioFiles}
              trigger={
                <Button size="sm">
                  <Plus className="size-4" /> Add sound or message
                </Button>
              }
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
      {cues.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed">
          <p className="text-sm text-muted-foreground">
            Nothing here yet. {isAdmin ? "Add a sound or message to get started." : "An administrator can add them."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Plays on</TableHead>
                <TableHead />
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cues.map((cue) => (
                <TableRow key={cue.id} className={cue.isEnabled ? "" : "opacity-50"}>
                  <TableCell>
                    <div className="font-medium">{cue.name}</div>
                    <div className="max-w-md truncate text-xs text-muted-foreground">
                      {cue.deliveryMethod === "PROTECT_WEBHOOK"
                        ? (cue.webhookId ?? "")
                        : cue.deliveryMethod === "PROTECT_TALKBACK_AUDIO"
                          ? (audioFiles.find((a) => a.id === cue.audioFileId)?.name ?? "recording missing")
                          : cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE"
                            ? (cue.partIds ?? [])
                                .map((id) => audioFiles.find((a) => a.id === id)?.name ?? "?")
                                .join(" → ")
                            : (cue.ttsText ?? "")}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{METHOD_LABEL[cue.deliveryMethod]}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {cue.deliveryMethod === "PROTECT_WEBHOOK"
                      ? "Chosen in Protect"
                      : cue.zoneId != null
                        ? (zones.find((z) => z.id === cue.zoneId)?.name ?? "Speaker group")
                        : "All speakers"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1.5">
                      {cue.isEmergency ? (
                        <Badge className="border-transparent bg-destructive/10 text-destructive">Emergency</Badge>
                      ) : null}
                      {!cue.isEnabled ? <Badge variant="outline">Not in use</Badge> : null}
                      {cue.id === drillTagCueId ? (
                        <Badge className="border-transparent bg-warning/10 text-warning">
                          Drill announcement
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1.5">
                      <PlayButton cue={cue} />
                      {isAdmin ? (
                        <CueDialog
                          cue={cue}
                          zones={zones}
                          audioFiles={audioFiles}
                          trigger={
                            <Button variant="ghost" size="icon-sm">
                              <Pencil className="size-3.5 text-muted-foreground" />
                            </Button>
                          }
                        />
                      ) : null}
                      <DeleteButton cue={cue} isAdmin={isAdmin} isDrillTag={cue.id === drillTagCueId} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      </CardContent>
    </Card>
  );
}
