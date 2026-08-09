/**
 * Generates a complete starter sound pack for the school PA system.
 *
 * Why synthesize instead of downloading: bell and alert tones are simple
 * acoustics and published specifications, not creative works. Generating them
 * means no licensing questions for the school, identical loudness across every
 * cue, and exact reproducibility.
 *
 * Safety choices baked in (see docs/SOUND-PACK.md for the reasoning):
 *   - No NFPA 72 Temporal-3 fire tone. That pattern is reserved for the
 *     building's listed fire alarm; a PA imitating it can confuse a real
 *     evacuation. Fire gets a supplemental VOICE announcement only.
 *   - Emergency actions use plain-language Standard Response Protocol
 *     wording, not sirens or coded language.
 *   - Every alert voice cue has a matching "this is a drill" variant.
 *
 * Usage: npx tsx scripts/generate-sound-pack.ts [outputDir] [--spanish]
 * Requires ffmpeg. Voice lines need macOS `say` (skipped elsewhere with a note).
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { env } from "@/env";

const outDir = resolve(process.argv[2] ?? "sound-pack");
const withSpanish = process.argv.includes("--spanish");
const tmpDir = resolve(outDir, ".tmp");

const EN_VOICE = process.env.PACK_VOICE ?? "Samantha";
const ES_VOICE = process.env.PACK_VOICE_ES ?? "Paulina";

/**
 * Everything here ends up as 24kHz mono AAC through the talkback pipe and out
 * of a small ceiling speaker, so mastering for that channel matters more than
 * fidelity: nothing below ~140Hz survives (it only wastes bits and rattles the
 * cone), and clarity lives in the 2-4kHz presence band.
 */
const SPEECH_CHAIN = [
  "highpass=f=140",
  "equalizer=f=350:t=q:w=1.1:g=-2.5", // trim boxiness
  "equalizer=f=2600:t=q:w=1.4:g=5", // consonant intelligibility
  "equalizer=f=5200:t=q:w=2:g=2", // air, still under the 12kHz ceiling
  "compand=attacks=0.005:decays=0.15:points=-70/-70|-40/-22|-20/-11|-6/-5|0/-3.5",
  "alimiter=limit=0.94:level=disabled",
  "loudnorm=I=-15:TP=-1.5:LRA=9",
].join(",");

const TONE_CHAIN = [
  "highpass=f=150",
  "equalizer=f=2400:t=q:w=1.6:g=2.5",
  "alimiter=limit=0.94:level=disabled",
  "loudnorm=I=-15:TP=-1.5:LRA=9",
].join(",");

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`${bin} exited ${code}: ${err.slice(-400)}`)),
    );
  });
}

const ff = (args: string[]) => run(env.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);

// ----------------------------------------------------------------- tones

/**
 * Bells are inharmonic — that is what makes them sound like bells rather than
 * beeps. These partial ratios are Jean-Claude Risset's classic bell analysis:
 * a hum tone below the fundamental, a minor-third tierce, a quint, and a
 * nominal, each with its own amplitude and decay rate. High partials fade fast
 * and leave the hum ringing, which is exactly what the ear expects from struck
 * metal. Slight detuning between neighbouring partials creates the shimmer.
 *
 * [ratio, amplitude, decayScale] — bigger decayScale = rings longer.
 */
const BELL_PARTIALS: [number, number, number][] = [
  [0.56, 1.0, 1.0],
  [0.5625, 0.67, 0.9],
  [0.92, 1.0, 0.65],
  [0.9241, 1.8, 0.55],
  [1.19, 2.67, 0.325],
  [1.7, 1.67, 0.35],
  [2.0, 1.46, 0.25],
  [2.74, 1.33, 0.2],
  [3.0, 1.33, 0.15],
  [3.76, 0.75, 0.075],
  [4.07, 0.75, 0.06],
];

const PARTIAL_SUM = BELL_PARTIALS.reduce((a, [, amp]) => a + amp, 0);

/** One struck note at `freq`, starting at `startAt`, over a `dur`-second tail. */
function strikeExpr(freq: number, startAt: number, dur: number, ring: number): string {
  const tt = `(t-${startAt})`;
  const gate = `between(t,${startAt},${startAt + dur})`;
  const voices = BELL_PARTIALS.map(([ratio, amp, decayScale], i) => {
    const f = (freq * ratio).toFixed(3);
    // Rate is inverse to how long this partial should ring.
    const rate = (1 / (ring * decayScale)).toFixed(3);
    const gain = (amp / PARTIAL_SUM).toFixed(4);
    // Alternate phase so partials don't all peak together on the attack.
    const phase = i % 2 === 0 ? "" : "+1.5707";
    return `${gain}*sin(2*PI*${f}*${tt}${phase})*exp(-${rate}*${tt})`;
  }).join("+");
  // Strike transient: a very short, bright click that the ear reads as the
  // hammer hitting metal. Without it a bell sounds synthetic no matter how
  // good the partials are.
  const strike = `0.30*sin(2*PI*${(freq * 5.4).toFixed(2)}*${tt})*exp(-90*${tt})`;
  return `((${voices})+${strike}) * ${gate}`;
}

