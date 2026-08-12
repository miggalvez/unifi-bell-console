/**
 * Streams arbitrary audio to a UniFi Protect speaker over the talkback
 * WebSocket. Verified working on UP-AI-Speaker fw 1.0.6 / Protect 7.1.87.
 * Technique derived from pueblokc/protect-soundboard (MIT), which targets the
 * AI Horn; the timing constants below were re-measured for the indoor speaker.
 *
 * The four details that actually matter:
 *   1. Encode fully before connecting — the socket must never wait on ffmpeg.
 *   2. Wait ARM_MS after the socket opens before sending a byte: the NVR arms
 *      the device's sink stream in that window. Skipping it garbles the start.
 *   3. One ADTS frame per WebSocket message, paced 42.667ms (1024 @ 24kHz).
 *   4. Run LEAD_MS ahead of realtime to pre-fill the device's jitter buffer.
 *
 * Do NOT pre-pad the audio with silence (adelay): it silences delivery on this
 * device entirely, even though the soundboard uses it for the Horn.
 *
 * There is no acknowledgement of any kind — the channel is write-only and
 * Protect sends nothing back. A successful return means "we transmitted",
 * never "it played". Use camera-mic scoring (verify-audio.mts) to confirm.
 */
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { env } from "@/env";
import { PrivateSession, getPrivateSession } from "./private";

export const FRAME_MS = 1024 / 24000 * 1000; // 42.667
export const ARM_MS = 400;
export const LEAD_MS = 400;
export const TAIL_MS = 300;

/**
 * Distinguishes "we never sent a byte" from "we were mid-stream". Only the
 * latter is genuinely uncertain — a setup failure means nothing played, and
 * saying otherwise would send someone chasing audio that never happened.
 */
export class TalkbackError extends Error {
  /**
   * True only for failures that a second attempt could plausibly clear — in
   * practice, the speaker refusing a session while it releases the previous
   * one. A bad file, a missing codec or an auth failure will fail identically
   * every time, and retrying those just delays the error.
   */
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly transmitted: boolean,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, options);
    this.name = "TalkbackError";
    this.retryable = options?.retryable ?? false;
  }
}

export interface StreamOptions {
  /** Path to any audio file ffmpeg can read. */
  file?: string;
  /**
   * Several files played as one continuous stream, in order. One session
   * instead of several matters: the speaker needs ~6s to release a talkback
   * session, so gluing a short announcement to the sound it introduces removes
   * both the gap between them and a chance to be refused.
   */
  files?: string[];
  /** Or: generate N test beeps, one per second. */
  beeps?: number;
  /** Or: pure silence, for the gap between repetitions inside a looped stream. */
  silenceSeconds?: number;
  speakerId?: string;
  ffmpegPath?: string;
}

/** Streams to every speaker at once, one socket each. Returns frames per speaker. */
export async function streamToSpeakers(speakerIds: string[], opts: StreamOptions): Promise<number[]> {
  const session = getPrivateSession();
  let frames: Buffer[];
  try {
    // Encode once, fan out — all sockets get identical frames.
    frames = await encodeAdts(opts);
  } catch (err) {
    throw new TalkbackError((err as Error).message, false, { cause: err });
  }
  if (frames.length === 0) throw new TalkbackError("no audio frames produced by ffmpeg", false);

  const results = await Promise.allSettled(speakerIds.map((id) => sendFrames(session, id, frames)));
  const sent = results.map((r) => (r.status === "fulfilled" ? r.value : 0));
  if (sent.every((n) => n === 0)) {
    // Every speaker failed — surface the first reason and whether anything went out.
    const firstRejection = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    const cause = firstRejection?.reason as TalkbackError | Error | undefined;
    throw new TalkbackError(
      cause?.message ?? "no frames transmitted",
      cause instanceof TalkbackError ? cause.transmitted : false,
      { cause, retryable: cause instanceof TalkbackError ? cause.retryable : false },
    );
  }
  return sent;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits an ADTS bitstream into individual frames (sync word + 13-bit length). */
export function splitAdts(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  while (off + 7 <= buf.length) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) {
      const sync = buf.indexOf(0xff, off + 1);
      if (sync < 0) break;
      off = sync;
      continue;
    }
    const len = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | (buf[off + 5] >> 5);
    if (len < 7 || off + len > buf.length) break;
    frames.push(buf.subarray(off, off + len));
    off += len;
  }
  return frames;
}

