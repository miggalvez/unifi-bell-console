/**
 * EXPERIMENT: arbitrary audio to the UP-AI-Speaker.
 * Usage: npx tsx src/stream.mts <mode> [--file path] [--seconds n]
 *
 * Modes:
 *   udp-rtp-opus   ffmpeg sends RTP/Opus straight to the speaker's declared
 *                  talkback port (typeFmt=opus, typeIn=serverudp, port 7004)
 *   udp-opus-raw   bare Opus packets over UDP, 20ms pacing (no RTP framing)
 *   ws-aac         AAC-ADTS frames over Protect's talkback WebSocket
 *                  (port of pueblokc/protect-soundboard's Horn technique)
 *
 * Every mode runs a watcher that prints speakerState.status transitions —
 * if status leaves "idle" the device is consuming our audio even if muted.
 */
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import WebSocket from "ws";
import { PrivateSession } from "./private.js";
import { config, requirePrivateCreds } from "./config.js";
import * as official from "./official.js";

const args = process.argv.slice(2);
const mode = args[0];
const fileIdx = args.indexOf("--file");
const file = fileIdx >= 0 ? args[fileIdx + 1] : null;
const secIdx = args.indexOf("--seconds");
const seconds = secIdx >= 0 ? Number(args[secIdx + 1]) : 5;
const beepIdx = args.indexOf("--beeps");
const beeps = beepIdx >= 0 ? Number(args[beepIdx + 1]) : 0;
const padIdx = args.indexOf("--pad-ms");
const padArg = padIdx >= 0 ? Number(args[padIdx + 1]) : 0;

/**
 * `--beeps N` emits N distinct 0.35s tones, one per second. Used by the sweep
 * so the audio itself says which transport worked — speakerState.status is a
 * useless oracle here (it stayed "idle" through a run that was audible).
 */
function beepInput(n: number): string[] {
  return ["-f", "lavfi", "-i", `aevalsrc=sin(2*PI*880*t)*lt(mod(t\\,1)\\,0.35):d=${n}:s=48000`];
}

let INPUT_ARGS = file
  ? ["-i", file]
  : beeps > 0
    ? beepInput(beeps)
    : ["-f", "lavfi", "-i", `sine=frequency=660:beep_factor=2:duration=${seconds}`];

function setBeeps(n: number): void {
  INPUT_ARGS = beepInput(n);
}

interface SpeakerInfo {
  id: string;
  ip: string;
  port: number;
}

async function getSpeaker(session: PrivateSession): Promise<SpeakerInfo> {
  const b = await session.bootstrap();
  const sp = (b.speakers ?? [])[0];
  if (!sp) throw new Error("no speaker in bootstrap");
  const ts = sp.talkbackSettings as { bindPort?: number } | undefined;
  return { id: sp.id, ip: String(sp.host), port: ts?.bindPort ?? 7004 };
}

