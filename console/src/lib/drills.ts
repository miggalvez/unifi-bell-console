/**
 * Drill sequences — practising an emergency without anyone mistaking it for one.
 *
 * A sequence is an ordered script: play a sound (optionally sounding on and on
 * for a set time, the way a real alert does), wait, play another. The cursor lives in the database
 * and is advanced by the worker, for the same reason the repeating-alert loop
 * does: a drill with a five-minute gap in it has to survive the person who
 * started it closing their laptop, and a worker restart during the silence.
 *
 * Three rules are load-bearing and deliberately not configurable:
 *
 *  1. The spoken "this is a drill" announcement brackets every sound — once
 *     before it and once after it — so no emergency sound in a drill is ever
 *     heard without the tag on both sides, however someone happens to catch
 *     it. Between two consecutive soundings the tag is shared: it closes one
 *     and opens the next, rather than being said twice over. If an
 *     announcement fails to play, the drill is abandoned. The warning is the
 *     entire point.
 *  2. A real emergency alert aborts a running drill immediately, and the
 *     remaining steps are discarded. A drill's "all clear" landing four
 *     minutes into a real lockdown is the worst outcome this system can produce.
 *  3. A step that comes due late is never fired. If the worker was restarted
 *     across a gap, the drill aborts loudly instead of playing a lockdown tone
 *     twenty minutes after it was meant to.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getSetting, getSettingNumber, getSystemState, updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";
import {
  COOLDOWN_MS,
  TALKBACK_RECOVERY_MS,
  acquireSpeaker,
  estimateDurationMs,
  releaseSpeaker,
} from "@/lib/speaker-lock";
import { TalkbackError, streamLoopToSpeakers } from "@/lib/protect/talkback";
import { executeClaimedRun, audioPathForCue, audioPathsForCue } from "@/lib/scheduler/executor";
import { isTalkback } from "@/lib/delivery";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { resolveTargetMacs } from "@/lib/zones";
import type { ProtectAdapter } from "@/lib/protect/adapter";

/** Name of the seeded announcement cue, used when no setting points elsewhere. */
export const DEFAULT_PREAMBLE_CUE_NAME = "Drill preamble";

/**
 * Breathing room after a sound before the next one. Tied to the speaker
 * cooldown rather than picked separately: the lock already refuses to hand the
 * speaker over sooner than this, so a larger number here only adds silence
 * that nothing needs.
 */
const STEP_GAP_MS = COOLDOWN_MS;

/**
 * Gap after a recording, before the next separate delivery: the speaker's
 * session-release window (measured floor 6s + margin — see SESSION_RECOVERY_MS
 * in protect/talkback.ts for the measurement notes).
 */
const TALKBACK_GAP_MS = TALKBACK_RECOVERY_MS;

/** Slack added to the estimated run time before the hard backstop trips. */
const BACKSTOP_SLACK_MS = 5 * 60_000;
const BACKSTOP_CAP_MS = 90 * 60_000;

export const MAX_WAIT_SECONDS = 3600;
export const MIN_REPEAT_FOR_SECONDS = 15;
export const MAX_REPEAT_FOR_SECONDS = 1800;

type Cue = typeof schema.soundCues.$inferSelect;

export interface EffectiveStep {
  index: number;
  kind: "PLAY" | "WAIT";
  cue?: Cue;
  waitSeconds?: number;
  repeatForSeconds?: number | null;
  label: string;
}

export interface DrillState {
  active: boolean;
  sequenceId: number | null;
  sequenceName: string | null;
  startedByName: string | null;
  startedAt: number | null;
  stepIndex: number | null;
  totalSteps: number | null;
  currentStepLabel: string | null;
  nextStepAt: number | null;
  repeatingUntil: number | null;
  until: number | null;
}