function beepInput(n: number): string[] {
  return ["-f", "lavfi", "-i", `aevalsrc=sin(2*PI*880*t)*lt(mod(t\\,1)\\,0.35):d=${n}:s=48000`];
}

/**
 * Interior silence, for the gap between repetitions inside a looped stream.
 * This is NOT the forbidden leading pad: phase 0 measured that silence at the
 * START of a stream kills delivery, but silence in the middle is ordinary
 * audio content — the 4-minute longevity test was 65% interior silence by
 * construction (0.35s of tone per 1s cycle) and played to the end.
 */
function silenceInput(seconds: number): string[] {
  return ["-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono`, "-t", String(seconds)];
}

/** Encodes to AAC-ADTS 24kHz mono, the format the speaker's sink accepts. */
export async function encodeAdts(opts: StreamOptions): Promise<Buffer[]> {
  const list = opts.files?.length ? opts.files : opts.file ? [opts.file] : null;
  // concat joins the inputs into one continuous stream. Sample rates and
  // channel counts are normalised by the encode flags below, so files that
  // were recorded differently still splice cleanly.
  const input = list
    ? [
        ...list.flatMap((f) => ["-i", f]),
        ...(list.length > 1
          ? [
              "-filter_complex",
              `${list.map((_, i) => `[${i}:a]`).join("")}concat=n=${list.length}:v=0:a=1[out]`,
              "-map",
              "[out]",
            ]
          : []),
      ]
    : opts.silenceSeconds
      ? silenceInput(opts.silenceSeconds)
      : beepInput(opts.beeps ?? 3);
  const argv = [
    "-hide_banner", "-loglevel", "error",
    ...input,
    "-c:a", "aac", "-profile:a", "aac_low",
    "-ar", "24000", "-ac", "1", "-b:a", "48k",
    "-f", "adts", "pipe:1",
  ];
  // turbopackIgnore: ffmpeg is a system binary, not a project file — without
  // this, Turbopack traces the entire project (public/ included) into the
  // server bundle.
  const ff = spawn(/* turbopackIgnore: true */ opts.ffmpegPath ?? "ffmpeg", argv, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  ff.stdout.on("data", (c: Buffer) => chunks.push(c));
  ff.stderr.on("data", (d) => (stderr += String(d)));
  const code = await new Promise<number>((res) => ff.on("close", (c) => res(c ?? -1)));
  if (code !== 0) throw new Error(`ffmpeg encode failed: ${stderr.slice(0, 300)}`);
  return splitAdts(Buffer.concat(chunks));
}

/** Returns the number of frames transmitted. */
export async function streamToSpeaker(session: PrivateSession, opts: StreamOptions): Promise<number> {
  const speakerId = opts.speakerId ?? (await defaultSpeakerId(session));
  const frames = await encodeAdts(opts);
  return sendFrames(session, speakerId, frames);
}

async function openTalkbackSocket(
  session: PrivateSession,
  speakerId: string,
  retriedAuth = false,
): Promise<WebSocket> {
  try {
    const { cookie } = await session.authHeaders();
    const url = `wss://${env.protectHost}/proxy/protect/ws/talkback?speaker=${speakerId}`;
    const ws = new WebSocket(url, {
      headers: { Cookie: cookie, Origin: `https://${env.protectHost}` },
      rejectUnauthorized: false,
    });
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("unexpected-response", (_r, r) => rej(new Error(`talkback WS rejected: HTTP ${r.statusCode}`)));
      ws.on("error", rej);
    });
    // Swallow late socket errors: after open, failure shows up as readyState
    // closing mid-send, which every caller already handles. Without a handler
    // an ECONNRESET after close would crash the process.
    ws.on("error", () => {});
    return ws;
  } catch (err) {
    // A 401 handshake means the cached Protect session has expired — the same
    // condition request() recovers from on the HTTP path. Log in fresh and
    // retry once; anything else (or a second 401) is a real failure.
    if (!retriedAuth && /HTTP 401/.test((err as Error).message ?? "")) {
      session.invalidate();
      return openTalkbackSocket(session, speakerId, true);
    }
    // Nothing reached the speaker: auth, connection, or a code error.
    throw new TalkbackError((err as Error).message, false, { cause: err });
  }
}

