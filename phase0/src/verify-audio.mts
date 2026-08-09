/**
 * Automated oracle for talkback experiments: listens through a Protect camera's
 * microphone and measures whether the speaker actually produced our test tone.
 *
 * Protect's own telemetry is useless here — speakerState.status stays "idle"
 * through plainly audible playback — so "did it play?" has been a human
 * question all session. This turns it into a measurement.
 *
 * All subprocess calls use spawn() with an argv array (never a shell string),
 * so no argument can be interpreted as a shell command.
 *
 * Usage:
 *   npx tsx src/verify-audio.mts cameras                 list cameras
 *   npx tsx src/verify-audio.mts listen "<camera name>"  record 8s, score it
 *   npx tsx src/verify-audio.mts sweep "<camera name>" [--runs 30] [--gap 25]
 *   npx tsx src/verify-audio.mts self-test               validate the detector offline
 */
import { spawn } from "node:child_process";
import { mkdtempSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as official from "./official.js";
import { requirePrivateCreds, resultsDir } from "./config.js";
import { PrivateSession } from "./private.js";

const TONE_HZ = 880;
const BAND_HZ = 120;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string, dflt: number): number => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runProc(bin: string, argv: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(bin, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("close", (code) => res({ code: code ?? -1, stderr }));
  });
}

/** ffmpeg volumedetect: mean/max dBFS for the given filter chain. */
async function measure(file: string, filter: string): Promise<{ mean: number; max: number }> {
  const af = filter ? `${filter},volumedetect` : "volumedetect";
  const { stderr } = await runProc("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", af, "-f", "null", "-"]);
  const mean = Number(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)?.[1] ?? "-99");
  const max = Number(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)?.[1] ?? "-99");
  return { mean, max };
}

export interface Score {
  bandMean: number;
  bandMax: number;
  fullMean: number;
  /** How far the tone band stands above the broadband level, in dB. */
  lift: number;
  detected: boolean;
}

/**
 * Detection compares band RMS against broadband RMS. Narrowing to ~120Hz keeps
 * essentially all of a tone's power but only ~1.5% of wideband noise, so with
 * noise alone the band sits roughly 18dB below broadband, while any real tone
 * pulls it back toward 0dB. Being a ratio, it is indifferent to room noise and
 * to how loud the speaker is set — only to whether OUR frequency is present.
 */
export async function scoreFile(file: string, minLiftDb = -10, minBandMaxDb = -70): Promise<Score> {
  const band = await measure(file, `bandpass=f=${TONE_HZ}:width_type=h:w=${BAND_HZ}`);
  const full = await measure(file, "");
  const lift = band.mean - full.mean;
  return {
    bandMean: band.mean,
    bandMax: band.max,
    fullMean: full.mean,
    lift,
    detected: lift >= minLiftDb && band.max >= minBandMaxDb,
  };
}

async function getCameraId(name: string): Promise<string> {
  const { body } = await official.listCameras();
  const cam = body.find((c) => (c.name ?? "").toLowerCase().includes(name.toLowerCase()));
  if (!cam) {
    console.error(`No camera matching "${name}". Available:`);
    for (const c of body) console.error(`  ${c.name}`);
    process.exit(1);
  }
  return cam.id;
}

async function rtspsUrl(cameraId: string): Promise<string> {
  const created = await official.createRtspsStream(cameraId, ["high"]);
  const url = created.high ?? Object.values(created).find(Boolean);
  if (!url) throw new Error(`no RTSPS URL returned: ${JSON.stringify(created)}`);
  return url;
}

async function record(url: string, seconds: number, out: string): Promise<void> {
  const { code, stderr } = await runProc("ffmpeg", [
    "-hide_banner", "-nostats", "-loglevel", "error",
    "-rtsp_transport", "tcp",
    "-i", url,
    "-t", String(seconds),
    "-vn", "-ac", "1", "-ar", "16000",
    "-y", out,
  ]);
  if (code !== 0) throw new Error(`ffmpeg record failed: ${stderr.slice(0, 300)}`);
}

// ------------------------------------------------------------ self-test

