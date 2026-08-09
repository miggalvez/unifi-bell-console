/**
 * A speaker can only play one thing at a time. Protect returns HTTP 500 for
 * PLAY_TEXT_ON_SPEAKER while a speaker is mid-playback, and talkback sessions
 * that overlap are silently dropped — both verified on hardware. Every
 * delivery claims this lock for its estimated duration so cues queue instead
 * of colliding.
 *
 * The lock lives in the DB because the web and worker processes both play
 * audio; `BEGIN IMMEDIATE` makes the claim atomic across them.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema, sqlite } from "@/lib/db/client";

/** Cushion after playback before the next cue may start. */
export const COOLDOWN_MS = 2000;

/**
 * Talkback needs far more than the general cushion: the speaker releases a
 * session slowly, and a new one opened too soon is either refused outright or
 * accepted with its opening seconds swallowed. The number itself lives with
 * the transport (SESSION_RECOVERY_MS in protect/talkback.ts, measured floor
 * 6s + margin); re-exported here for the lock's callers.
 *
 * It is added to the lock, not just to the drill scheduler, so repeating
 * alerts and back-to-back manual plays of recordings are protected too.
 */
export { SESSION_RECOVERY_MS as TALKBACK_RECOVERY_MS } from "@/lib/protect/talkback";
export const DEFAULT_DURATION_MS = 6000;

export function estimateDurationMs(run: {
  deliveryMethod: string;
  ttsText?: string | null;
  audioDurationMs?: number | null;
  estimatedDurationMs?: number | null;
}): number {
  if (run.estimatedDurationMs) return run.estimatedDurationMs;
  if (run.deliveryMethod === "PROTECT_TALKBACK_AUDIO" && run.audioDurationMs) {
    return run.audioDurationMs;
  }
  // Streaming takes real time; without a known length assume a long clip
  // rather than releasing the speaker mid-playback.
  if (run.deliveryMethod === "PROTECT_TALKBACK_AUDIO") return 30_000;
  if (run.deliveryMethod === "PROTECT_NATIVE_TTS" && run.ttsText) {
    // ~13 characters/second of speech, plus lead-in and trailing silence.
    return Math.round((run.ttsText.length / 13) * 1000) + 2500;
  }
  return DEFAULT_DURATION_MS;
}

/** Claims the speaker if free. Returns null on success, or ms until free. */
export function tryClaimSpeaker(durationMs: number, now = Date.now()): number | null {
  const claim = sqlite.transaction(() => {
    const state = db
      .select({ busyUntil: schema.systemState.speakerBusyUntil })
      .from(schema.systemState)
      .where(eq(schema.systemState.id, 1))
      .get();
    const busyUntil = state?.busyUntil ?? 0;
    if (busyUntil > now) return busyUntil - now;
    db.update(schema.systemState)
      .set({ speakerBusyUntil: now + durationMs + COOLDOWN_MS })
      .where(eq(schema.systemState.id, 1))
      .run();
    return null;
  });
  return claim.immediate();
}

/**
 * Seizes the speaker regardless of what holds it. Emergencies must never queue
 * behind a class bell — they take the lock and go.
 */
export function forceClaimSpeaker(durationMs: number, now = Date.now()): void {
  db.update(schema.systemState)
    .set({ speakerBusyUntil: now + durationMs + COOLDOWN_MS })
    .where(eq(schema.systemState.id, 1))
    .run();
}

/** Releases early — playback finished sooner than estimated. */
export function releaseSpeaker(atLeastMs = COOLDOWN_MS, now = Date.now()): void {
  db.update(schema.systemState)
    .set({ speakerBusyUntil: sql`min(coalesce(speaker_busy_until, 0), ${now + atLeastMs})` })
    .where(eq(schema.systemState.id, 1))
    .run();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for the speaker, up to maxWaitMs. Scheduled bells wait longer than
 * manual triggers: a bell ringing two seconds late is fine, a UI button that
 * hangs is not.
 */
export async function acquireSpeaker(durationMs: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const waitMs = tryClaimSpeaker(durationMs);
    if (waitMs === null) return true;
    if (Date.now() + Math.min(waitMs, 250) > deadline) return false;
    await sleep(Math.min(waitMs, 250));
  }
}
