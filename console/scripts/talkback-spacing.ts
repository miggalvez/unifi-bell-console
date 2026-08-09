/**
 * Measures the real minimum spacing between two talkback sessions (AUDIBLE).
 *
 * Phase 0 verified 20s and noted the true floor was untested. Drills need it
 * far tighter, so this bisects it on the actual speaker.
 *
 * Each trial plays a short IDENTIFYING burst of k beeps, waits a candidate
 * gap, then plays a 6-beep MEASUREMENT burst. Two things are recorded:
 *
 *   - refusals, detected automatically (the speaker closes the socket before
 *     any audio goes out), and
 *   - truncation, which no API reports — you count the beeps. Beeps are one
 *     per second, so "I heard 4" means the first ~2 seconds were swallowed.
 *
 * Usage: npx tsx scripts/talkback-spacing.ts
 */
import { db, schema } from "@/lib/db/client";
import { streamToSpeakers, TalkbackError } from "@/lib/protect/talkback";
import { updateSystemState } from "@/lib/state";
import { stopDrill } from "@/lib/drills";
import { stopAlert } from "@/lib/alerts";

/** Candidate gaps in seconds, widest first so early trials are the safe ones. */
const GAPS = [16, 12, 8, 6, 4, 3];
const MEASURE_BEEPS = 6;
/** Recovery between trials — comfortably above phase 0's verified 20s. */
const RECOVERY_S = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Trial {
  trial: number;
  gapS: number;
  idBeeps: number;
  refused: boolean;
  note: string;
}

async function burst(ids: string[], beeps: number): Promise<{ ok: boolean; note: string }> {
  try {
    const sent = await streamToSpeakers(ids, { beeps });
    return { ok: true, note: `${sent.join("/")} frames` };
  } catch (err) {
    const refused = err instanceof TalkbackError && !err.transmitted;
    return { ok: false, note: refused ? "REFUSED (no audio sent)" : `error: ${(err as Error).message}` };
  }
}

async function main(): Promise<void> {
  stopDrill(null, "spacing measurement");
  stopAlert(null);
  updateSystemState({ speakerBusyUntil: null });

  const ids = db.select({ id: schema.speakers.id }).from(schema.speakers).all().map((s) => s.id);
  if (ids.length === 0) {
    console.log("no speakers known — run the worker so it discovers them");
    return;
  }

  console.log(`Speakers: ${ids.length}. ${GAPS.length} trials, roughly ${Math.round(
    GAPS.reduce((a, g) => a + g + MEASURE_BEEPS + RECOVERY_S + 4, 0) / 60,
  )} minutes.\n`);
  console.log("For each trial: count the beeps in the SECOND burst (should be 6).\n");

  const results: Trial[] = [];
  for (const [i, gapS] of GAPS.entries()) {
    const idBeeps = i + 1;
    console.log(`--- trial ${idBeeps}: ${idBeeps} beep(s), wait ${gapS}s, then ${MEASURE_BEEPS} beeps`);

    const a = await burst(ids, idBeeps);
    if (!a.ok) console.log(`    identifying burst problem: ${a.note}`);
    await sleep(gapS * 1000);

    const b = await burst(ids, MEASURE_BEEPS);
    console.log(`    measurement burst: ${b.note}`);
    results.push({ trial: idBeeps, gapS, idBeeps, refused: !b.ok, note: b.note });

    if (i < GAPS.length - 1) await sleep(RECOVERY_S * 1000);
  }

  console.log("\n=== refusals (measured automatically) ===");
  for (const r of results) {
    console.log(`  ${String(r.idBeeps).padStart(2)} beep(s) → gap ${String(r.gapS).padStart(2)}s : ${r.refused ? "REFUSED" : "accepted"}  ${r.note}`);
  }
  console.log("\n=== truncation (needs your ears) ===");
  console.log("  For each trial, how many beeps did the second burst have? 6 = clean.");
  for (const r of results) console.log(`  after ${r.idBeeps} beep(s), gap ${r.gapS}s : ____ of 6`);

  updateSystemState({ speakerBusyUntil: null });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
