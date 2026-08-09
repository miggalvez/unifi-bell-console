"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Speaker, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Field, FileField } from "@/components/fields";
import { AudioPreview } from "@/components/audio-preview";
import { deleteAudio, playAudioNow, uploadAudio, type AudioResult } from "./audio-actions";

export interface AudioItem {
  id: number;
  name: string;
  originalName: string | null;
  sizeBytes: number;
  durationMs: number | null;
  durationLabel: string;
}

const initial: AudioResult = { ok: false };

export function AudioLibrary({
  files,
  isAdmin,
  ffmpegReady,
}: {
  files: AudioItem[];
  isAdmin: boolean;
  ffmpegReady: boolean;
}) {
  const [state, formAction, pending] = useActionState(uploadAudio, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success("Audio uploaded");
      formRef.current?.reset();
    }
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recordings</CardTitle>
        <CardDescription>
          Upload a chime, a recorded announcement, or the school song. Listen to it here first —
          nothing plays in the building until you press &ldquo;Play on speakers&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ffmpegReady ? (
          <Alert variant="destructive">
            <AlertTitle>Recordings are unavailable on this computer</AlertTitle>
            <AlertDescription>
              A required audio tool (ffmpeg) isn&apos;t installed, so recordings can&apos;t be
              uploaded or played. Ask whoever set up this console to install it — everything else
              keeps working.
            </AlertDescription>
          </Alert>
        ) : null}


        {isAdmin && ffmpegReady ? (
          <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
            <Field label="Audio file" className="min-w-64 flex-1">
              <FileField name="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.aiff" disabled={pending} />
            </Field>
            <Field label="Name (optional)" className="w-48">
              <Input name="name" placeholder="e.g. Period Bell" />
            </Field>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              Upload
            </Button>
          </form>
        ) : null}
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}

        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recordings yet.</p>
        ) : (
          <div className="space-y-2">
            {files.map((f) => (
              <AudioRow key={f.id} file={f} isAdmin={isAdmin} ffmpegReady={ffmpegReady} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AudioRow({
  file,
  isAdmin,
  ffmpegReady,
}: {
  file: AudioItem;
  isAdmin: boolean;
  ffmpegReady: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
      <div className="min-w-40 flex-1">
        <div className="text-sm font-medium">{file.name}</div>
        <div className="text-xs text-muted-foreground">
          {file.durationLabel} · {(file.sizeBytes / 1024).toFixed(0)} KB
          {file.originalName ? ` · ${file.originalName}` : ""}
        </div>
      </div>
      <AudioPreview src={`/api/audio/${file.id}`} label={file.name} />
      <Button
        variant="outline"
        size="sm"
        disabled={pending || !ffmpegReady}
        onClick={() =>
          startTransition(async () => {
            const r = await playAudioNow(file.id);
            if (r.ok) toast.success(`"${file.name}" streamed to the speakers`);
            else toast.error(`${r.status}${r.message ? ` — ${r.message}` : ""}`);
          })
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Speaker className="size-3.5" />}
        Play on speakers
      </Button>
      {isAdmin ? (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Delete "${file.name}"?`)) return;
            startTransition(async () => {
              const r = await deleteAudio(file.id);
              if (r.ok) toast.success("Deleted");
              else toast.error(r.error ?? "Failed");
            });
          }}
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      ) : null}
    </div>
  );
}
