/**
 * Builds bell/chime cues from real CC0 recordings instead of synthesis.
 *
 * Source: the Internet Archive "Red Library: Bells, Horns, Whistles" and
 * "SSE Library: ALARMS" collections, both published under CC0 (public domain)
 * — no attribution required, no restriction on institutional use or public
 * performance. Downloaded once into raw/, then trimmed and mastered here.
 *
 * Each cue is a hand-chosen excerpt: library recordings contain several takes
 * with dead air between them, so the offsets below pick the best single event.
 *
 * Usage: npx tsx scripts/build-bell-pack.ts [outDir] [--download]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "@/env";

const outDir = resolve(process.argv[2] ?? "sound-pack");
const rawDir = resolve(outDir, "raw");
const doDownload = process.argv.includes("--download");

const ARCHIVE_BASE = "https://archive.org/download";

/** [localName, archiveItem, fileName] */
const SOURCES: [string, string, string][] = [
  ["chimes.wav", "Red_Library_Bells_Horns_Whistles", "R04-40-Department%20Store%20Chimes.wav"],
  ["clocktower.wav", "Red_Library_Bells_Horns_Whistles", "R04-41-Clock%20Tower%20Bells.wav"],
  ["brass.wav", "Red_Library_Bells_Horns_Whistles", "R04-35-Brass%20Bell.wav"],
  ["tolls.wav", "Red_Library_Bells_Horns_Whistles", "R04-59-Short%20Bell%20Tolls.wav"],
  ["constant.wav", "Red_Library_Bells_Horns_Whistles", "R04-60-Small%20Constant%20Bell.wav"],
  ["doorbell.wav", "Red_Library_Bells_Horns_Whistles", "R09-11-Door%20Bell.wav"],
];

/**
 * Mastering for the delivery channel: a 24kHz mono AAC pipe into a small
 * ceiling speaker. Everything under ~140Hz is unreproducible and only wastes
 * bitrate; clarity sits in the 2-4kHz band.
 */
const MASTER = [
  "highpass=f=140",
  "equalizer=f=2500:t=q:w=1.6:g=2",
  "compand=attacks=0.01:decays=0.3:points=-70/-70|-30/-16|-12/-8|0/-4",
  "alimiter=limit=0.94:level=disabled",
  "loudnorm=I=-15:TP=-1.5:LRA=9",
].join(",");

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", rej);
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${bin} ${c}: ${err.slice(-300)}`))));
  });
}

const ff = (a: string[]) => run(env.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...a]);

/** A cue cut from a source recording. */
interface Cut {
  out: string;
  src: string;
  start: number;
  dur: number;
  /** Fade the tail rather than chopping a ringing bell mid-decay. */
  fadeOut?: number;
  /** Repeat the excerpt N times, `gap` seconds apart. */
  repeat?: number;
  gap?: number;
  note: string;
}

const CUTS: Cut[] = [
  {
    out: "bell-class-change.wav",
    src: "chimes.wav",
    start: 0.15,
    dur: 4.4,
    fadeOut: 0.8,
    note: "department-store chime figure — warm, unmistakable, not startling",
  },
  {
    out: "bell-period-start.wav",
    src: "chimes.wav",
    start: 8.0,
    dur: 5.2,
    fadeOut: 0.9,
    note: "second chime take, slightly different figure so it reads as distinct",
  },
  {
    out: "bell-dismissal.wav",
    src: "clocktower.wav",
    start: 0.2,
    dur: 8.0,
    fadeOut: 1.5,
    note: "clock tower bells — ceremonial end of day",
  },
  {
    out: "bell-single.wav",
    src: "brass.wav",
    start: 0.45,
    dur: 2.6,
    fadeOut: 0.8,
    note: "one brass strike",
  },
  {
    out: "bell-double.wav",
    src: "doorbell.wav",
    start: 0.05,
    dur: 3.2,
    fadeOut: 0.6,
    note: "two-tone ding-dong",
  },
  {
    out: "bell-recess.wav",
    src: "constant.wav",
    start: 0.1,
    dur: 3.0,
    fadeOut: 0.5,
    note: "classic ringing school bell — the traditional sound",
  },
  {
    out: "bell-lunch.wav",
    src: "tolls.wav",
    start: 0.2,
    dur: 4.0,
    fadeOut: 1.0,
    note: "short tolls",
  },
  {
    out: "tone-attention.wav",
    src: "doorbell.wav",
    start: 0.05,
    dur: 1.6,
    fadeOut: 0.35,
    note: "short chime used as the lead-in before spoken announcements",
  },
  {
    out: "bell-alert-repeat.wav",
    src: "constant.wav",
    start: 0.1,
    dur: 2.2,
    repeat: 3,
    gap: 0.5,
    fadeOut: 0.4,
    note: "urgent repeated ringing — gets attention without imitating a fire signal",
  },
];

async function download(): Promise<void> {
  mkdirSync(rawDir, { recursive: true });
  console.log("Downloading CC0 source recordings from the Internet Archive…");
  for (const [local, item, file] of SOURCES) {
    const target = resolve(rawDir, local);
    if (existsSync(target)) {
      console.log(`  ${local} (already present)`);
      continue;
    }
    await run("curl", ["-sL", "--max-time", "120", "-o", target, `${ARCHIVE_BASE}/${item}/${file}`]);
    console.log(`  ${local}`);
  }
}

async function cut(c: Cut): Promise<void> {
  const src = resolve(rawDir, c.src);
  if (!existsSync(src)) throw new Error(`missing source ${c.src} — run with --download first`);
  const target = resolve(outDir, c.out);
  const fade = c.fadeOut ?? 0.4;

  if (c.repeat && c.repeat > 1) {
    const gap = c.gap ?? 0.4;
    const total = c.repeat * (c.dur + gap);
    const inputs: string[] = [];
    const filters: string[] = [];
    for (let i = 0; i < c.repeat; i++) {
      inputs.push("-ss", String(c.start), "-t", String(c.dur), "-i", src);
      filters.push(`[${i}]adelay=${Math.round(i * (c.dur + gap) * 1000)}|${Math.round(i * (c.dur + gap) * 1000)}[r${i}]`);
    }
    const mix = `${filters.join(";")};${Array.from({ length: c.repeat }, (_, i) => `[r${i}]`).join("")}amix=inputs=${c.repeat}:normalize=0:dropout_transition=0,${MASTER},afade=t=out:st=${(total - fade).toFixed(2)}:d=${fade}`;
    await ff([...inputs, "-filter_complex", mix, "-ac", "1", "-ar", "48000", target]);
  } else {
    await ff([
      "-ss", String(c.start),
      "-t", String(c.dur),
      "-i", src,
      "-af", `${MASTER},afade=t=in:st=0:d=0.02,afade=t=out:st=${(c.dur - fade).toFixed(2)}:d=${fade}`,
      "-ac", "1", "-ar", "48000",
      target,
    ]);
  }
  console.log(`  ${c.out.padEnd(26)} ${c.note}`);
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  if (doDownload || !existsSync(resolve(rawDir, SOURCES[0][0]))) await download();
  console.log("\nBuilding cues from real recordings:");
  for (const c of CUTS) await cut(c);
  console.log(`\nDone — ${CUTS.length} cues in ${outDir}`);
  console.log("Sources are CC0 (public domain): no attribution required.");
}

main().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
