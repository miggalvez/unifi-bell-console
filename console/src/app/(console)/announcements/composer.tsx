"use client";

import { useRef, useTransition, useState } from "react";
import { toast } from "sonner";
import { Loader2, Megaphone, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Field, SelectField } from "@/components/fields";
import { DEFAULT_TONE, TTS_TONES, TTS_MAX_CHARS } from "@/lib/protect/tones";
import { speakText } from "./actions";
import { triggerCue } from "../sounds/actions";
import type { CueRow, ZoneOption } from "../sounds/types";

export function Composer({ zones }: { zones: ZoneOption[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [chars, setChars] = useState(0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="size-4 text-primary" /> Type a message
        </CardTitle>
        <CardDescription>
          The speakers will read it aloud in a computer voice, right away.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          ref={formRef}
          action={(fd) =>
            startTransition(async () => {
              const r = await speakText(fd);
              if (r.ok) {
                toast.success("Announcement playing");
                formRef.current?.reset();
                setChars(0);
              } else {
                toast.error(r.message ?? r.status);
              }
            })
          }
          className="space-y-4"
        >
          <div className="space-y-2">
            <Textarea
              name="text"
              rows={3}
              maxLength={TTS_MAX_CHARS}
              placeholder="e.g. Would the eighth-grade students please report to the gym."
              onChange={(e) => setChars(e.target.value.length)}
              disabled={pending}
            />
            <p className="text-right text-xs text-muted-foreground">{chars}/{TTS_MAX_CHARS}</p>
          </div>
          <div className="flex items-end gap-4">
            <Field label="Speakers" htmlFor="ann-zone" className="w-44">
              <SelectField
                id="ann-zone"
                name="zoneId"
                defaultValue="all"
                options={[
                  { value: "all", label: "All speakers" },
                  ...zones.map((z) => ({ value: String(z.id), label: z.name })),
                ]}
              />
            </Field>
            <Field label="Voice" htmlFor="ann-tone" className="w-36">
              <SelectField
                id="ann-tone"
                name="tone"
                defaultValue={DEFAULT_TONE}
                options={[...TTS_TONES]}
              />
            </Field>
            <Button type="submit" disabled={pending} className="ml-auto">
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Megaphone className="size-4" />}
              {pending ? "Speaking…" : "Announce"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PresetTiles({ cues }: { cues: CueRow[] }) {
  if (cues.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing saved yet — add sounds or messages on the Sounds page and they show up here as
        one-tap buttons.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cues.map((cue) => (
        <PresetTile key={cue.id} cue={cue} />
      ))}
    </div>
  );
}

function PresetTile({ cue }: { cue: CueRow }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await triggerCue(cue.id);
          if (r.ok) toast.success(`"${cue.name}" playing`);
          else toast.error(`"${cue.name}": ${r.message ?? r.status}`);
        })
      }
      className="flex items-center gap-3 rounded-lg border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent disabled:opacity-60"
    >
      {pending ? (
        <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
      ) : (
        <Play className="size-5 shrink-0 text-primary" />
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{cue.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {cue.description ?? (cue.deliveryMethod === "PROTECT_WEBHOOK" ? "Protect sound" : cue.ttsText)}
        </span>
      </span>
    </button>
  );
}