/**
 * A sequence of struck notes: [frequency, startSeconds][].
 * `ring` is roughly how many seconds the hum tone sustains.
 */
async function chime(
  file: string,
  notes: [number, number][],
  ring = 1.6,
  total?: number,
): Promise<void> {
  const last = notes[notes.length - 1];
  const duration = total ?? last[1] + ring * 2.2;
  const expr = notes.map(([f, at]) => strikeExpr(f, at, duration - at, ring)).join(" + ");
  await ff([
    "-f", "lavfi",
    "-i", `aevalsrc='${expr}':d=${duration.toFixed(2)}:s=48000`,
    "-af", `${TONE_CHAIN},afade=t=out:st=${(duration - 0.35).toFixed(2)}:d=0.35`,
    "-ac", "1", "-ar", "48000",
    resolve(outDir, file),
  ]);
  console.log(`  ${file}`);
}

/**
 * Alternating two-tone attention signal. Deliberately unlike the fire
 * Temporal-3 pattern (continuous alternation, not three pulses and a pause).
 */
async function twoTone(
  file: string,
  hi: number,
  lo: number,
  cycles: number,
  segment: number,
): Promise<void> {
  const duration = cycles * segment * 2;
  const period = segment * 2;
  // Each segment gets its own attack/release so the alternation sounds like a
  // signal rather than a sine hard-switching frequency (which clicks).
  const phase = `mod(t,${period})`;
  const inSeg = `mod(t,${segment})`;
  const shape = `min(1,${inSeg}/0.02)*min(1,(${segment}-${inSeg})/0.03)`;
  // A second, quieter harmonic gives the tone body over a small speaker.
  const f = `if(lt(${phase},${segment}),${hi},${lo})`;
  const expr = `0.55*(sin(2*PI*${f}*t)+0.28*sin(4*PI*${f}*t))*${shape}`;
  await ff([
    "-f", "lavfi",
    "-i", `aevalsrc='${expr}':d=${duration}:s=48000`,
    "-af", `${TONE_CHAIN},afade=t=in:st=0:d=0.02,afade=t=out:st=${duration - 0.12}:d=0.12`,
    "-ac", "1", "-ar", "48000",
    resolve(outDir, file),
  ]);
  console.log(`  ${file}`);
}

// ----------------------------------------------------------------- voice

interface Line {
  file: string;
  text: string;
  es?: string;
  /** Prefix with an attention chime so people stop and listen. */
  chimeFirst?: boolean;
}

/** 155 wpm — slower than conversation, which is what carries in a hallway. */
async function speak(text: string, voice: string, out: string): Promise<void> {
  const aiff = resolve(tmpDir, "say.aiff");
  await run("say", ["-v", voice, "-r", "155", "-o", aiff, text]);
  await ff(["-i", aiff, "-af", SPEECH_CHAIN, "-ac", "1", "-ar", "48000", out]);
}

/** Voice line, optionally preceded by the attention chime and a short gap. */
async function voiceCue(line: Line, voice: string, suffix = ""): Promise<void> {
  const target = resolve(outDir, line.file.replace(/\.wav$/, `${suffix}.wav`));
  const speech = resolve(tmpDir, "speech.wav");
  await speak(suffix === "-es" ? (line.es ?? line.text) : line.text, voice, speech);

  if (line.chimeFirst) {
    const cue = resolve(outDir, "tone-attention.wav");
    // 0.4s of lead-in silence, chime, gap, then speech.
    await ff([
      "-i", cue,
      "-i", speech,
      "-filter_complex",
      "[0]adelay=400|400[c];[1]adelay=2200|2200[s];[c][s]amix=inputs=2:normalize=0:dropout_transition=0,apad=pad_dur=0.3",
      "-ac", "1", "-ar", "48000",
      target,
    ]);
  } else {
    await ff(["-i", speech, "-af", "adelay=300|300,apad=pad_dur=0.3", "-ac", "1", "-ar", "48000", target]);
  }
  console.log(`  ${line.file.replace(/\.wav$/, `${suffix}.wav`)}`);
}

