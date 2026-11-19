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
import dgram from "node:dgram";
import { isIPv4 } from "node:net";
import WebSocket from "ws";
import { env } from "@/env";
import { PrivateSession, getPrivateSession } from "./private";

export const FRAME_MS = 1024 / 24000 * 1000; // 42.667
export const ARM_MS = 400;
export const LEAD_MS = 400;
export const TAIL_MS = 300;

/**
 * How long speakers that are already connected wait for a slower one, so the
 * whole building starts on one clock. Connections normally open ~0.1s apart
 * (measured 2026-11-18: a 0.3s spread across four speakers), and each speaker
 * used to start the moment its own connection opened — an echo wherever two
 * speakers are in earshot, and seconds of it on the bells where one
 * connection is slow.
 *
 * How long a connected speaker tolerates silence before its first frame was
 * measured on the school's four speakers on 2026-11-18
 * (scripts/talkback-hold.ts): at holds of 0.4, 1, 2, 3 and 5 seconds every
 * speaker kept its session and took every frame, and all six beeps were heard
 * at each. The wait here plus ARM_MS stays at less than half the longest hold
 * that was verified. A speaker slower than this starts late on its own clock
 * and is named in the result; one that fails outright never holds anyone.
 */
export const SYNC_WAIT_MS = 2_000;

/**
 * Where a speaker listens for audio once a talkback session is open. Protect
 * sets this when the WebSocket connects ("typeIn":"serverudp","bindPort":7004,
 * no source filter) and then acts as a plain relay: every frame it is sent
 * over the WebSocket leaves as one identical UDP datagram to this port
 * (captured on the wire, 2026-11-19).
 *
 * That relay runs on Protect's main thread, and Protect forces a garbage
 * collection every five minutes that stops that thread for 0.4–1.9s. Any bell
 * playing at that moment lost the audio that should have been relayed during
 * it. Sent straight to the speaker, the same frames are untouched by the
 * pause — verified by ear on four speakers across a 587ms and a 1,068ms pause.
 */
export const SPEAKER_AUDIO_PORT = 7004;

/**
 * With the audio going direct, the WebSocket carries nothing — it only keeps
 * the speaker armed. A ping this often keeps an otherwise silent connection
 * from looking dead to anything in between. In frames: about five seconds.
 */
const DIRECT_KEEPALIVE_FRAMES = 117;

/** A speaker this far behind the shared start is worth telling someone about. */
export const LATE_NOTE_MS = 100;

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
  /**
   * Speaker id → that speaker's own LAN address. A speaker listed here is sent
   * its audio directly (see SPEAKER_AUDIO_PORT) and nothing through Protect;
   * the session is still opened through Protect, which is what arms it. A
   * speaker not listed, or listed with something that is not an IPv4 address,
   * is relayed through Protect as before. Never both: that plays twice.
   *
   * Only for a caller that knows this machine can reach the speakers — a
   * datagram to an unreachable address fails silently.
   */
  directHosts?: ReadonlyMap<string, string>;
  /**
   * Measurement only (scripts/talkback-hold.ts): how long a connected speaker
   * is left silent before the first frame. Deliveries use ARM_MS.
   */
  armMs?: number;
  /**
   * Measurement only: polled about every 100ms while waiting and before every
   * frame; returning true abandons the stream at once, so a test tone gets
   * off the speakers the moment something real needs them.
   */
  shouldStop?: () => boolean;
}

/**
 * A speaker that did not get the whole stream. One speaker failing never sinks
 * the others, so without this a run that reached half the building looks
 * exactly like one that reached all of it.
 */
export interface SpeakerShortfall {
  speakerId: string;
  /** True when some audio reached it before its stream stopped. */
  partial: boolean;
  /** The failure, when there was one; a socket that just closed early has none. */
  error?: string;
}