async function sendFrames(session: PrivateSession, speakerId: string, frames: Buffer[]): Promise<number> {
  const ws = await openTalkbackSocket(session, speakerId);
  let sent = 0;

  try {
    await sleep(ARM_MS); // let the NVR arm the device's sink stream
    const t0 = Date.now();
    for (let i = 0; i < frames.length; i++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      const target = t0 + i * FRAME_MS - LEAD_MS;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      ws.send(frames[i]);
      sent++;
    }
    await sleep(TAIL_MS);
    // The socket closing during the arm delay is the speaker refusing a second
    // session while it is still tearing the last one down. Nothing was sent,
    // so say that plainly instead of returning a silent zero — the caller can
    // then retry safely, knowing no audio reached anyone.
    if (sent === 0) {
      throw new TalkbackError(
        "the speaker closed the talkback session before any audio was sent — still busy with the previous one?",
        false,
        { retryable: true },
      );
    }
    return sent;
  } catch (err) {
    throw new TalkbackError((err as Error).message, sent > 0, { cause: err });
  } finally {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }
}

async function defaultSpeakerId(session: PrivateSession): Promise<string> {
  const b = await session.bootstrap();
  const sp = (b.speakers ?? [])[0];
  if (!sp) throw new Error("no speaker found in bootstrap");
  return sp.id;
}

/**
 * How long a speaker needs to release a talkback session before it will
 * cleanly accept the next one. Measured floor 6s (scripts/talkback-spacing.ts,
 * 2026-08-08) plus margin. Lives here so the loop below and the speaker lock
 * share one number; re-exported by speaker-lock for its callers.
 */
export const SESSION_RECOVERY_MS = 7_000;

export interface LoopOptions {
  /** One cycle's audio — spliced in order, exactly like StreamOptions.files. */
  files: string[];
  /** Silence between cycles, rendered INSIDE the stream (0 = back to back). */
  gapSeconds?: number;
  /** Epoch ms. No new cycle starts at or past this; the current one finishes. */
  until: number;
  /**
   * Checked before every frame (~every 43ms). Returning true stops the stream
   * almost immediately — this is what makes a Stop button actually silence a
   * speaker, which one-shot deliveries can never do.
   */
  shouldStop: () => boolean;
  ffmpegPath?: string;
}

export interface LoopResult {
  /** Completed cycles, from the speaker that got furthest. */
  cycles: number;
  frames: number;
  reconnects: number;
  ended: "until" | "stopped";
}

/** A connection that dies this many times without completing a cycle is dead. */
const LOOP_MAX_CONSECUTIVE_FAILURES = 4;

/**
 * Plays a cycle of files on repeat, as ONE talkback session per speaker, until
 * a deadline or an abort. This exists because per-repetition sessions cannot
 * be spaced closer than SESSION_RECOVERY_MS without the speaker swallowing
 * each opening — verified by ear; a single continuous session has no interior
 * boundaries to pay for. A 240s session was verified end-to-end on hardware.
 *
 * If a socket dies mid-stream the loop reconnects after SESSION_RECOVERY_MS
 * and RESTARTS the interrupted cycle from its beginning — the cycle opens with
 * the drill/alert announcement, so a resumed sound is never heard untagged.
 */
