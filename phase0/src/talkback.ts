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
import { config } from "./config.js";
import { PrivateSession } from "./private.js";

export const FRAME_MS = 1024 / 24000 * 1000; // 42.667
export const ARM_MS = 400;
export const LEAD_MS = 400;
export const TAIL_MS = 300;

export interface StreamOptions {
  /** Path to any audio file ffmpeg can read. */
  file?: string;
  /** Or: generate N test beeps, one per second. */
  beeps?: number;
  speakerId?: string;
  ffmpegPath?: string;
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

/** Encodes to AAC-ADTS 24kHz mono, the format the speaker's sink accepts. */
export async function encodeAdts(opts: StreamOptions): Promise<Buffer[]> {
  const input = opts.file ? ["-i", opts.file] : beepInput(opts.beeps ?? 3);
  const argv = [
    "-hide_banner", "-loglevel", "error",
    ...input,
    "-c:a", "aac", "-profile:a", "aac_low",
    "-ar", "24000", "-ac", "1", "-b:a", "48k",
    "-f", "adts", "pipe:1",
  ];
  const ff = spawn(opts.ffmpegPath ?? "ffmpeg", argv, { stdio: ["ignore", "pipe", "pipe"] });
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

  const { cookie } = await session.authHeaders();
  const url = `wss://${config.host}/proxy/protect/ws/talkback?speaker=${speakerId}`;
  const ws = new WebSocket(url, {
    headers: { Cookie: cookie, Origin: `https://${config.host}` },
    rejectUnauthorized: false,
  });

  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("unexpected-response", (_r, r) => rej(new Error(`talkback WS rejected: HTTP ${r.statusCode}`)));
    ws.on("error", rej);
  });

  await sleep(ARM_MS);
  const t0 = Date.now();
  let sent = 0;
  for (let i = 0; i < frames.length; i++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    const target = t0 + i * FRAME_MS - LEAD_MS;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    ws.send(frames[i]);
    sent++;
  }
  await sleep(TAIL_MS);
  ws.close();
  return sent;
}

async function defaultSpeakerId(session: PrivateSession): Promise<string> {
  const b = await session.bootstrap();
  const sp = (b.speakers ?? [])[0];
  if (!sp) throw new Error("no speaker found in bootstrap");
  return sp.id;
}