export interface FanOutResult {
  /** Frames in the encoded audio — what a complete delivery sends each speaker. */
  frames: number;
  /** Frames actually sent, per speaker, in the order the ids were given. */
  sent: number[];
  /** Speakers that got less than all of it. Empty when every speaker got everything. */
  missed: SpeakerShortfall[];
  /**
   * Speakers that played, but started after the rest because their connection
   * took longer than SYNC_WAIT_MS to open. Empty when everyone started together.
   */
  late: { speakerId: string; lateMs: number }[];
  /** How many speakers were sent their audio directly rather than via Protect. */
  direct: number;
}

/**
 * Streams to every speaker at once, one socket each, all on one clock: the
 * connections open first, then every speaker is sent frame N at the same
 * moment. Throws only when no speaker got anything; otherwise the shortfalls
 * are in `missed` and anyone who started behind the others is in `late`.
 */
export async function streamToSpeakers(speakerIds: string[], opts: StreamOptions): Promise<FanOutResult> {
  const session = getPrivateSession();
  let frames: Buffer[];
  try {
    // Encode once, fan out — all sockets get identical frames.
    frames = await encodeAdts(opts);
  } catch (err) {
    throw new TalkbackError((err as Error).message, false, { cause: err });
  }
  if (frames.length === 0) throw new TalkbackError("no audio frames produced by ffmpeg", false);

  const armMs = opts.armMs ?? ARM_MS;
  const gate = startGate(speakerIds.length, armMs);
  const sharedStart = gate.start;
  const startedAt: (number | undefined)[] = speakerIds.map(() => undefined);
  const hosts = speakerIds.map((id) => {
    const host = opts.directHosts?.get(id);
    return host !== undefined && isIPv4(host) ? host : undefined;
  });
  // One socket serves every direct speaker. Its errors must never take the
  // process down; a failed send is reported through the sink instead.
  const udp = hosts.some((h) => h !== undefined) ? dgram.createSocket("udp4") : null;
  udp?.on("error", () => {});
  const results = await Promise.allSettled(
    speakerIds.map(async (id, i) => {
      let ws: WebSocket;
      try {
        ws = await openTalkbackSocket(session, id);
      } catch (err) {
        gate.report(false);
        throw err;
      }
      const openedAt = Date.now();
      gate.report(true);
      // A speaker that missed the shared start still gets its full arm delay.
      const start = Math.max(await sharedStart, openedAt + armMs);
      startedAt[i] = start;
      const host = hosts[i];
      return sendOnSocket(ws, frames, start, opts.shouldStop, udp && host ? directSink(udp, host) : undefined);
    }),
  );
  try {
    udp?.close();
  } catch {
    /* already closed */
  }
  const sent = results.map((r) => (r.status === "fulfilled" ? r.value : 0));
  if (sent.every((n) => n === 0)) throw everySpeakerFailed(results);
  const missed: SpeakerShortfall[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value >= frames.length) return;
    const err = r.status === "rejected" ? (r.reason as Error) : undefined;
    missed.push({
      speakerId: speakerIds[i],
      partial: err instanceof TalkbackError ? err.transmitted : sent[i] > 0,
      error: err?.message,
    });
  });
  const shared = await sharedStart;
  const late = speakerIds.flatMap((speakerId, i) => {
    const lateMs = (startedAt[i] ?? shared) - shared;
    return sent[i] > 0 && lateMs >= LATE_NOTE_MS ? [{ speakerId, lateMs }] : [];
  });
  const direct = hosts.filter((h, i) => h !== undefined && sent[i] > 0).length;
  return { frames: frames.length, sent, missed, late, direct };
}

/**
 * Delivers frames straight to one speaker. A send the OS rejects (no route,
 * socket closed) surfaces on the NEXT frame, as a throw, so the caller's
 * ordinary failure handling sees it; a datagram lost on the wire is silent,
 * like everything else about this channel.
 */