function startStatusWatcher(): () => Promise<string[]> {
  const seen: string[] = [];
  let last = "";
  let stop = false;
  const loop = (async () => {
    for (;;) {
      if (stop) return;
      try {
        const { body } = await official.listSpeakers();
        const status = body[0]?.speakerState?.status ?? "?";
        if (status !== last) {
          last = status;
          seen.push(status);
          console.log(`  [watcher] speakerState.status -> ${status}`);
        }
      } catch {
        /* keep watching */
      }
      await sleep(700);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    return seen;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Leading silence gives the far-end decoder time to sync before real audio —
// without it the first ~0.5s garbles (observed live on the UP-AI-Speaker).
let PAD_MS = 0;
function setPad(ms: number): void {
  PAD_MS = ms;
}

function runFfmpeg(extra: string[], opts: { realtime?: boolean } = {}): ReturnType<typeof spawn> {
  const pad = PAD_MS > 0 ? ["-af", `adelay=${PAD_MS}:all=1`] : [];
  const re = opts.realtime ? ["-re"] : [];
  const argv = ["-hide_banner", "-loglevel", "warning", ...re, ...INPUT_ARGS, ...pad, ...extra];
  console.log(`  ffmpeg ${argv.join(" ")}`);
  return spawn("ffmpeg", argv, { stdio: ["ignore", "pipe", "inherit"] });
}

// ---------------------------------------------------------------- modes

async function udpRtpOpus(sp: SpeakerInfo): Promise<void> {
  console.log(`RTP/Opus -> udp ${sp.ip}:${sp.port}`);
  const ff = runFfmpeg(
    [
      "-ar", "24000", "-ac", "1",
      "-c:a", "libopus", "-b:a", "32k", "-application", "audio",
      "-payload_type", "111",
      "-f", "rtp", `rtp://${sp.ip}:${sp.port}`,
    ],
    { realtime: true },
  );
  await new Promise<void>((res) => ff.on("close", () => res()));
}

/** ffmpeg → Ogg/Opus → bare Opus packets (headers skipped). */
async function collectOpusPackets(): Promise<Buffer[]> {
  const ff = runFfmpeg(["-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "48k", "-frame_duration", "20", "-f", "ogg", "pipe:1"]);
  const packets: Buffer[] = [];
  let buf = Buffer.alloc(0);
  let packetIndex = 0;
  let pending = Buffer.alloc(0);

  ff.stdout!.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    // Minimal Ogg page parser
    for (;;) {
      const idx = buf.indexOf("OggS");
      if (idx < 0 || buf.length < idx + 27) break;
      const page = buf.subarray(idx);
      const nSegs = page[26];
      if (page.length < 27 + nSegs) break;
      const segTable = page.subarray(27, 27 + nSegs);
      let bodyLen = 0;
      for (const s of segTable) bodyLen += s;
      if (page.length < 27 + nSegs + bodyLen) break;
      let off = 27 + nSegs;
      for (const lace of segTable) {
        pending = Buffer.concat([pending, page.subarray(off, off + lace)]);
        off += lace;
        if (lace < 255) {
          // end of packet; skip OpusHead/OpusTags
          if (packetIndex >= 2) packets.push(pending);
          packetIndex++;
          pending = Buffer.alloc(0);
        }
      }
      buf = page.subarray(27 + nSegs + bodyLen);
    }
  });

  await new Promise<void>((res) => ff.on("close", () => res()));
  return packets;
}

async function udpOpusRaw(sp: SpeakerInfo): Promise<void> {
  console.log(`raw Opus packets -> udp ${sp.ip}:${sp.port} (20ms pacing)`);
  const packets = await collectOpusPackets();
  const sock = createSocket("udp4");
  console.log(`  ${packets.length} opus packets; sending paced 20ms`);
  const t0 = Date.now();
  for (let i = 0; i < packets.length; i++) {
    sock.send(packets[i], sp.port, sp.ip);
    const target = t0 + (i + 1) * 20;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }
  sock.close();
}

async function wsOpus(sp: SpeakerInfo, session: PrivateSession): Promise<void> {
  const { cookie } = await session.authHeaders();
  // The device reports speakerState.mode "listen"; try putting it in talk mode
  // first — the UI's Talk button presumably does something equivalent.
  const patch = await session.request("PATCH", `/proxy/protect/api/speakers/${sp.id}`, {
    speakerState: { mode: "talk" },
  });
  await patch.res.text().catch(() => "");
  console.log(`  PATCH mode=talk -> ${patch.res.status}`);

  const url = `wss://${config.host}/proxy/protect/ws/talkback?speaker=${sp.id}`;
  console.log(`raw Opus packets -> ${url} (20ms pacing)`);
  const ws = new WebSocket(url, { headers: { Cookie: cookie }, rejectUnauthorized: false });

  await new Promise<void>((res, rej) => {
    ws.on("open", () => {
      console.log("  websocket open");
      res();
    });
    ws.on("unexpected-response", (_req, r) => rej(new Error(`WS rejected: HTTP ${r.statusCode}`)));
    ws.on("error", rej);
  });
  ws.on("message", (d) => console.log(`  [ws message] ${String(d).slice(0, 120)}`));
  ws.on("close", (code, reason) => console.log(`  [ws closed] ${code} ${reason.toString()}`));

  const packets = await collectOpusPackets();
  console.log(`  ${packets.length} opus packets; sending paced 20ms`);
  const t0 = Date.now();
  for (let i = 0; i < packets.length; i++) {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log("  websocket no longer open — stopping");
      break;
    }
    ws.send(packets[i]);
    const target = t0 + (i + 1) * 20;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(300);
  ws.close();
}

/**
 * The device's talkbackSettings literally describe raw PCM: channels 1,
 * samplingRate 24000, bitsPerSample 16. typeFmt "opus" may describe the mic
 * direction (speaker -> NVR) rather than what the NVR accepts inbound.
 */
async function wsPcm(sp: SpeakerInfo, session: PrivateSession, rate: number, chunkMs: number): Promise<void> {
  const { cookie } = await session.authHeaders();
  const url = `wss://${config.host}/proxy/protect/ws/talkback?speaker=${sp.id}`;
  console.log(`raw PCM s16le ${rate}Hz mono -> ${url} (${chunkMs}ms chunks)`);
  const ws = new WebSocket(url, { headers: { Cookie: cookie }, rejectUnauthorized: false });

  await new Promise<void>((res, rej) => {
    ws.on("open", () => {
      console.log("  websocket open");
      res();
    });
    ws.on("unexpected-response", (_req, r) => rej(new Error(`WS rejected: HTTP ${r.statusCode}`)));
    ws.on("error", rej);
  });
  ws.on("message", (d) => {
    const b = d as Buffer;
    console.log(`  [ws message] ${b.length} bytes: ${b.subarray(0, 60).toString("utf8").replace(/[^\x20-\x7e]/g, ".")}`);
  });
  ws.on("close", (code, reason) => console.log(`  [ws closed] ${code} ${reason.toString()}`));

  const ff = runFfmpeg(["-ar", String(rate), "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]);
  const chunks: Buffer[] = [];
  const bytesPerChunk = Math.round((rate * 2 * chunkMs) / 1000);
  let buf = Buffer.alloc(0);
  ff.stdout!.on("data", (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= bytesPerChunk) {
      chunks.push(buf.subarray(0, bytesPerChunk));
      buf = buf.subarray(bytesPerChunk);
    }
  });
  await new Promise<void>((res) => ff.on("close", () => res()));
  if (buf.length > 0) chunks.push(buf);

  console.log(`  ${chunks.length} PCM chunks of ${bytesPerChunk}B; sending paced ${chunkMs}ms`);
  const t0 = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`  websocket closed early after ${i} chunks`);
      break;
    }
    ws.send(chunks[i]);
    const target = t0 + (i + 1) * chunkMs;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
  }
  await sleep(500);
  ws.close();
}

/** Opens the WS and just listens — does the server greet us or demand a handshake? */
async function wsListen(sp: SpeakerInfo, session: PrivateSession): Promise<void> {
  const { cookie } = await session.authHeaders();
  const url = `wss://${config.host}/proxy/protect/ws/talkback?speaker=${sp.id}`;
  console.log(`opening ${url} and listening for 10s without sending anything`);
  const ws = new WebSocket(url, { headers: { Cookie: cookie }, rejectUnauthorized: false });
  ws.on("open", () => console.log("  websocket open"));
  ws.on("message", (d) => {
    const b = d as Buffer;
    console.log(`  [ws message] ${b.length} bytes: ${b.subarray(0, 80).toString("utf8").replace(/[^\x20-\x7e]/g, ".")}`);
  });
  ws.on("close", (code, reason) => console.log(`  [ws closed] ${code} ${reason.toString()}`));
  ws.on("error", (e) => console.log(`  [ws error] ${e.message}`));
  await sleep(10_000);
  if (ws.readyState === WebSocket.OPEN) {
    console.log("  still open after 10s (no server-side greeting or timeout)");
    ws.close();
  }
}

/**
 * Faithful port of pueblokc/protect-soundboard's talkback.py (MIT), which is
 * the only public implementation of speaker talkback. The details that matter,
 * each verified to matter here on the UP-AI-Speaker:
 *   - 400ms sleep AFTER the socket opens, before any audio: the NVR arms the
 *     device's sink stream in that window. Skipping it garbles the opening.
 *   - Frames are sent 400ms AHEAD of realtime, pre-filling the device's jitter
 *     buffer (~0.5-0.6s; running further ahead starts dropping).
 *   - aac_low profile, 24kHz mono 48k, one ADTS frame per WS message.
 *   - Encode fully first (no -re): the socket should never wait on ffmpeg.
 */
const LEAD_MS = 400;
const ARM_MS = 400;
const TAIL_MS = 300;

function splitAdts(buf: Buffer): Buffer[] {
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

async function wsAac(sp: SpeakerInfo, session: PrivateSession): Promise<void> {
  // Encode first so the socket is never starved mid-stream.
  const ff = runFfmpeg([
    "-c:a", "aac", "-profile:a", "aac_low",
    "-ar", "24000", "-ac", "1", "-b:a", "48k",
    "-f", "adts", "pipe:1",
  ]);
  const chunks: Buffer[] = [];
  ff.stdout!.on("data", (c: Buffer) => chunks.push(c));
  await new Promise<void>((res) => ff.on("close", () => res()));
  const frames = splitAdts(Buffer.concat(chunks));

  const { cookie } = await session.authHeaders();
  const url = `wss://${config.host}/proxy/protect/ws/talkback?speaker=${sp.id}`;
  console.log(`AAC-ADTS (${frames.length} frames) -> ${url}`);
  const ws = new WebSocket(url, {
    headers: { Cookie: cookie, Origin: `https://${config.host}` },
    rejectUnauthorized: false,
  });

  await new Promise<void>((res, rej) => {
    ws.on("open", () => {
      console.log("  websocket open");
      res();
    });
    ws.on("unexpected-response", (_req, r) => rej(new Error(`WS rejected: HTTP ${r.statusCode}`)));
    ws.on("error", rej);
  });
  ws.on("close", (code, reason) => console.log(`  [ws closed] ${code} ${reason.toString()}`));

  await sleep(ARM_MS); // let the NVR arm the device's sink stream
  const frameMs = (1024 / 24000) * 1000; // 42.667ms
  const t0 = Date.now();
  for (let i = 0; i < frames.length; i++) {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`  websocket closed early after ${i}/${frames.length} frames`);
      break;
    }
    const target = t0 + i * frameMs - LEAD_MS;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    ws.send(frames[i]);
  }
  await sleep(TAIL_MS);
  ws.close();
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const MODES = ["udp-rtp-opus", "udp-opus-raw", "ws-aac", "ws-opus", "ws-pcm24", "ws-pcm48", "ws-pcm16", "ws-listen"];
  if (!mode || (!MODES.includes(mode) && !["sweep", "confirm-aac", "plan"].includes(mode))) {
    console.error(
      `Usage: npx tsx src/stream.mts <${MODES.join(" | ")} | sweep | confirm-aac> [--file path] [--seconds n] [--beeps n] [--pad-ms n]`,
    );
    process.exit(1);
  }
  const creds = requirePrivateCreds();
  const session = new PrivateSession(creds.username, creds.password);
  const sp = await getSpeaker(session);
  if (padArg > 0) setPad(padArg);

  // Generic listening test: --plan "beeps:padMs,beeps:padMs,..." with long
  // gaps, so each run is an independent session and the beep count names it.
  if (mode === "plan") {
    const planIdx = args.indexOf("--plan");
    const spec = planIdx >= 0 ? args[planIdx + 1] : "";
    const gapIdx = args.indexOf("--gap");
    const gap = gapIdx >= 0 ? Number(args[gapIdx + 1]) : 15;
    // "beeps:padMs:gapAfterSeconds" — per-step gap overrides --gap.
    const steps = spec.split(",").map((s) => {
      const [b, p, g] = s.split(":").map(Number);
      return { beeps: b, pad: p || 0, gapAfter: Number.isFinite(g) ? g : undefined };
    });
    if (steps.length === 0 || steps.some((s) => !s.beeps)) {
      console.error('Usage: plan --plan "5:0,7:700" [--gap seconds]');
      process.exit(1);
    }
    console.log(`speaker ${sp.id} — ws-aac listening test, ${gap}s between runs:\n`);
    for (const s of steps) {
      console.log(
        `  ${s.beeps} beeps${s.pad ? ` (${s.pad}ms leading silence)` : ""}` +
          (s.gapAfter !== undefined ? ` → then wait ${s.gapAfter}s` : ""),
      );
    }
    console.log("\nStarting in 5s…\n");
    await sleep(5000);
    for (const [i, s] of steps.entries()) {
      const t = new Date().toLocaleTimeString();
      console.log(`--- ${t} run ${i + 1}: ${s.beeps} beeps, pad ${s.pad}ms ---`);
      setPad(s.pad);
      setBeeps(s.beeps);
      try {
        await wsAac(sp, session);
      } catch (e) {
        console.log(`  (errored: ${(e as Error).message})`);
      }
      setPad(0);
      if (i < steps.length - 1) {
        const g = s.gapAfter ?? gap;
        console.log(`  … waiting ${g}s`);
        await sleep(g * 1000);
      }
    }
    console.log("\nDone. Which beep counts did you hear?");
    return;
  }

  // Confirmation run: ws-aac twice — bare, then primed with leading silence.
  if (mode === "confirm-aac") {
    console.log(`speaker ${sp.id}\nCONFIRM ws-aac — listen for two bursts:\n`);
    console.log("  burst A = 5 beeps, no priming silence");
    console.log("  burst B = 7 beeps, 700ms priming silence\n");
    await sleep(4000);

    console.log("--- A: ws-aac, 5 beeps, no pad ---");
    setPad(0);
    setBeeps(5);
    await wsAac(sp, session);
    await sleep(5000);

    console.log("--- B: ws-aac, 7 beeps, 700ms pad ---");
    setPad(700);
    setBeeps(7);
    await wsAac(sp, session);
    setPad(0);
    console.log("\nDid you hear 5 then 7? Was B's first beep clean?");
    return;
  }

  if (mode === "sweep") {
    // Each transport plays a different number of beeps, so whoever is
    // listening can name the winner without any API telemetry.
    const plan: [string, (s: SpeakerInfo, ss: PrivateSession) => Promise<void>][] = [
      ["udp-rtp-opus", (s) => udpRtpOpus(s)],
      ["udp-opus-raw", (s) => udpOpusRaw(s)],
      ["ws-aac", (s, ss) => wsAac(s, ss)],
      ["ws-opus", (s, ss) => wsOpus(s, ss)],
      ["ws-pcm24", (s, ss) => wsPcm(s, ss, 24000, 20)],
      ["ws-pcm48", (s, ss) => wsPcm(s, ss, 48000, 20)],
    ];
    console.log(`speaker ${sp.id} at ${sp.ip}:${sp.port}\nSWEEP — listen and count the beeps:\n`);
    for (const [i, [name]] of plan.entries()) console.log(`  ${i + 1} beep(s) = ${name}`);
    console.log("\nStarting in 5s…\n");
    await sleep(5000);
    for (const [i, [name, fn]] of plan.entries()) {
      const n = i + 1;
      console.log(`--- ${name}: ${n} beep(s) ---`);
      setBeeps(n);
      try {
        await fn(sp, session);
      } catch (e) {
        console.log(`  (errored: ${(e as Error).message})`);
      }
      await sleep(4000); // gap so counts don't run together
    }
    console.log("\nSweep done. Report the beep counts you heard.");
    return;
  }

  console.log(`speaker ${sp.id} at ${sp.ip}:${sp.port}; mode=${mode}; ~${seconds}s of tone\n`);

  const stopWatcher = startStatusWatcher();
  try {
    if (mode === "udp-rtp-opus") await udpRtpOpus(sp);
    else if (mode === "udp-opus-raw") await udpOpusRaw(sp);
    else if (mode === "ws-opus") await wsOpus(sp, session);
    else if (mode === "ws-listen") await wsListen(sp, session);
    else if (mode === "ws-pcm24") await wsPcm(sp, session, 24000, 20);
    else if (mode === "ws-pcm48") await wsPcm(sp, session, 48000, 20);
    else if (mode === "ws-pcm16") await wsPcm(sp, session, 16000, 20);
    else await wsAac(sp, session);
  } finally {
    await sleep(1500);
    const statuses = await stopWatcher();
    console.log(`\nstatus transitions observed: ${statuses.join(" -> ") || "(none)"}`);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