/** The cue played before every sound in a drill. */
export function preambleCue(): Cue | undefined {
  const configured = getSetting<number | null>("drillPreambleCueId", null);
  if (typeof configured === "number") {
    const byId = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, configured)).get();
    if (byId) return byId;
  }
  return db.select().from(schema.soundCues).where(eq(schema.soundCues.name, DEFAULT_PREAMBLE_CUE_NAME)).get();
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s}s`;
}

function stepLabel(step: Omit<EffectiveStep, "label" | "index">): string {
  if (step.kind === "WAIT") return `wait ${formatWait(step.waitSeconds ?? 0)}`;
  const name = step.cue?.name ?? "(missing sound)";
  if (step.repeatForSeconds) return `${name} — sounding for ${formatWait(step.repeatForSeconds)}`;
  return name;
}

/**
 * The sequence's saved steps, validated. Returns null when something the drill
 * depends on has gone missing, which is a reason to abort rather than improvise.
 * The announcement is NOT a step here — it is decided per sound at play time.
 */
export function effectiveSteps(sequenceId: number): EffectiveStep[] | null {
  if (!preambleCue()) return null;

  const rows = db
    .select()
    .from(schema.drillSteps)
    .where(eq(schema.drillSteps.sequenceId, sequenceId))
    .orderBy(asc(schema.drillSteps.position))
    .all();
  if (rows.length === 0) return null;

  const steps: EffectiveStep[] = [];
  for (const row of rows) {
    if (row.kind === "WAIT") {
      const s = { kind: "WAIT" as const, waitSeconds: row.waitSeconds ?? 0 };
      steps.push({ index: steps.length, ...s, label: stepLabel(s) });
      continue;
    }
    const cue = row.cueId
      ? db.select().from(schema.soundCues).where(eq(schema.soundCues.id, row.cueId)).get()
      : undefined;
    if (!cue || !cue.isEnabled) return null;
    const s = { kind: "PLAY" as const, cue, repeatForSeconds: row.repeatForSeconds };
    steps.push({ index: steps.length, ...s, label: stepLabel(s) });
  }
  return steps;
}

function repeats(step: EffectiveStep): boolean {
  return step.kind === "PLAY" && !!step.repeatForSeconds;
}

/**
 * How long one sounding takes: the message plus the shared drill tag that
 * follows it. Not a constraint any more — staff only choose how long the alarm
 * runs — but it lets the editor say roughly how many times they will hear it.
 */
export function cycleSecondsFor(cue: {
  deliveryMethod: string;
  ttsText?: string | null;
  estimatedDurationMs?: number | null;
}): number {
  const tag = preambleCue();
  const tagMs = (tag ? estimateDurationMs(tag) : 4000) + STEP_GAP_MS;
  return Math.max(1, Math.ceil((estimateDurationMs(cue) + STEP_GAP_MS + tagMs) / 1000));
}

/** Rough run time, for the hard backstop and to show staff what to expect. */
export function estimateSequenceMs(steps: EffectiveStep[]): number {
  const announceMs = (preambleCue() ? estimateDurationMs(preambleCue()!) : 4000) + STEP_GAP_MS;
  // Every sound costs two announcements: one each side.
  const emissionMs = (c: Cue): number => 2 * announceMs + estimateDurationMs(c) + STEP_GAP_MS;
  return steps.reduce((total, step) => {
    if (step.kind === "WAIT") return total + (step.waitSeconds ?? 0) * 1000;
    // A sounding phase runs for its set time, plus the opening tag and the
    // final closing tag either side of it.
    if (repeats(step)) return total + step.repeatForSeconds! * 1000 + 2 * announceMs;
    return total + emissionMs(step.cue!);
  }, 0);
}

export function readDrillState(now = Date.now()): DrillState {
  const s = getSystemState();
  const active = s.drillSequenceId !== null && (s.drillUntil ?? 0) > now;
  if (!active) {
    return {
      active: false,
      sequenceId: null,
      sequenceName: null,
      startedByName: null,
      startedAt: null,
      stepIndex: null,
      totalSteps: null,
      currentStepLabel: null,
      nextStepAt: null,
      repeatingUntil: null,
      until: null,
    };
  }
  const seq = db
    .select({ name: schema.drillSequences.name })
    .from(schema.drillSequences)
    .where(eq(schema.drillSequences.id, s.drillSequenceId!))
    .get();
  const starter = s.drillStartedBy
    ? db
        .select({ name: schema.users.displayName })
        .from(schema.users)
        .where(eq(schema.users.id, s.drillStartedBy))
        .get()
    : null;
  const steps = effectiveSteps(s.drillSequenceId!);
  const idx = s.drillStepIndex ?? 0;
  return {
    active: true,
    sequenceId: s.drillSequenceId,
    sequenceName: seq?.name ?? "Drill",
    startedByName: starter?.name ?? null,
    startedAt: s.drillStartedAt,
    stepIndex: idx,
    totalSteps: steps?.length ?? null,
    currentStepLabel: steps?.[idx]?.label ?? null,
    nextStepAt: s.drillNextStepAt,
    repeatingUntil: s.drillStepEndsAt,
    until: s.drillUntil,
  };
}

export interface StartDrillResult {
  ok: boolean;
  message?: string;
}

export function startDrill(opts: { sequenceId: number; userId: number }): StartDrillResult {
  const now = Date.now();
  const s = getSystemState();

  if (s.alertCueId !== null && (s.alertUntil ?? 0) > now) {
    return { ok: false, message: "An emergency alert is sounding. A drill cannot start during a real alert." };
  }
  if (s.drillSequenceId !== null && (s.drillUntil ?? 0) > now) {
    return { ok: false, message: "A drill is already running. Stop it before starting another." };
  }

  const seq = db.select().from(schema.drillSequences).where(eq(schema.drillSequences.id, opts.sequenceId)).get();
  if (!seq) return { ok: false, message: "That drill no longer exists." };
  if (!seq.isEnabled) return { ok: false, message: `"${seq.name}" is turned off.` };

  const tag = preambleCue();
  if (!tag) return { ok: false, message: "The drill announcement is missing — set one on the Drills page." };
  if (!tag.isEnabled) {
    return { ok: false, message: `The drill announcement ("${tag.name}") is turned off. Turn it on, or choose another.` };
  }

  const steps = effectiveSteps(opts.sequenceId);
  if (!steps) {
    return { ok: false, message: "This drill has no steps, or one of its sounds is missing or turned off." };
  }

  updateSystemState({
    drillSequenceId: opts.sequenceId,
    drillStartedAt: now,
    drillStartedBy: opts.userId,
    drillStepIndex: 0,
    drillNextStepAt: now,
    drillStepEndsAt: null,
    drillStepPhase: "BEFORE",
    drillUntil: now + Math.min(BACKSTOP_CAP_MS, estimateSequenceMs(steps) + BACKSTOP_SLACK_MS),
  });

  writeAudit({
    userId: opts.userId,
    action: "drill.start",
    targetType: "drill",
    targetId: opts.sequenceId,
    detail: { name: seq.name, steps: steps.length, estimatedMs: estimateSequenceMs(steps) },
  });
  return { ok: true };
}

function clearDrill(): void {
  updateSystemState({
    drillSequenceId: null,
    drillStartedAt: null,
    drillStartedBy: null,
    drillStepIndex: null,
    drillNextStepAt: null,
    drillStepEndsAt: null,
    drillStepPhase: null,
    drillUntil: null,
  });
}

export function stopDrill(userId: number | null, reason = "stopped by hand"): void {
  const s = getSystemState();
  if (s.drillSequenceId === null) return;
  const sequenceId = s.drillSequenceId;
  const stepIndex = s.drillStepIndex;
  clearDrill();
  writeAudit({
    userId,
    action: "drill.abort",
    targetType: "drill",
    targetId: sequenceId,
    detail: { reason, stoppedAtStep: stepIndex },
  });
}

function finishDrill(sequenceId: number, startedBy: number | null): void {
  clearDrill();
  writeAudit({
    userId: startedBy,
    action: "drill.finish",
    targetType: "drill",
    targetId: sequenceId,
    detail: { completed: true },
  });
}

/** Inserts and executes one DRILL run for a cue. */
async function playCue(
  adapter: ProtectAdapter,
  cue: Cue,
  now: number,
  requestedBy: number | null,
  nameSuffix?: string,
) {
  const parts = localDateTimeParts();
  const inserted = db
    .insert(schema.scheduledRuns)
    .values({
      source: "DRILL",
      cueId: cue.id,
      cueName: nameSuffix ? `${cue.name} (${nameSuffix})` : cue.name,
      deliveryMethod:
        cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE"
          ? ("PROTECT_TALKBACK_AUDIO" as const)
          : cue.deliveryMethod,
      webhookId: cue.webhookId,
      ttsText: cue.ttsText,
      ttsTone: cue.ttsTone,
      audioPath: (audioPathsForCue(cue) ?? [])[0] ?? null,
      audioPaths: (() => {
        const paths = audioPathsForCue(cue);
        return paths && paths.length > 1 ? JSON.stringify(paths) : null;
      })(),
      estimatedDurationMs: cue.estimatedDurationMs,
      scheduledAtUtc: now,
      localDate: parts.localDate,
      localTime: parts.localTime,
      status: "CLAIMED",
      claimedAt: now,
      requestedBy,
      createdAt: now,
    })
    .returning({ id: schema.scheduledRuns.id })
    .get();
  return executeClaimedRun(adapter, inserted.id);
}

/**
 * Talkback streaming is awaited to completion, so once it returns we know the
 * audio has actually finished — no estimate needed. Pull the next step back to
 * that moment instead of leaving the estimate's slack as dead air.
 *
 * Webhook and TTS cannot do this: those calls return as soon as Protect accepts
 * them and the device plays on afterwards with no completion signal, so their
 * spacing has to stay a conservative estimate.
 */
function retimeFromCompletion(cue: Cue): void {
  if (!isTalkback(cue.deliveryMethod)) return;
  const s = getSystemState();
  if (s.drillSequenceId === null) return;
  const tighter = Date.now() + TALKBACK_GAP_MS;
  if (s.drillNextStepAt !== null && tighter < s.drillNextStepAt) {
    updateSystemState({ drillNextStepAt: tighter });
  }
}

/**
 * The in-flight continuous phase stream, if any. Worker-process module state:
 * the DB owns *what* should be sounding (drillStepPhase SOUND + drillStepEndsAt),
 * this owns the live socket task. After a worker restart the DB still says
 * SOUND but this is null — that mismatch is exactly how the tick knows to
 * resume the stream for the remainder of the phase.
 */
let drillStream: Promise<void> | null = null;

/** For tests and shutdown: await the current stream task, if one is running. */
export function drillStreamSettled(): Promise<void> | null {
  return drillStream;
}

/** Test hook: forget a stream handle without touching the database. */
export function _resetDrillStreamForTests(): void {
  drillStream = null;
}

/** A repeating step whose tag and sound are both recordings streams as one loop. */
function isContinuousStep(step: EffectiveStep): boolean {
  if (!repeats(step) || !isTalkback(step.cue?.deliveryMethod)) return false;
  return isTalkback(preambleCue()?.deliveryMethod);
}

/** Runs the worker died on mid-stream: no one will ever finish them. */
function finalizeOrphanDrillRuns(): void {
  db.update(schema.scheduledRuns)
    .set({
      status: "DELIVERY_UNCERTAIN",
      executedAt: Date.now(),
      resultMessage: "the worker restarted while this stream was playing",
    })
    .where(and(eq(schema.scheduledRuns.source, "DRILL"), eq(schema.scheduledRuns.status, "EXECUTING")))
    .run();
}

function advancePastStep(idx: number, now: number): void {
  updateSystemState({
    drillStepIndex: idx + 1,
    drillStepPhase: "BEFORE",
    drillStepEndsAt: null,
    // Whatever follows opens a fresh talkback session; give the speaker its
    // release window.
    drillNextStepAt: now + TALKBACK_RECOVERY_MS,
  });
}

function speakerIdsForZone(zoneId: number | null | undefined): string[] {
  const macs = resolveTargetMacs(zoneId);
  if (macs.length === 0) return [];
  return db
    .select({ id: schema.speakers.id })
    .from(schema.speakers)
    .where(inArray(schema.speakers.mac, macs))
    .all()
    .map((sp) => sp.id);
}

/**
 * Starts the phase's continuous stream as a background task. The worker's
 * claim loop keeps running while it plays — bells still get claimed (and
 * correctly stood down), and a real alert still gets its tick, which clears
 * the drill state and thereby flips this stream's stop predicate within a
 * frame (~43ms).
 */
function startPhaseStream(
  sequenceId: number,
  step: EffectiveStep,
  endsAt: number,
  startedBy: number | null,
): void {
  const cue = step.cue!;
  const tag = preambleCue()!;
  const tagPaths = audioPathsForCue(tag);
  const soundPaths = audioPathsForCue(cue);
  if (!tagPaths || !soundPaths) {
    stopDrill(null, "a recording used by this drill is missing from disk");
    return;
  }
  const ids = speakerIdsForZone(cue.zoneId);
  const now = Date.now();
  const parts = localDateTimeParts();
  const run = db
    .insert(schema.scheduledRuns)
    .values({
      source: "DRILL",
      cueId: cue.id,
      cueName: `${cue.name} — sounding (with drill announcement)`,
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      audioPath: soundPaths[0],
      audioPaths: JSON.stringify([...tagPaths, ...soundPaths]),
      estimatedDurationMs: endsAt - now,
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

  const stillThisPhase = () => {
    const st = getSystemState();
    return st.drillSequenceId === sequenceId && st.drillStepEndsAt === endsAt;
  };
  const finishRun = (status: "SUCCESS" | "FAILED", message: string) =>
    db.update(schema.scheduledRuns)
      .set({ status, executedAt: Date.now(), resultMessage: message })
      .where(eq(schema.scheduledRuns.id, run.id))
      .run();

  drillStream = (async () => {
    if (ids.length === 0) throw new TalkbackError("no target speakers known", false);
    // Wait like a bell would; drills never preempt.
    if (!(await acquireSpeaker(endsAt - Date.now() + TALKBACK_RECOVERY_MS, 15_000))) {
      throw new TalkbackError("speaker busy — another cue was still playing after 15s", false, {
        retryable: true,
      });
    }
    const r = await streamLoopToSpeakers(ids, {
      files: [...tagPaths, ...soundPaths],
      gapSeconds: 0,
      until: endsAt,
      shouldStop: () => !stillThisPhase(),
    });
    // Rule 1 holds inside the loop too: zero completed cycles on a stream that
    // ran to its deadline means the announcement never made it out.
    if (r.cycles === 0 && r.ended === "until") {
      throw new TalkbackError("the stream ended before the announcement could play", false);
    }
    finishRun(
      "SUCCESS",
      `sounded ${r.cycles}× as one continuous stream` +
        (r.reconnects > 0 ? ` (${r.reconnects} reconnect${r.reconnects > 1 ? "s" : ""})` : "") +
        (r.ended === "stopped" ? " — stopped" : ""),
    );
    writeAudit({
      userId: startedBy,
      action: "drill.step",
      targetType: "run",
      targetId: run.id,
      detail: { cue: cue.name, cycles: r.cycles, reconnects: r.reconnects, ended: r.ended },
    });
    releaseSpeaker(TALKBACK_RECOVERY_MS);
    if (r.ended === "until" && stillThisPhase()) {
      advancePastStep(getSystemState().drillStepIndex ?? 0, Date.now());
    }
  })()
    .catch((err: unknown) => {
      finishRun("FAILED", ((err as Error).message ?? "stream failed").slice(0, 300));
      releaseSpeaker(TALKBACK_RECOVERY_MS);
      if (stillThisPhase()) {
        stopDrill(
          null,
          `the sounding stream failed (${(err as Error).message}) — drill abandoned rather than continuing untagged`,
        );
      }
    })
    .finally(() => {
      drillStream = null;
    });
}

export type DrillTick = "idle" | "played" | "announced" | "waiting" | "finished" | "aborted";

/**
 * One step of the drill, called from the worker loop alongside the alert tick.
 * Returns what it did so the worker can log it.
 */
export async function tickDrill(adapter: ProtectAdapter, now = Date.now()): Promise<DrillTick> {
  const s = getSystemState();
  if (s.drillSequenceId === null) return "idle";
  const sequenceId = s.drillSequenceId;

  // Rule 2: a real alert outranks practice, and the rest of the script dies
  // with the drill so its "all clear" can never contradict a live emergency.
  if (s.alertCueId !== null && (s.alertUntil ?? 0) > now) {
    stopDrill(null, "a real emergency alert started — remaining steps cancelled");
    return "aborted";
  }

  if ((s.drillUntil ?? 0) <= now) {
    stopDrill(null, "ran past its expected finish — abandoned as a safety backstop");
    return "aborted";
  }

  const steps = effectiveSteps(sequenceId);
  if (!steps) {
    stopDrill(null, "a sound used by this drill was changed, turned off, or removed while it was running");
    return "aborted";
  }

  let idx = s.drillStepIndex ?? 0;
  if (idx >= steps.length) {
    finishDrill(sequenceId, s.drillStartedBy);
    return "finished";
  }

  // ── A continuous sounding phase in progress ────────────────────────────
  // The DB says a stream should be playing (phase SOUND with an end time).
  // Healthy case: the background task exists and will advance the state
  // itself. After a worker restart the task is gone while the DB still says
  // SOUND — resume the stream for the remainder of the phase, or advance if
  // the phase ended while the worker was down.
  const maybeStreaming = steps[idx];
  if (
    maybeStreaming.kind === "PLAY" &&
    isContinuousStep(maybeStreaming) &&
    s.drillStepPhase === "SOUND" &&
    s.drillStepEndsAt !== null
  ) {
    if (drillStream) return "waiting";
    finalizeOrphanDrillRuns();
    if (now >= s.drillStepEndsAt) {
      advancePastStep(idx, now);
      return "waiting";
    }
    startPhaseStream(sequenceId, maybeStreaming, s.drillStepEndsAt, s.drillStartedBy);
    return "played";
  }

  const dueAt = s.drillNextStepAt ?? now;
  if (now < dueAt) return "waiting";

  // Rule 3: never fire a step long after its time. Same grace window that
  // governs missed bells.
  const graceMs = getSettingNumber("missedGraceMinutes", 2) * 60_000;
  const lateMs = now - dueAt;
  if (lateMs > graceMs) {
    stopDrill(
      null,
      `step ${idx + 1} came due ${Math.round(lateMs / 1000)}s late (grace ${Math.round(graceMs / 1000)}s) — worker restarted? Remaining steps cancelled.`,
    );
    return "aborted";
  }

  const phase = s.drillStepPhase ?? "BEFORE";
  const step = steps[idx];

  if (step.kind === "WAIT") {
    updateSystemState({
      drillStepIndex: idx + 1,
      drillNextStepAt: now + (step.waitSeconds ?? 0) * 1000,
      drillStepEndsAt: null,
      drillStepPhase: "BEFORE",
    });
    return "waiting";
  }

  const cue = step.cue!;
  const preamble = preambleCue();
  if (!preamble) {
    stopDrill(null, "the drill announcement is missing — drill abandoned");
    return "aborted";
  }
  const announceMs = estimateDurationMs(preamble) + STEP_GAP_MS;

  async function speakTag(): Promise<boolean> {
    const outcome = await playCue(adapter, preamble!, now, s.drillStartedBy, "drill announcement");
    if (outcome.status === "SUCCESS") {
      retimeFromCompletion(preamble!);
      return true;
    }
    stopDrill(
      null,
      `the drill announcement did not play (${outcome.message ?? outcome.status}) — drill abandoned rather than sounding an emergency tone without it`,
    );
    return false;
  }

  /**
   * When the announcement and the sound are both recordings, they can be
   * spliced into ONE talkback stream. That is worth doing: the speaker needs
   * ~7s to release a session, so two sessions per sounding means a long
   * silence between "this is a drill" and the sound it introduces — and a
   * chance for the second to be refused. Glued together there is no gap at
   * all, and sessions land a whole sounding apart.
   */
  const composite = isTalkback(cue.deliveryMethod) && isTalkback(preamble.deliveryMethod);

  // A repeating recorded step becomes ONE looped session for the whole phase:
  // no per-sounding sessions, so no session-release gaps between soundings at
  // all. The task advances the phase itself when the loop ends.
  if (composite && repeats(step) && phase === "BEFORE") {
    const endsAt = now + step.repeatForSeconds! * 1000;
    updateSystemState({
      drillStepEndsAt: endsAt,
      drillStepPhase: "SOUND",
      // The next scheduling decision is the phase's end; the stream needs no
      // ticks in between.
      drillNextStepAt: endsAt,
    });
    startPhaseStream(sequenceId, step, endsAt, s.drillStartedBy);
    return "played";
  }

  if (composite && phase !== "AFTER") {
    const tagPaths = audioPathsForCue(preamble);
    const soundPaths = audioPathsForCue(cue);
    if (!tagPaths || !soundPaths) {
      stopDrill(null, "a recording used by this drill is missing from disk");
      return "aborted";
    }
    const enteringRepeat = repeats(step) && s.drillStepEndsAt === null;
    const bothMs = estimateDurationMs(preamble) + estimateDurationMs(cue);
    updateSystemState({
      drillStepEndsAt: enteringRepeat ? now + step.repeatForSeconds! * 1000 : s.drillStepEndsAt,
      drillStepPhase: "AFTER",
      drillNextStepAt: now + bothMs + STEP_GAP_MS,
    });

    const parts = localDateTimeParts();
    const inserted = db
      .insert(schema.scheduledRuns)
      .values({
        source: "DRILL",
        cueId: cue.id,
        cueName: `${cue.name} (with drill announcement)`,
        deliveryMethod: "PROTECT_TALKBACK_AUDIO",
        audioPath: soundPaths[0],
        audioPaths: JSON.stringify([...tagPaths, ...soundPaths]),
        estimatedDurationMs: bothMs,
        scheduledAtUtc: now,
        localDate: parts.localDate,
        localTime: parts.localTime,
        status: "CLAIMED",
        claimedAt: now,
        requestedBy: s.drillStartedBy,
        createdAt: now,
      })
      .returning({ id: schema.scheduledRuns.id })
      .get();

    const outcome = await executeClaimedRun(adapter, inserted.id);
    // The announcement is inside this stream, so a failure means it did not
    // play — the same rule applies as for a standalone tag.
    if (outcome.status !== "SUCCESS") {
      stopDrill(
        null,
        `the drill announcement did not play (${outcome.message ?? outcome.status}) — drill abandoned rather than sounding an emergency tone without it`,
      );
      return "aborted";
    }
    retimeFromCompletion(cue);
    return "played";
  }

  // Opening tag. Also fixes when a sounding phase will stop.
  if (phase === "BEFORE") {
    const enteringRepeat = repeats(step) && s.drillStepEndsAt === null;
    updateSystemState({
      drillStepEndsAt: enteringRepeat ? now + step.repeatForSeconds! * 1000 : s.drillStepEndsAt,
      drillStepPhase: "SOUND",
      drillNextStepAt: now + announceMs,
    });
    return (await speakTag()) ? "announced" : "aborted";
  }

  // Closing tag. While a sounding phase is still running this same tag opens
  // the next sounding — saying it twice over would just be noise — so the
  // phase goes straight back to SOUND rather than through BEFORE.
  if (phase === "AFTER") {
    const stillSounding = repeats(step) && (s.drillStepEndsAt ?? 0) > now;
    // Mid-phase in composite mode there is no standalone tag to say: the next
    // spliced stream opens with it.
    if (composite && stillSounding) {
      updateSystemState({ drillStepPhase: "SOUND", drillNextStepAt: now });
      return "waiting";
    }
    updateSystemState(
      stillSounding
        ? { drillStepPhase: "SOUND", drillNextStepAt: now + announceMs }
        : {
            drillStepIndex: idx + 1,
            drillStepPhase: "BEFORE",
            drillStepEndsAt: null,
            drillNextStepAt: now + announceMs,
          },
    );
    const ok = await speakTag();
    if (!ok) return "aborted";
    if (!stillSounding && idx + 1 >= steps.length) {
      // Nothing left after the closing tag; let the next tick finish cleanly.
      return "announced";
    }
    return "announced";
  }

  // phase === "SOUND": the sound itself, now that it has been announced.
  // Scheduled from the estimate first, so a slow delivery cannot let the next
  // tick fire this step twice.
  updateSystemState({
    drillStepPhase: "AFTER",
    drillNextStepAt: now + estimateDurationMs(cue) + STEP_GAP_MS,
  });
  await playCue(adapter, cue, now, s.drillStartedBy);
  retimeFromCompletion(cue);
  return "played";
}