// Standard Response Protocol wording (iloveuguys.org), plus the everyday cues.
const LINES: Line[] = [
  {
    file: "voice-lockdown.wav",
    text: "Lockdown. Locks, lights, out of sight. Lockdown. Locks, lights, out of sight.",
    es: "Cierre de emergencia. Cierren, apaguen las luces, fuera de vista. Cierre de emergencia.",
  },
  {
    file: "voice-secure.wav",
    text:
      "Secure. Get inside. Lock outside doors. Students and staff, return to the building immediately and continue normal activities inside.",
    es: "Asegurar el edificio. Entren. Cierren las puertas exteriores. Continúen las actividades normales adentro.",
    chimeFirst: true,
  },
  {
    file: "voice-hold.wav",
    text: "Hold. In your classroom. Clear the halls. Remain in your room until the all clear is given.",
    es: "Permanezcan. En su salón. Despejen los pasillos hasta nuevo aviso.",
    chimeFirst: true,
  },
  {
    file: "voice-evacuate.wav",
    text: "Evacuate. Leave the building and go to the designated assembly area. Walk. Stay with your class.",
    es: "Evacuar. Salgan del edificio y diríjanse al área de reunión designada. Caminen. Permanezcan con su clase.",
    chimeFirst: true,
  },
  {
    file: "voice-shelter-tornado.wav",
    text:
      "Shelter for a tornado warning. Move to your designated shelter area now. Sit against an interior wall, away from windows, and cover your head.",
    es:
      "Refugio por aviso de tornado. Diríjanse ahora al área de refugio designada. Siéntense contra una pared interior, lejos de las ventanas, y cúbranse la cabeza.",
    chimeFirst: true,
  },
  {
    file: "voice-fire-supplemental.wav",
    text:
      "Attention. The fire alarm is sounding. Evacuate the building now using your primary route and report to your assembly area.",
    es:
      "Atención. La alarma de incendios está sonando. Evacuen el edificio ahora por su ruta principal y repórtense en su área de reunión.",
  },
  {
    file: "voice-all-clear.wav",
    text: "All clear. The emergency is over. Staff, resume normal activities and take attendance.",
    es: "Todo despejado. La emergencia ha terminado. Personal, reanuden las actividades normales y pasen lista.",
    chimeFirst: true,
  },
  {
    file: "voice-medical.wav",
    text: "Attention staff. A medical response is needed. Designated responders, please report to the main office.",
    chimeFirst: true,
  },
  {
    file: "voice-dismissal.wav",
    text: "Attention. Dismissal is beginning. Bus riders, please report to the bus loading area.",
    chimeFirst: true,
  },
  {
    file: "voice-arrival.wav",
    text: "Good morning. Please make your way to your first class. The school day is beginning.",
    chimeFirst: true,
  },
];

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  console.log(`Generating sound pack in ${outDir}\n\nTones:`);

  // Bell fundamentals are pitched low because the Risset model puts its
  // strongest partials well ABOVE the nominal frequency — a 440Hz "bell" reads
  // as roughly an octave higher to the ear.
  // A4 440, C5 523.25, D5 587.33, E5 659.25, F5 698.46, G5 783.99
  await chime("bell-class-change.wav", [[587.33, 0], [493.88, 0.6], [392.0, 1.2]], 1.8);
  await chime("bell-period-start.wav", [[392.0, 0], [493.88, 0.6], [587.33, 1.2]], 1.8);
  await chime("bell-single.wav", [[493.88, 0]], 2.0);
  await chime("bell-double.wav", [[587.33, 0], [392.0, 0.55]], 1.9);
  await chime("bell-recess.wav", [[493.88, 0], [587.33, 0.4], [493.88, 0.8], [740.0, 1.2]], 1.6);
  await chime("bell-lunch.wav", [[392.0, 0], [523.25, 0.45], [493.88, 0.9]], 1.8);
  // Westminster-ish falling figure for end of day.
  await chime(
    "bell-dismissal.wav",
    [[493.88, 0], [392.0, 0.55], [440.0, 1.1], [293.66, 1.65]],
    2.4,
    5.2,
  );
  // Short, bright, unmistakable "listen up" — used as the lead-in for voice cues.
  await twoTone("tone-attention.wav", 880, 660, 2, 0.22);
  // Severe-weather alert: continuous alternation, deliberately NOT fire's
  // three-pulse Temporal-3 pattern.
  await twoTone("tone-alert-shelter.wav", 1000, 800, 8, 0.5);

  const canSpeak = platform() === "darwin";
  if (!canSpeak) {
    console.log("\nVoice lines skipped: macOS `say` not available on this platform.");
    console.log("On Linux install piper or espeak-ng and regenerate, or record them in the console.");
  } else {
    console.log("\nVoice (English):");
    for (const line of LINES) await voiceCue(line, EN_VOICE);

    console.log("\nDrill variants:");
    for (const line of LINES.filter((l) => /lockdown|evacuate|shelter|secure|hold/.test(l.file))) {
      await voiceCue(
        {
          ...line,
          text: `This is a drill. This is a drill. ${line.text} This is a drill.`,
          es: `Esto es un simulacro. Esto es un simulacro. ${line.es ?? line.text}`,
        },
        EN_VOICE,
        "-drill",
      );
    }

    if (withSpanish) {
      console.log("\nVoice (Spanish):");
      for (const line of LINES.filter((l) => l.es)) await voiceCue(line, ES_VOICE, "-es");
    }
  }

  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nDone. Upload these on the Sounds page, or add them to Protect for webhook bells.`);
}

main().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