export async function streamLoopToSpeakers(speakerIds: string[], opts: LoopOptions): Promise<LoopResult> {
  const session = getPrivateSession();
  let cycleFrames: Buffer[];
  let gapFrames: Buffer[] = [];
  try {
    cycleFrames = await encodeAdts({ files: opts.files, ffmpegPath: opts.ffmpegPath });
    if (opts.gapSeconds && opts.gapSeconds > 0) {
      gapFrames = await encodeAdts({ silenceSeconds: opts.gapSeconds, ffmpegPath: opts.ffmpegPath });
    }
  } catch (err) {
    throw new TalkbackError((err as Error).message, false, { cause: err });
  }
  if (cycleFrames.length === 0) throw new TalkbackError("no audio frames produced by ffmpeg", false);

  const results = await Promise.allSettled(speakerIds.map((id) => loopOneSpeaker(session, id, cycleFrames, gapFrames, opts)));
  const ok = results.filter((r): r is PromiseFulfilledResult<LoopResult> => r.status === "fulfilled");
  if (ok.length === 0) {
    const cause = (results[0] as PromiseRejectedResult | undefined)?.reason as Error | undefined;
    throw new TalkbackError(
      cause?.message ?? "no frames transmitted",
      cause instanceof TalkbackError ? cause.transmitted : false,
      { cause, retryable: cause instanceof TalkbackError ? cause.retryable : false },
    );
  }
  const best = ok.map((r) => r.value).sort((a, b) => b.frames - a.frames)[0];
  return { ...best, reconnects: ok.reduce((a, r) => a + r.value.reconnects, 0) };
}

async function loopOneSpeaker(
  session: PrivateSession,
  speakerId: string,
  cycleFrames: Buffer[],
  gapFrames: Buffer[],
  opts: LoopOptions,
): Promise<LoopResult> {
  let cycles = 0;
  let frames = 0;
  let reconnects = 0;
  let consecutiveFailures = 0;
  let ended: LoopResult["ended"] = "until";

  const done = () => {
    if (opts.shouldStop()) {
      ended = "stopped";
      return true;
    }
    return Date.now() >= opts.until;
  };

  while (!done()) {
    let ws: WebSocket;
    try {
      ws = await openTalkbackSocket(session, speakerId);
    } catch (err) {
      if (++consecutiveFailures >= LOOP_MAX_CONSECUTIVE_FAILURES) {
        throw new TalkbackError(
          `could not (re)establish the talkback session after ${consecutiveFailures} attempts: ${(err as Error).message}`,
          frames > 0,
          { cause: err, retryable: frames === 0 },
        );
      }
      await sleep(SESSION_RECOVERY_MS);
      continue;
    }

    let socketDied = false;
    try {
      await sleep(ARM_MS);
      // Pacing restarts per connection: frame index i against this socket's t0.
      const t0 = Date.now();
      let i = 0;
      const sendPaced = async (frame: Buffer): Promise<boolean> => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        const wait = t0 + i * FRAME_MS - LEAD_MS - Date.now();
        if (wait > 0) await sleep(wait);
        ws.send(frame);
        i++;
        frames++;
        return true;
      };

      streaming: while (!done()) {
        // A cycle is atomic: interrupted ones are restarted, never resumed
        // part-way, so the announcement at its head is never skipped.
        const framesBefore = frames;
        for (const frame of cycleFrames) {
          if (opts.shouldStop()) {
            ended = "stopped";
            break streaming;
          }
          if (!(await sendPaced(frame))) {
            socketDied = true;
            frames = framesBefore; // the partial cycle replays after reconnect
            break streaming;
          }
        }
        cycles++;
        consecutiveFailures = 0;
        // The between-repetitions gap, skipped when nothing follows it.
        if (gapFrames.length > 0 && !done()) {
          for (const frame of gapFrames) {
            if (opts.shouldStop()) {
              ended = "stopped";
              break streaming;
            }
            if (Date.now() >= opts.until) break;
            if (!(await sendPaced(frame))) {
              // Dying during silence loses nothing worth replaying.
              socketDied = true;
              break streaming;
            }
          }
        }
      }
      if (!socketDied) await sleep(TAIL_MS);
    } finally {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }

    if (!socketDied) break; // clean end: deadline reached or stopped

    if (++consecutiveFailures >= LOOP_MAX_CONSECUTIVE_FAILURES) {
      throw new TalkbackError(
        `the talkback session kept dying (${consecutiveFailures} times in a row) — giving up`,
        frames > 0,
        { retryable: frames === 0 },
      );
    }
    reconnects++;
    await sleep(SESSION_RECOVERY_MS);
  }

  // Zero cycles with a clean exit means the deadline or an abort arrived
  // before anything went out — a caller decision, not an error. Refusals and
  // dead sockets already threw above via the consecutive-failure cap.
  return { cycles, frames, reconnects, ended };
}
