/**
 * Measures how long a connected speaker can be left silent before the first
 * audio frame (AUDIBLE — run it when the building is empty).
 *
 * Why it matters: every speaker starts on one shared clock, which means the
 * ones that connect first wait for the slowest. That wait is capped at
 * SYNC_WAIT_MS because nobody has measured how long a talkback session
 * tolerates silence after it opens. This finds out, so the cap can be raised
 * to cover the slow connections too.
 *
 * Each trial holds every speaker silent for a candidate time, then plays
 * 6 beeps, one per second. Three things are recorded:
 *
 *   - refusals, detected automatically (the speaker closes the socket before
 *     any audio goes out),
 *   - speakers that got none or only part of a trial, named, and
 *   - truncation, which no API reports — you count the beeps. "I heard 4"
 *     means the first ~2 seconds were swallowed.
 *
 * It is a guest on the PA. It will not start while an alert, a drill or any
 * other cue has the speakers, or with a bell due before it would finish; it
 * takes the speaker lock for each trial like any other cue and lets it expire
 * on its own; and it abandons a tone the moment an alert or drill starts. It
 * never stops anything and never clears the lock.
 *
 * Usage: npx tsx scripts/talkback-hold.ts
 */
import { inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { streamToSpeakers, TalkbackError, ARM_MS, SYNC_WAIT_MS } from "@/lib/protect/talkback";
import { COOLDOWN_MS, TALKBACK_RECOVERY_MS, tryClaimSpeaker } from "@/lib/speaker-lock";
import { alertOrDrillActive, reasonPaIsNeeded } from "@/lib/pa-standdown";

/** Candidate holds in ms, shortest first so early trials are the safe ones. */
const HOLDS = [ARM_MS, 1_000, 2_000, 3_000, 5_000];
const BEEPS = 6;
/** Recovery between trials — comfortably above phase 0's verified 20s. */
const RECOVERY_S = 25;
/** Connecting and the stream's tail, on top of the hold and the beeps. */
const OVERHEAD_MS = 2_000;
/** Clear air required after the last trial before any bell is due. */
const MARGIN_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trialMs = (holdMs: number): number => holdMs + BEEPS * 1000 + OVERHEAD_MS;

/** Time still needed from trial `from` to the end, recoveries included. */
function remainingMs(from: number): number {
  const trials = HOLDS.slice(from);
  return trials.reduce((a, h) => a + trialMs(h), 0) + (trials.length - 1) * RECOVERY_S * 1000;
}

interface Trial {
  holdMs: number;
  verdict: "sent in full" | "INCOMPLETE" | "REFUSED" | "ERROR";
  note: string;
}

function speakerNames(ids: string[]): string {
  const rows = db
    .select({ id: schema.speakers.id, name: schema.speakers.name })
    .from(schema.speakers)
    .where(inArray(schema.speakers.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id) ?? id).join(", ");
}

async function main(): Promise<void> {
  const ids = db.select({ id: schema.speakers.id }).from(schema.speakers).all().map((s) => s.id);
  if (ids.length === 0) {
    console.log("no speakers known — run the worker so it discovers them");
    return;
  }

  const busy = reasonPaIsNeeded(remainingMs(0) + MARGIN_MS);
  if (busy) {
    console.log(`Not starting: ${busy}. Nothing was played or changed — try again when the PA is idle.`);
    return;
  }

  console.log(`Speakers: ${ids.length}. ${HOLDS.length} trials, roughly ${Math.round(remainingMs(0) / 60_000)} minutes.`);
  console.log(`Today's delivery holds a speaker at most ${ARM_MS + SYNC_WAIT_MS}ms.\n`);
  console.log(`For each trial: count the beeps in every room (should be ${BEEPS}).\n`);

  // An alert or drill outranks a test tone: polled a few times a second while
  // a trial is on the speakers, and the tone is dropped as soon as one is live.
  let yieldedTo: string | null = null;
  let lastCheck = 0;
  const shouldStop = (): boolean => {
    if (yieldedTo) return true;
    if (Date.now() - lastCheck < 250) return false;
    lastCheck = Date.now();
    yieldedTo = alertOrDrillActive();
    return yieldedTo !== null;
  };

  const results: Trial[] = [];
  let stoodDown: string | null = null;
  for (const [i, holdMs] of HOLDS.entries()) {
    // Re-asked before every trial: a bell may have been added, or someone may
    // be using the PA, since the last one.
    stoodDown = reasonPaIsNeeded(remainingMs(i) + MARGIN_MS);
    // The lock, taken the way every cue takes it — so a manual announcement
    // made mid-trial is told "busy" instead of colliding. It expires by itself.
    if (!stoodDown && tryClaimSpeaker(trialMs(holdMs) + (TALKBACK_RECOVERY_MS - COOLDOWN_MS)) !== null) {
      stoodDown = "the speakers are in use";
    }
    if (stoodDown) break;

    console.log(`--- trial ${i + 1}: silent for ${holdMs}ms, then ${BEEPS} beeps`);
    let trial: Trial;
    try {
      const r = await streamToSpeakers(ids, { beeps: BEEPS, armMs: holdMs, shouldStop });
      const count = `${r.sent.join("/")} of ${r.frames} frames`;
      trial =
        r.missed.length > 0
          ? {
              holdMs,
              verdict: "INCOMPLETE",
              note: `${count} — none or only part reached: ${speakerNames(r.missed.map((m) => m.speakerId))}`,
            }
          : { holdMs, verdict: "sent in full", note: count };
    } catch (err) {
      const refused = err instanceof TalkbackError && !err.transmitted;
      trial = {
        holdMs,
        verdict: refused ? "REFUSED" : "ERROR",
        note: refused ? `no audio sent — ${(err as Error).message}` : (err as Error).message,
      };
    }
    if (yieldedTo) {
      // Cut short on purpose: says nothing about the hold, so it is not a result.
      stoodDown = yieldedTo;
      break;
    }
    console.log(`    ${trial.verdict}: ${trial.note}`);
    results.push(trial);

    if (i < HOLDS.length - 1) await sleep(RECOVERY_S * 1000);
  }

  if (stoodDown) {
    console.log(`\nStopped early: ${stoodDown}. The PA comes first — rerun for the remaining holds.`);
  }
  if (results.length === 0) return;

  console.log("\n=== what was sent (measured automatically) ===");
  for (const r of results) console.log(`  hold ${String(r.holdMs).padStart(5)}ms : ${r.verdict}  ${r.note}`);
  console.log("\n=== truncation (needs your ears) ===");
  console.log(`  For each trial, how many beeps did you hear in each room? ${BEEPS} = clean.`);
  for (const r of results) {
    console.log(
      r.verdict === "sent in full"
        ? `  hold ${String(r.holdMs).padStart(5)}ms : ____ of ${BEEPS}`
        : `  hold ${String(r.holdMs).padStart(5)}ms : not clean (${r.verdict}) — do not count it`,
    );
  }
  console.log(
    `\nA hold is safe only if it was sent in full to all ${ids.length} speakers AND every room heard ${BEEPS} beeps.` +
      "\nSYNC_WAIT_MS can be at most the longest safe hold minus ARM_MS.",
  );
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
