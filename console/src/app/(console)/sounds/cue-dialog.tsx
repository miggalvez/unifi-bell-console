"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckboxField, Field, SelectField } from "@/components/fields";
import { DEFAULT_TONE, TTS_MAX_CHARS, TTS_TONES } from "@/lib/protect/tones";
import { METHOD_CHOICES } from "./types";
import { createCue, updateCue, type CueFormResult } from "./actions";
import type { AudioOption, CueRow, ZoneOption } from "./types";

const initial: CueFormResult = { ok: false };

export function CueDialog({
  cue,
  zones,
  audioFiles,
  trigger,
}: {
  cue?: CueRow;
  zones: ZoneOption[];
  audioFiles: AudioOption[];
  trigger: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<string>(cue?.deliveryMethod ?? "PROTECT_WEBHOOK");
  const [ttsChars, setTtsChars] = useState(cue?.ttsText?.length ?? 0);
  const [partIds, setPartIds] = useState<number[]>(cue?.partIds ?? []);
  const partsRef = useRef<HTMLDivElement>(null);
  const action = cue ? updateCue.bind(null, cue.id) : createCue;
  const [state, formAction, pending] = useActionState(action, initial);

  useEffect(() => {
    if (state.ok) {
      toast.success(cue ? "Saved" : "Added");
      setOpen(false);
    }
  }, [state, cue]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="max-h-[85svh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cue ? `Edit "${cue.name}"` : "New sound or message"}</DialogTitle>
          <DialogDescription>
            Give it a name staff will recognise, then choose what it plays.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cue-name">Name</Label>
              <Input id="cue-name" name="name" defaultValue={cue?.name ?? ""} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cue-method">What it plays</Label>
              <SelectField
                id="cue-method"
                name="deliveryMethod"
                value={method}
                onValueChange={setMethod}
                options={METHOD_CHOICES.map((m) => ({ value: m.value, label: m.label }))}
              />
              <p className="text-xs text-muted-foreground">
                {METHOD_CHOICES.find((m) => m.value === method)?.help}
              </p>
            </div>
          </div>

          {method === "PROTECT_TALKBACK_AUDIO" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="cue-audio">Which recording</Label>
                <SelectField
                  id="cue-audio"
                  name="audioFileId"
                  placeholder="Choose a recording…"
                  defaultValue={cue?.audioFileId != null ? String(cue.audioFileId) : undefined}
                  options={audioFiles.map((a) => ({ value: String(a.id), label: a.name }))}
                />
                <p className="text-xs text-muted-foreground">
                  Recordings play right away, but the speakers can&apos;t confirm they were heard.
                  For class bells, a sound set up in Protect is the safer choice.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cue-zone-audio">Plays on</Label>
                <SelectField
                  id="cue-zone-audio"
                  name="zoneId"
                  defaultValue={cue?.zoneId != null ? String(cue.zoneId) : "all"}
                  options={[
                    { value: "all", label: "All speakers" },
                    ...zones.map((z) => ({ value: String(z.id), label: z.name })),
                  ]}
                />
              </div>
            </>
          ) : method === "PROTECT_TALKBACK_COMPOSITE" ? (
            <div className="space-y-2">
              <Label>Recordings, in play order</Label>
              {partIds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing yet — add the attention sound first, then the message.
                </p>
              ) : null}
              {/* Scrolls internally past ~5 rows — every added part was
                  making the whole dialog taller instead. */}
              <div ref={partsRef} className="max-h-60 space-y-2 overflow-y-auto pr-1">
              {partIds.map((id, i) => (
                <div key={`${id}-${i}`} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <SelectField
                      value={String(id)}
                      onValueChange={(v) =>
                        setPartIds((prev) => prev.map((p, j) => (j === i ? Number(v) : p)))
                      }
                      options={audioFiles.map((a) => ({ value: String(a.id), label: a.name }))}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={i === 0}
                    onClick={() =>
                      setPartIds((prev) => {
                        const next = [...prev];
                        [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        return next;
                      })
                    }
                    aria-label="Move up"
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPartIds((prev) => prev.filter((_, j) => j !== i))}
                    aria-label="Remove"
                  >
                    ✕
                  </Button>
                </div>
              ))}
              </div>
              {audioFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Upload recordings below first — a chime and a spoken message.
                </p>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPartIds((prev) => [...prev, audioFiles[0].id]);
                    // The new row lands at the bottom of the scroll area —
                    // follow it, or the click looks like it did nothing.
                    requestAnimationFrame(() =>
                      partsRef.current?.scrollTo({ top: partsRef.current.scrollHeight }),
                    );
                  }}
                >
                  Add a recording
                </Button>
              )}
              <input type="hidden" name="partIds" value={JSON.stringify(partIds)} />
              <p className="text-xs text-muted-foreground">
                Played as one seamless announcement, in order, with no gap between parts. Spoken
                text can&rsquo;t be combined — record the words (Announcements page) and add the
                recording here.
              </p>
            </div>
          ) : method === "PROTECT_WEBHOOK" ? (
            <div className="space-y-2">
              <Label htmlFor="cue-webhook">Protect automation ID</Label>
              <Input
                id="cue-webhook"
                name="webhookId"
                defaultValue={cue?.webhookId ?? ""}
                placeholder="e.g. bell.period-end.all"
              />
              <p className="text-xs text-muted-foreground">
                Set up the sound in UniFi Protect first (Alarm Manager → Create Alarm → Webhook),
                then copy its ID here. Which speakers play it is chosen there too.
              </p>
              <div className="pt-2">
                <Label htmlFor="cue-length">How long is it?</Label>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    id="cue-length"
                    name="durationSeconds"
                    type="number"
                    min={1}
                    max={600}
                    className="w-24"
                    defaultValue={cue?.estimatedDurationMs ? Math.round(cue.estimatedDurationMs / 1000) : ""}
                    placeholder="6"
                  />
                  <span className="text-sm text-muted-foreground">seconds</span>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Protect never tells us how long its own sounds are. Without this the console
                  assumes 6 seconds, and a longer message can be talked over by whatever comes
                  next. Time it once and put the number here.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="cue-text">What it should say</Label>
                <Textarea
                  id="cue-text"
                  name="ttsText"
                  defaultValue={cue?.ttsText ?? ""}
                  rows={3}
                  maxLength={TTS_MAX_CHARS}
                  onChange={(e) => setTtsChars(e.target.value.length)}
                />
                <p className="text-right text-xs text-muted-foreground">
                  {ttsChars}/{TTS_MAX_CHARS} — the speakers&rsquo; own limit
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cue-tone">Voice</Label>
                  <SelectField
                    id="cue-tone"
                    name="ttsTone"
                    defaultValue={cue?.ttsTone ?? DEFAULT_TONE}
                    options={[...TTS_TONES]}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cue-zone">Plays on</Label>
                  <SelectField
                    id="cue-zone"
                    name="zoneId"
                    defaultValue={cue?.zoneId != null ? String(cue.zoneId) : "all"}
                    options={[
                      { value: "all", label: "All speakers" },
                      ...zones.map((z) => ({ value: String(z.id), label: z.name })),
                    ]}
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="cue-desc">Description (optional)</Label>
            <Input id="cue-desc" name="description" defaultValue={cue?.description ?? ""} />
          </div>

          <div className="flex flex-wrap gap-6 rounded-lg border bg-muted/30 p-3">
            <CheckboxField
              name="isEmergency"
              label="Emergency announcement"
              description="Only staff with emergency permission can play it, and it works even when bells are paused"
              defaultChecked={cue?.isEmergency ?? false}
            />
            <CheckboxField
              name="isEnabled"
              label="Available for use"
              description="Turn this off to retire it without deleting it"
              defaultChecked={cue?.isEnabled ?? true}
            />
          </div>

          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : cue ? "Save changes" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
