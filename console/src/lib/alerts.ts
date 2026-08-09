/**
 * Repeating emergency alerts (lockdown, shelter-in-place, all-clear).
 *
 * The loop is server-side state, not a browser timer: whoever starts it can
 * close their laptop, and anyone signed in on any device can stop it. Every
 * repetition is recorded in Activity so there is a full account afterwards.
 *
 * This is NOT a fire alarm. That is certified life-safety equipment with its
 * own supervision and power. This is for announcements where repetition helps.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getSettingNumber, getSystemState, updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";
import { TALKBACK_RECOVERY_MS, estimateDurationMs, forceClaimSpeaker, releaseSpeaker } from "@/lib/speaker-lock";
import { streamLoopToSpeakers } from "@/lib/protect/talkback";
import { isTalkback } from "@/lib/delivery";
import { executeClaimedRun, audioPathForCue, audioPathsForCue } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { resolveTargetMacs } from "@/lib/zones";
import { inArray } from "drizzle-orm";
import type { ProtectAdapter } from "@/lib/protect/adapter";

/** Gap between repetitions, measured from the end of the previous play. */
export const DEFAULT_REPEAT_SECONDS = 20;
export const MIN_REPEAT_SECONDS = 10;
export const MAX_REPEAT_SECONDS = 300;

/** Hard backstop so a forgotten alert cannot sound all night. */
export const DEFAULT_MAX_MINUTES = 15;

export interface AlertState {
  active: boolean;
  cueId: number | null;
  cueName: string | null;
  startedAt: number | null;
  startedByName: string | null;
  repeatSeconds: number | null;
  until: number | null;
  lastPlayedAt: number | null;
}

export function readAlertState(now = Date.now()): AlertState {
  const s = getSystemState();
  const active = s.alertCueId !== null && (s.alertUntil ?? 0) > now;
  if (!active) {
    return {
      active: false,
      cueId: null,
      cueName: null,
      startedAt: null,
      startedByName: null,
      repeatSeconds: null,
      until: null,
      lastPlayedAt: null,
    };
  }
  const cue = db
    .select({ name: schema.soundCues.name })
    .from(schema.soundCues)
    .where(eq(schema.soundCues.id, s.alertCueId!))
    .get();
  const starter = s.alertStartedBy
    ? db
        .select({ name: schema.users.displayName })
        .from(schema.users)
        .where(eq(schema.users.id, s.alertStartedBy))
        .get()
    : null;
  return {
    active: true,
    cueId: s.alertCueId,
    cueName: cue?.name ?? "Emergency alert",
    startedAt: s.alertStartedAt,
    startedByName: starter?.name ?? null,
    repeatSeconds: s.alertRepeatSeconds,
    until: s.alertUntil,
    lastPlayedAt: s.alertLastPlayedAt,
  };
}

export function startAlert(opts: {
  cueId: number;
  userId: number;
  repeatSeconds?: number;
  maxMinutes?: number;
}): void {
  const now = Date.now();
  const repeat = Math.min(
    MAX_REPEAT_SECONDS,
    Math.max(MIN_REPEAT_SECONDS, opts.repeatSeconds ?? DEFAULT_REPEAT_SECONDS),
  );
  const maxMinutes = opts.maxMinutes ?? getSettingNumber("alertMaxMinutes", DEFAULT_MAX_MINUTES);
  updateSystemState({
    alertCueId: opts.cueId,
    alertStartedAt: now,
    alertStartedBy: opts.userId,
    alertRepeatSeconds: repeat,
    alertUntil: now + maxMinutes * 60_000,
    // Null so the first repetition fires on the very next worker tick.
    alertLastPlayedAt: null,
  });
  writeAudit({
    userId: opts.userId,
    action: "alert.start",
    targetType: "cue",
    targetId: opts.cueId,
    isEmergency: true,
    detail: { repeatSeconds: repeat, maxMinutes },
  });
}

export function stopAlert(userId: number | null, reason: "manual" | "expired" = "manual"): void {
  const s = getSystemState();
  if (s.alertCueId === null) return;
  updateSystemState({
    alertCueId: null,
    alertStartedAt: null,
    alertStartedBy: null,
    alertRepeatSeconds: null,
    alertUntil: null,
    alertLastPlayedAt: null,
  });
  writeAudit({
    userId,
    action: reason === "expired" ? "alert.auto_stop" : "alert.stop",
    targetType: "cue",
    targetId: s.alertCueId,
    isEmergency: true,
    detail: { reason },
  });
}