function directSink(udp: dgram.Socket, host: string): (frame: Buffer) => void {
  let failed: Error | null = null;
  return (frame) => {
    if (failed) throw failed;
    udp.send(frame, SPEAKER_AUDIO_PORT, host, (err) => {
      if (err) failed = err;
    });
  };
}

/**
 * The moment every speaker in a fan-out starts: one arm delay after the last
 * connection is in, or after SYNC_WAIT_MS has passed since the first one
 * opened — whichever comes first. Each speaker reports how its first
 * connection attempt went; a failure counts as "in", so a speaker that is
 * offline or refuses the session never holds the others.
 *
 * A connection that opens after the gate (a slow speaker, or a reconnect much
 * later) simply takes its own arm delay: start = max(shared, openedAt + arm).
 */
function startGate(speakers: number, armMs: number): { start: Promise<number>; report(opened: boolean): void } {
  let resolve!: (at: number) => void;
  const start = new Promise<number>((r) => (resolve = r));
  let cap: ReturnType<typeof setTimeout> | undefined;
  let reported = 0;
  const go = (): void => {
    clearTimeout(cap);
    resolve(Date.now() + armMs);
  };
  if (speakers === 0) go();
  return {
    start,
    report(opened) {
      if (opened) cap ??= setTimeout(go, SYNC_WAIT_MS);
      if (++reported >= speakers) go();
    },
  };
}

/**
 * The one error for a fan-out in which no speaker completed. Its two flags
 * decide what the caller may do next, so they are judged across EVERY
 * speaker, never just the first one listed:
 *
 *   - transmitted: any speaker was sent audio before failing. One room having
 *     heard part of it makes the whole delivery uncertain.
 *   - retryable: nobody was sent anything AND at least one failure is the
 *     passing kind (a refused session). Trying again cannot ring twice
 *     anywhere, and may reach the speaker that was only busy.
 *
 * A failure of unknown shape counts as transmitted — the cautious reading.
 */
function everySpeakerFailed(results: PromiseSettledResult<unknown>[]): TalkbackError {
  const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason as TalkbackError | Error] : []));
  const heard = failures.find((e) => !(e instanceof TalkbackError) || e.transmitted);
  const cause = heard ?? failures[0];
  return new TalkbackError(cause?.message ?? "no frames transmitted", heard !== undefined, {
    cause,
    retryable: heard === undefined && failures.some((e) => e instanceof TalkbackError && e.retryable),
  });
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
  let cookie: string | undefined;
  try {
    ({ cookie } = await session.authHeaders());
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
      // Name the cookie that was refused: every speaker's socket hits the same
      // expiry, and they must share one fresh sign-in rather than each undo
      // the last one's.
      session.invalidate(cookie);
      return openTalkbackSocket(session, speakerId, true);
    }
    // Nothing reached the speaker: auth, connection, or a code error.
    throw new TalkbackError((err as Error).message, false, { cause: err });
  }
}

async function sendFrames(session: PrivateSession, speakerId: string, frames: Buffer[]): Promise<number> {
  const ws = await openTalkbackSocket(session, speakerId);
  return sendOnSocket(ws, frames, Date.now() + ARM_MS);
}

/**
 * Sends the frames on an open socket, the first one at `startAt` — which must
 * leave the NVR its arm delay after the socket opened — and closes the socket.
 * Taking the start time from the caller is what lets several speakers share
 * one clock. Returns the number of frames transmitted.
 *
 * With a `direct` sink the frames go to it instead and the socket carries
 * none: it stays open only because an open session is what keeps the speaker
 * listening, and it still ends the delivery if it closes.
 */
