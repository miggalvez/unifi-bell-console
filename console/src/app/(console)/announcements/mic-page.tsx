"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Mic, Send, Square, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/fields";
import { AudioPreview } from "@/components/audio-preview";
import { sendRecordedPage } from "./page-actions";

const MAX_MS = 120_000;

type Phase = "idle" | "recording" | "review" | "sending";

export function MicPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [secure, setSecure] = useState(true);
  const [keep, setKeep] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [, startTransition] = useTransition();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    // getUserMedia is unavailable on insecure origins (LAN IP over http).
    setSecure(typeof window !== "undefined" && window.isSecureContext);
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup(): void {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }

  async function startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // Live level meter, so the speaker can see the mic is actually hearing them.
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 90));
        setElapsed(Date.now() - startedAtRef.current);
        if (Date.now() - startedAtRef.current >= MAX_MS) {
          stopRecording();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };

      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        setClip({ blob, url: URL.createObjectURL(blob) });
        setPhase("review");
        cleanup();
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      rec.start();
      setPhase("recording");
      setElapsed(0);
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      const e = err as Error;
      toast.error(
        e.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : `Could not start the microphone: ${e.message}`,
      );
      cleanup();
      setPhase("idle");
    }
  }

  function stopRecording(): void {
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
  }

  function discard(): void {
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setPhase("idle");
    setElapsed(0);
  }

  function send(): void {
    if (!clip) return;
    setPhase("sending");
    startTransition(async () => {
      const fd = new FormData();
      const ext = clip.blob.type.includes("mp4") ? "mp4" : "webm";
      fd.append("recording", new File([clip.blob], `page.${ext}`, { type: clip.blob.type }));
      if (keep) {
        fd.append("keep", "on");
        fd.append("name", saveName);
      }
      const r = await sendRecordedPage(fd);
      if (r.ok) {
        toast.success("Announcement played");
        discard();
        setKeep(false);
        setSaveName("");
      } else {
        toast.error(r.message ?? r.status);
        setPhase("review");
      }
    });
  }

  const seconds = Math.floor(elapsed / 1000);
  const timer = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mic className="size-4 text-primary" /> Speak an announcement
        </CardTitle>
        <CardDescription>
          Record your voice, listen back, then play it through the speakers. Nothing reaches the
          building until you press Send.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!secure ? (
          <Alert variant="destructive">
            <AlertTitle>Microphone unavailable on this address</AlertTitle>
            <AlertDescription>
              Browsers only allow microphone access over HTTPS (or on the console machine itself at
              localhost). Reach the console over HTTPS to record from this device — typed
              announcements and saved cues work either way.
            </AlertDescription>
          </Alert>
        ) : null}

        {phase === "idle" ? (
          <Button onClick={startRecording} disabled={!secure} size="lg" className="gap-2">
            <Mic className="size-4" /> Start recording
          </Button>
        ) : null}

        {phase === "recording" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="relative flex size-3">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" />
                <span className="relative inline-flex size-3 rounded-full bg-destructive" />
              </span>
              <span className="text-sm font-medium tabular-nums">{timer}</span>
              <span className="text-xs text-muted-foreground">
                / {MAX_MS / 60000}:00 max — recording is not playing in the building yet
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-success transition-[width] duration-75"
                style={{ width: `${Math.round(level * 100)}%` }}
              />
            </div>
            <Button onClick={stopRecording} variant="secondary" className="gap-2">
              <Square className="size-4" /> Stop
            </Button>
          </div>
        ) : null}

        {clip && (phase === "review" || phase === "sending") ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <AudioPreview src={clip.url} label="your recording" />
              <span className="text-xs text-muted-foreground">Listen back before sending</span>
            </div>
            <CheckboxField
              label="Save to the sound library for reuse"
              description="Otherwise the recording is discarded after it plays"
              checked={keep}
              onCheckedChange={setKeep}
            />
            {keep ? (
              <Input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Name for the saved recording"
                className="max-w-sm"
              />
            ) : null}
            <div className="flex gap-2">
              <Button onClick={send} disabled={phase === "sending"} className="gap-2">
                {phase === "sending" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {phase === "sending" ? "Playing…" : "Send to speakers"}
              </Button>
              <Button onClick={discard} variant="ghost" disabled={phase === "sending"} className="gap-2">
                <Trash2 className="size-4" /> Discard
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