/**
 * The in-flight continuous alert stream, if any. Same division of labour as
 * the drill stream: the DB owns whether an alert should be sounding, this
 * owns the live socket task. Null after a worker restart while the DB still
 * says active — the tick then starts a fresh stream for the remainder.
 */
let alertStream: Promise<void> | null = null;

/** For tests and shutdown: await the current stream task, if one is running. */
export function alertStreamSettled(): Promise<void> | null {
  return alertStream;
}

/** Test hook: forget a stream handle without touching the database. */
export function _resetAlertStreamForTests(): void {
  alertStream = null;
}

/**
 * A recorded alert plays as ONE looped talkback session for its whole life:
 * the configured repeat gap is rendered as silence inside the stream, so
 * there is no session-release window between repetitions (per-session floor:
 * ~7s, measured). It also makes Stop alert genuinely immediate — the loop
 * checks its stop predicate every frame, so the speaker falls silent within
 * ~50ms instead of finishing a 20-second announcement nobody wants anymore.
 */
function startAlertStream(cue: typeof schema.soundCues.$inferSelect, state: SystemState): void {
  const cueId = cue.id;
  const startedAt = state.alertStartedAt;
  const until = state.alertUntil!;
  const startedBy = state.alertStartedBy;
  const paths = audioPathsForCue(cue);
  const now = Date.now();
  if (!paths) {
    // Looping on a missing file helps nobody; stop loudly.
    stopAlert(null, "expired");
    writeAudit({
      userId: null,
      action: "alert.stream_failed",
      targetType: "cue",
      targetId: cueId,
      isEmergency: true,
      detail: { reason: "the alert recording is missing from disk" },
    });
    return;
  }

  const macs = resolveTargetMacs(cue.zoneId);
  const ids =
    macs.length === 0
      ? []
      : db
          .select({ id: schema.speakers.id })
          .from(schema.speakers)
          .where(inArray(schema.speakers.mac, macs))
          .all()
          .map((sp) => sp.id);

  const repeatMs = (state.alertRepeatSeconds ?? DEFAULT_REPEAT_SECONDS) * 1000;
  const gapSeconds = Math.max(0, Math.round((repeatMs - estimateDurationMs(cue)) / 1000));

  updateSystemState({ alertLastPlayedAt: now });
  const parts = localDateTimeParts();
  const run = db
    .insert(schema.scheduledRuns)
    .values({
      source: "EMERGENCY",
      cueId,
      cueName: `${cue.name} (sounding continuously)`,
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      audioPath: paths[0],
      audioPaths: paths.length > 1 ? JSON.stringify(paths) : null,
      estimatedDurationMs: until - now,
      scheduledAtUtc: now,
      localDate: parts.localDate,
      localTime: parts.localTime,
      status: "EXECUTING",
      claimedAt: now,
      requestedBy: startedBy,
      createdAt: now,
    })
    .returning({ id: schema.scheduledRuns.id })
    .get();

  const stillThisAlert = () => {
    const st = getSystemState();
    return st.alertCueId === cueId && st.alertStartedAt === startedAt;
  };
  const finishRun = (status: "SUCCESS" | "FAILED", message: string) =>
    db.update(schema.scheduledRuns)
      .set({ status, executedAt: Date.now(), resultMessage: message })
      .where(eq(schema.scheduledRuns.id, run.id))
      .run();

  alertStream = (async () => {
    if (ids.length === 0) throw new Error("no target speakers known");
    // An emergency seizes the speaker for its whole life; nothing queues behind it.
    forceClaimSpeaker(until - Date.now() + TALKBACK_RECOVERY_MS);
    const r = await streamLoopToSpeakers(ids, {
      files: paths,
      gapSeconds,
      until,
      shouldStop: () => !stillThisAlert(),
    });
    finishRun(
      "SUCCESS",
      `sounded ${r.cycles}× as one continuous stream` +
        (r.reconnects > 0 ? ` (${r.reconnects} reconnect${r.reconnects > 1 ? "s" : ""})` : "") +
        (r.ended === "stopped" ? " — stopped" : ""),
    );
    writeAudit({
      userId: startedBy,
      action: "emergency.executed",
      targetType: "run",
      targetId: run.id,
      isEmergency: true,
      detail: { cue: cue.name, cycles: r.cycles, reconnects: r.reconnects, ended: r.ended },
    });
    releaseSpeaker(TALKBACK_RECOVERY_MS);
  })()
    .catch((err: unknown) => {
      finishRun("FAILED", ((err as Error).message ?? "stream failed").slice(0, 300));
      releaseSpeaker(TALKBACK_RECOVERY_MS);
      // Deliberately do NOT stop the alert: an emergency must keep trying.
      // The next tick sees no live stream and starts a fresh one.
    })
    .finally(() => {
      alertStream = null;
    });
}

