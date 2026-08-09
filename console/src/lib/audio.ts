/**
 * Uploaded audio storage. Files live on disk under data/audio/; the
 * audio_files table is the catalogue. Streaming to speakers is handled by
 * lib/protect/talkback.ts.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { env, projectRoot } from "@/env";

export const AUDIO_DIR = resolve(projectRoot, "data", "audio");
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".aiff"];

export function audioPath(storedName: string): string {
  return resolve(AUDIO_DIR, storedName);
}

/** ffprobe duration in ms; null when ffmpeg isn't installed or the file is unreadable. */
export function probeDurationMs(file: string): Promise<number | null> {
  return new Promise((res) => {
    const p = spawn(
      env.ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("error", () => res(null));
    p.on("close", (code) => {
      const secs = Number(out.trim());
      res(code === 0 && Number.isFinite(secs) ? Math.round(secs * 1000) : null);
    });
  });
}

/** True when ffmpeg is available — streaming is unavailable without it. */
export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((res) => {
    const p = spawn(env.ffmpegPath, ["-version"], { stdio: "ignore" });
    p.on("error", () => res(false));
    p.on("close", (code) => res(code === 0));
  });
}

export interface SavedAudio {
  storedName: string;
  sizeBytes: number;
  durationMs: number | null;
}

export async function saveUpload(file: File): Promise<SavedAudio | { error: string }> {
  const ext = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { error: `Unsupported file type "${ext || "unknown"}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}` };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: `File is ${(file.size / 1048576).toFixed(1)}MB; the limit is ${MAX_UPLOAD_BYTES / 1048576}MB.` };
  }
  if (file.size === 0) return { error: "File is empty." };

  mkdirSync(AUDIO_DIR, { recursive: true });
  // Random stored name: uploads never influence the path we write to.
  const storedName = `${randomUUID()}${ext}`;
  const target = audioPath(storedName);
  writeFileSync(target, Buffer.from(await file.arrayBuffer()));

  const durationMs = await probeDurationMs(target);
  if (durationMs === null) {
    // Unreadable by ffprobe means unplayable by ffmpeg — don't keep it.
    try {
      unlinkSync(target);
    } catch {
      /* best effort */
    }
    return { error: "Could not read that file as audio. Try a standard MP3 or WAV." };
  }
  return { storedName, sizeBytes: file.size, durationMs };
}

/** What MediaRecorder produces, by browser: webm/opus (Chrome), mp4 (Safari). */
export const RECORDING_EXTENSIONS = [".webm", ".mp4", ".ogg", ".m4a", ".wav"];
export const MAX_RECORDING_MS = 120_000;

/**
 * Saves a browser recording into the same store as uploads, so it can be
 * promoted into the library later without moving bytes around.
 */
export async function saveRecording(file: File): Promise<SavedAudio | { error: string }> {
  if (file.size === 0) return { error: "Recording was empty." };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Recording is too large." };

  // MediaRecorder mime types look like "audio/webm;codecs=opus".
  const mime = (file.type || "").split(";")[0].toLowerCase();
  const extFromMime: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
  };
  const ext = extFromMime[mime] ?? extname(file.name).toLowerCase();
  if (!RECORDING_EXTENSIONS.includes(ext)) {
    return { error: `Unsupported recording format "${mime || ext || "unknown"}".` };
  }

  mkdirSync(AUDIO_DIR, { recursive: true });
  const storedName = `rec-${randomUUID()}${ext}`;
  const target = audioPath(storedName);
  writeFileSync(target, Buffer.from(await file.arrayBuffer()));

  const durationMs = await probeDurationMs(target);
  if (durationMs === null) {
    deleteStoredAudio(storedName);
    return { error: "Could not read the recording as audio." };
  }
  if (durationMs > MAX_RECORDING_MS + 5000) {
    deleteStoredAudio(storedName);
    return { error: `Recording is ${Math.round(durationMs / 1000)}s; the limit is ${MAX_RECORDING_MS / 1000}s.` };
  }
  return { storedName, sizeBytes: file.size, durationMs };
}

export function deleteStoredAudio(storedName: string): void {
  const p = audioPath(storedName);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* best effort — the catalogue row is the source of truth */
    }
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