async function sendOnSocket(
  ws: WebSocket,
  frames: Buffer[],
  startAt: number,
  shouldStop?: () => boolean,
  direct?: (frame: Buffer) => void,
): Promise<number> {
  let sent = 0;
  const stopped = (): boolean => shouldStop?.() ?? false;

  try {
    // Let the NVR arm the device's sink stream; nothing goes out before this.
    // With a stop check the wait is sliced, so a long hold can be abandoned.
    while (!stopped()) {
      const arm = startAt - Date.now();
      if (arm <= 0) break;
      await sleep(shouldStop ? Math.min(arm, 100) : arm);
    }
    for (let i = 0; i < frames.length; i++) {
      if (stopped() || ws.readyState !== WebSocket.OPEN) break;
      const wait = startAt + i * FRAME_MS - LEAD_MS - Date.now();
      if (wait > 0) await sleep(wait);
      if (direct) {
        direct(frames[i]);
        if (i > 0 && i % DIRECT_KEEPALIVE_FRAMES === 0 && ws.readyState === WebSocket.OPEN) ws.ping();
      } else {
        ws.send(frames[i]);
      }
      sent++;
    }
    // Abandoned on request: a short count, not a refusal by the speaker.
    if (stopped()) return sent;
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
    // Already classified (the refusal above): rewrapping it would drop
    // `retryable`, and the caller's safe retry would never run.
    if (err instanceof TalkbackError) throw err;
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
  /** Speakers whose loop gave up while others kept sounding. */
  missed: SpeakerShortfall[];
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
 * All speakers begin their first cycle at the same moment (see startGate).
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

  const gate = startGate(speakerIds.length, ARM_MS);
  const results = await Promise.allSettled(
    speakerIds.map((id) => loopOneSpeaker(session, id, cycleFrames, gapFrames, opts, gate)),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<LoopResult> => r.status === "fulfilled");
  if (ok.length === 0) throw everySpeakerFailed(results);
  const missed: SpeakerShortfall[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") return;
    const err = r.reason as Error;
    missed.push({
      speakerId: speakerIds[i],
      partial: err instanceof TalkbackError ? err.transmitted : false,
      error: err?.message,
    });
  });
  const best = ok.map((r) => r.value).sort((a, b) => b.frames - a.frames)[0];
  return { ...best, reconnects: ok.reduce((a, r) => a + r.value.reconnects, 0), missed };
}

async function loopOneSpeaker(
  session: PrivateSession,
  speakerId: string,
  cycleFrames: Buffer[],
  gapFrames: Buffer[],
  opts: LoopOptions,
  gate: ReturnType<typeof startGate>,
): Promise<LoopResult> {
  let cycles = 0;
  let frames = 0;
  let reconnects = 0;
  let consecutiveFailures = 0;
  let ended: LoopResult["ended"] = "until";
  // Only the first connection attempt counts towards the shared start; later
  // ones are reconnects, long after everyone else began.
  let firstAttempt = true;
  const reportFirst = (opened: boolean): void => {
    if (!firstAttempt) return;
    firstAttempt = false;
    gate.report(opened);
  };

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
      reportFirst(false);
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

    const openedAt = Date.now();
    reportFirst(true);
    let socketDied = false;
    try {
      // Every speaker's first connection starts at the shared moment, so the
      // building hears one announcement rather than four a fraction apart. A
      // reconnect finds that moment long past and just takes its arm delay.
      // Waited in slices: Stop must not sit behind a slow speaker.
      let shared: number | undefined;
      const sharedKnown = gate.start.then((at) => {
        shared = at;
      });
      while (shared === undefined && !done()) await Promise.race([sharedKnown, sleep(100)]);
      // Pacing restarts per connection: frame index i against this socket's t0.
      const t0 = Math.max(shared ?? 0, openedAt + ARM_MS);
      while (!done()) {
        const arm = t0 - Date.now();
        if (arm <= 0) break;
        await sleep(Math.min(arm, 100));
      }
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

  // Never got as far as a first attempt (stopped before it began): still
  // counted, or the others would wait out the full sync window for nobody.
  reportFirst(false);

  // Zero cycles with a clean exit means the deadline or an abort arrived
  // before anything went out — a caller decision, not an error. Refusals and
  // dead sockets already threw above via the consecutive-failure cap.
  return { cycles, frames, reconnects, ended, missed: [] };
}