type SystemState = ReturnType<typeof getSystemState>;

/**
 * One tick of the alert loop. Called from the worker alongside the claim loop;
 * returns what it did so the worker can log it.
 */
export async function tickAlert(
  adapter: ProtectAdapter,
  now = Date.now(),
): Promise<"idle" | "played" | "waiting" | "expired"> {
  const s = getSystemState();
  if (s.alertCueId === null) return "idle";

  if ((s.alertUntil ?? 0) <= now) {
    stopAlert(null, "expired");
    return "expired";
    }

  const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, s.alertCueId)).get();
  if (!cue) {
    // The cue was deleted mid-alert; stop rather than loop on nothing.
    stopAlert(null, "expired");
    return "expired";
  }

  // A recorded alert streams continuously — one session, repeat gap rendered
  // in-stream — instead of one session per repetition. "waiting" here means
  // the stream task is alive and sounding.
  if (isTalkback(cue.deliveryMethod)) {
    if (alertStream) return "waiting";
    // Fresh start, or a worker restart / failed stream: finalize anything the
    // previous worker left mid-flight, then stream the remainder.
    db.update(schema.scheduledRuns)
      .set({
        status: "DELIVERY_UNCERTAIN",
        executedAt: now,
        resultMessage: "the worker restarted while this stream was playing",
      })
      .where(and(eq(schema.scheduledRuns.source, "EMERGENCY"), eq(schema.scheduledRuns.status, "EXECUTING")))
      .run();
    startAlertStream(cue, s);
    return "played";
  }

  const repeatMs = (s.alertRepeatSeconds ?? DEFAULT_REPEAT_SECONDS) * 1000;
  if (s.alertLastPlayedAt !== null && now - s.alertLastPlayedAt < repeatMs) return "waiting";

  // Claim the slot before playing so two ticks can never overlap, and so the
  // gap is measured from when this repetition started.
  updateSystemState({ alertLastPlayedAt: now });

  const parts = localDateTimeParts();
  const inserted = db
    .insert(schema.scheduledRuns)
    .values({
      source: "EMERGENCY",
      cueId: cue.id,
      cueName: cue.name,
      // Unreachable for composite cues (they stream continuously above), but
      // run rows only ever carry the flattened method.
      deliveryMethod:
        cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE"
          ? ("PROTECT_TALKBACK_AUDIO" as const)
          : cue.deliveryMethod,
      webhookId: cue.webhookId,
      ttsText: cue.ttsText,
      ttsTone: cue.ttsTone,
      audioPath: audioPathForCue(cue.audioFileId),
      estimatedDurationMs: cue.estimatedDurationMs,
      scheduledAtUtc: now,
      localDate: parts.localDate,
      localTime: parts.localTime,
      status: "CLAIMED",
      claimedAt: now,
      requestedBy: s.alertStartedBy,
      createdAt: now,
    })
    .returning({ id: schema.scheduledRuns.id })
    .get();

  await executeClaimedRun(adapter, inserted.id);
  return "played";
}

/** Repetition gap must clear the sound's own length, or plays would collide. */
export function minimumRepeatSeconds(cue: {
  deliveryMethod: string;
  ttsText?: string | null;
  estimatedDurationMs?: number | null;
}): number {
  const ms = estimateDurationMs(cue);
  // Recordings play as ONE continuous stream with the repeat gap rendered
  // inside it, so repetitions cannot collide and need no session-release
  // margin — the floor is just the sound's own length, kept so the configured
  // number stays honest. Webhook and TTS repetitions are separate deliveries
  // and still need margin to clear the speaker lock.
  const marginMs = isTalkback(cue.deliveryMethod) ? 1000 : 5000;
  return Math.max(MIN_REPEAT_SECONDS, Math.ceil((ms + marginMs) / 1000));
}