async function selfTest(): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), "tone-selftest-"));
  console.log("Validating the detector on synthetic audio (no hardware needed)\n");

  const cases: [string, string, boolean][] = [
    ["tone + room noise", `sine=frequency=${TONE_HZ}:duration=4,volume=0.3`, true],
    ["noise only", "anoisesrc=amplitude=0.05:duration=4", false],
    ["silence", "anullsrc=duration=4", false],
    ["wrong-frequency tone", "sine=frequency=300:duration=4,volume=0.3", false],
    ["quiet tone under noise", `sine=frequency=${TONE_HZ}:duration=4,volume=0.05`, true],
  ];

  let pass = 0;
  for (const [label, lavfi, expected] of cases) {
    const file = resolve(dir, `${label.replace(/\W+/g, "-")}.wav`);
    // Every case gets a noise floor so the lift metric is exercised honestly.
    const mix =
      label === "silence"
        ? lavfi
        : `${lavfi}[a];anoisesrc=amplitude=0.03:duration=4[n];[a][n]amix=inputs=2:duration=shortest`;
    await runProc("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", mix,
      "-ac", "1", "-ar", "16000", "-y", file,
    ]);
    const s = await scoreFile(file);
    const ok = s.detected === expected;
    if (ok) pass++;
    console.log(
      `${ok ? "✓" : "✗"} ${label.padEnd(24)} detected=${String(s.detected).padEnd(5)} ` +
        `(expected ${expected}) lift=${s.lift.toFixed(1)}dB bandMax=${s.bandMax.toFixed(1)}dB`,
    );
  }
  console.log(`\n${pass}/${cases.length} detector cases correct`);
  if (pass !== cases.length) process.exit(1);
}

// ------------------------------------------------------------ commands

async function main(): Promise<void> {
  if (cmd === "self-test") return selfTest();

  if (cmd === "cameras") {
    const { body } = await official.listCameras();
    for (const c of body) console.log(`  ${c.name}  (${c.state}, mic=${c.isMicEnabled})`);
    return;
  }

  const cameraName = args[1];
  if (!cameraName) {
    console.error('Usage: verify-audio.mts <cameras | listen | sweep | self-test> "<camera name>"');
    process.exit(1);
  }
  const cameraId = await getCameraId(cameraName);
  const url = await rtspsUrl(cameraId);
  const dir = mkdtempSync(resolve(tmpdir(), "tone-"));
  console.log(`camera "${cameraName}" -> ${cameraId}\nrecordings in ${dir}\n`);

  if (cmd === "listen") {
    const out = resolve(dir, "listen.wav");
    console.log("recording 8s — play something now…");
    await record(url, 8, out);
    const s = await scoreFile(out);
    console.log(
      `band ${TONE_HZ}Hz max ${s.bandMax.toFixed(1)}dB, broadband mean ${s.fullMean.toFixed(1)}dB, ` +
        `lift ${s.lift.toFixed(1)}dB -> ${s.detected ? "TONE DETECTED" : "no tone"}`,
    );
    return;
  }

  if (cmd === "sweep") {
    const runs = flag("--runs", 30);
    const gap = flag("--gap", 25);
    const beeps = flag("--beeps", 3);
    const creds = requirePrivateCreds();
    const session = new PrivateSession(creds.username, creds.password);
    const { streamToSpeaker } = await import("./talkback.js");

    mkdirSync(resultsDir, { recursive: true });
    const log = resolve(resultsDir, "talkback-reliability.jsonl");
    const results: (Score & { run: number; ok: boolean })[] = [];

    console.log(`${runs} runs, ${gap}s apart, each scored through "${cameraName}"\n`);
    for (let i = 1; i <= runs; i++) {
      const out = resolve(dir, `run-${String(i).padStart(2, "0")}.wav`);
      // Record a window that opens before playback and outlasts it.
      const recorder = record(url, beeps + 6, out);
      await sleep(1500);
      let sent = 0;
      try {
        sent = await streamToSpeaker(session, { beeps });
      } catch (e) {
        console.log(`  run ${i}: stream error ${(e as Error).message}`);
      }
      await recorder;
      const s = await scoreFile(out);
      results.push({ ...s, run: i, ok: s.detected });
      appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), run: i, frames: sent, ...s }) + "\n");
      console.log(
        `run ${String(i).padStart(2)}/${runs}  ${s.detected ? "HEARD " : "SILENT"}  ` +
          `lift ${s.lift.toFixed(1).padStart(5)}dB  bandMax ${s.bandMax.toFixed(1).padStart(6)}dB  frames ${sent}`,
      );
      if (i < runs) await sleep(gap * 1000);
    }

    const heard = results.filter((r) => r.ok).length;
    const lifts = results.filter((r) => r.ok).map((r) => r.lift).sort((a, b) => a - b);
    console.log(
      `\n${heard}/${runs} runs audible (${((heard / runs) * 100).toFixed(0)}%)` +
        (lifts.length
          ? `; lift min ${lifts[0].toFixed(1)} / median ${lifts[Math.floor(lifts.length / 2)].toFixed(1)} / max ${lifts[lifts.length - 1].toFixed(1)} dB`
          : ""),
    );
    console.log(`per-run detail: ${log}`);
    if (heard < runs) {
      console.log(`silent runs: ${results.filter((r) => !r.ok).map((r) => r.run).join(", ")}`);
    }
    return;
  }

  console.error(`unknown command "${cmd}"`);
  process.exit(1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
