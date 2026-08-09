/**
 * The single execution path for every kind of playback — scheduled bells,
 * manual cues, typed announcements, emergency cues. One lifecycle, one audit
 * surface, one retry policy.
 *
 * Retry policy (the no-double-bell rule): webhook POSTs are not idempotent, so
 * we retry only errors that provably occurred BEFORE the request could have
 * been transmitted. Anything ambiguous becomes DELIVERY_UNCERTAIN and is never
 * retried automatically — the UI offers a manual re-trigger instead.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { writeAudit } from "@/lib/audit";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { resolveTargetMacs } from "@/lib/zones";
import {
  COOLDOWN_MS,
  TALKBACK_RECOVERY_MS,
  acquireSpeaker,
  estimateDurationMs,
  forceClaimSpeaker,
  releaseSpeaker,
} from "@/lib/speaker-lock";
import { streamToSpeakers, TalkbackError } from "@/lib/protect/talkback";
import { coerceTone } from "@/lib/protect/tones";
import { audioPath } from "@/lib/audio";

export type RunRow = typeof schema.scheduledRuns.$inferSelect;
export type RunStatus = RunRow["status"];

export interface ExecOutcome {
  status: RunStatus;
  httpStatus?: number;
  latencyMs?: number;
  message?: string;
}

const PRE_TRANSMISSION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === "string") return e.code;
  }
  return undefined;
}

function errorDetail(err: unknown): string {
  const parts: string[] = [];
  for (let e = err as { message?: string; code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    parts.push([e.code, e.message].filter(Boolean).join(" ") || String(e));
  }
  return parts.join(" <- ").slice(0, 400) || "unknown error";
}

function isPreTransmission(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && PRE_TRANSMISSION_CODES.has(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long an emergency keeps retrying a speaker that is still sounding. */
const PREEMPT_RETRY_MS = 9000;

/**
 * Drills get longer, because a drill sound whose real length the console does
 * not know (a Protect webhook sound with no declared duration) can still be
 * playing when the closing "this is a drill" tag is due. Waiting it out is far
 * better than abandoning the drill.
 */
const DRILL_BUSY_RETRY_MS = 20_000;

/**
 * A speaker will refuse a talkback session that arrives while it is still
 * releasing the previous one, closing the socket before any audio is sent.
 * Retrying is safe because nothing was transmitted.
 */
const TALKBACK_ATTEMPTS = 3;
const TALKBACK_RETRY_MS = 2_500;

async function attemptWithRetry(
  call: () => Promise<{ status: number; ms: number; detail?: string }>,
): Promise<
  | { ok: true; status: number; ms: number; detail?: string }
  | { ok: false; uncertain: boolean; message: string }
> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await call();
      return { ok: true, status: r.status, ms: r.ms, detail: r.detail };
    } catch (err) {
      if (isPreTransmission(err) && attempt < 3) {
        await sleep(500);
        continue;
      }
      return { ok: false, uncertain: !isPreTransmission(err), message: errorDetail(err) };
    }
  }
  return { ok: false, uncertain: false, message: "unreachable" };
}

function resolveRunMacs(run: RunRow): string[] {
  if (run.targetMacs) {
    try {
      const macs = JSON.parse(run.targetMacs) as string[];
      if (Array.isArray(macs) && macs.length > 0) return macs;
    } catch {
      /* fall through */
    }
  }
  // Scheduled runs resolve their cue's zone at execution time, so speakers
  // adopted after materialization are still included.
  let zoneId: number | null | undefined;
  if (run.cueId != null) {
    const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, run.cueId)).get();
    zoneId = cue?.zoneId;
  }
  return resolveTargetMacs(zoneId);
}

async function performDelivery(adapter: ProtectAdapter, run: RunRow): Promise<ExecOutcome> {
  if (run.deliveryMethod === "PROTECT_WEBHOOK") {
    if (!run.webhookId) return { status: "FAILED", message: "cue has no webhook ID" };
    const r = await attemptWithRetry(() => adapter.triggerWebhook(run.webhookId!));
    if (!r.ok) {
      return { status: r.uncertain ? "DELIVERY_UNCERTAIN" : "FAILED", message: r.message };
    }
    if (r.status === 204) return { status: "SUCCESS", httpStatus: r.status, latencyMs: r.ms };
    return {
      status: "FAILED",
      httpStatus: r.status,
      latencyMs: r.ms,
      message:
        r.status === 404
          ? `HTTP 404 — no Alarm Manager automation has webhook ID "${run.webhookId}"`
          : `HTTP ${r.status}`,
    };
  }

  if (run.deliveryMethod === "PROTECT_TALKBACK_AUDIO") {
    // A composite run is several files spliced into one continuous stream —
    // one talkback session instead of several.
    let files: string[] | undefined;
    if (run.audioPaths) {
      try {
        const parsed = JSON.parse(run.audioPaths) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) files = parsed;
      } catch {
        /* fall back to the single path */
      }
    }
    if (!files && !run.audioPath) return { status: "FAILED", message: "cue has no audio file" };
    const macs = resolveRunMacs(run);
    const ids = speakerIdsForMacs(macs);
    if (ids.length === 0) return { status: "FAILED", message: "no target speakers known" };
    const t0 = performance.now();
    // A speaker that is still tearing down the previous talkback session drops
    // the next one before a byte goes out. That is intermittent, and provably
    // nothing played — the same test the no-double-bell rule uses — so it is
    // safe to try again rather than report a silence nobody asked for.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= TALKBACK_ATTEMPTS; attempt++) {
      try {
        const sentPerSpeaker = await streamToSpeakers(
          ids,
          files ? { files } : { file: run.audioPath! },
        );
        const total = sentPerSpeaker.reduce((a, b) => a + b, 0);
        if (total === 0) return { status: "FAILED", message: "no audio frames transmitted" };
        // Talkback is write-only: Protect acknowledges nothing, so a completed
        // transmission is the strongest claim we can honestly make.
        return {
          status: "SUCCESS",
          latencyMs: performance.now() - t0,
          message:
            `streamed ${sentPerSpeaker.join("/")} frames (no delivery confirmation available)` +
            (attempt > 1 ? ` — after ${attempt - 1} retry` : ""),
        };
      } catch (err) {
        lastErr = err;
        // Only a mid-stream failure is genuinely ambiguous. A setup failure
        // (encode, auth, connect, refused session) means nothing played.
        const transmitted = err instanceof TalkbackError ? err.transmitted : true;
        if (transmitted) return { status: "DELIVERY_UNCERTAIN", message: errorDetail(err) };
        // Only a refused session is worth another go; an encode or auth
        // failure will fail the same way every time.
        const retryable = err instanceof TalkbackError && err.retryable;
        if (!retryable) return { status: "FAILED", message: errorDetail(err) };
        if (attempt < TALKBACK_ATTEMPTS) await sleep(TALKBACK_RETRY_MS);
      }
    }
    return { status: "FAILED", message: errorDetail(lastErr) };
  }

  // PROTECT_NATIVE_TTS
  if (!run.ttsText) return { status: "FAILED", message: "cue has no TTS text" };
  const macs = resolveRunMacs(run);
  if (macs.length === 0) return { status: "FAILED", message: "no target speakers known" };
  const tone = coerceTone(run.ttsTone);
  const r = await attemptWithRetry(() => adapter.speak(run.ttsText!, macs, tone));
  if (!r.ok) {
    return { status: r.uncertain ? "DELIVERY_UNCERTAIN" : "FAILED", message: r.message };
  }
  if (r.status === 200) return { status: "SUCCESS", httpStatus: r.status, latencyMs: r.ms };
  return {
    status: "FAILED",
    httpStatus: r.status,
    latencyMs: r.ms,
    message:
      r.status === 400 && /at most 120 character|"too_big"/.test(r.detail ?? "")
        ? `The speakers can say at most 120 characters at a time — this message is ${run.ttsText.length}. Split it, or record it instead.`
        : r.status === 400
          ? `HTTP 400 — Protect rejected the request (voice "${tone}"?)${r.detail ? `: ${r.detail}` : ""}`
          : `HTTP ${r.status}${r.detail ? `: ${r.detail}` : ""}`,
  };
}

/**
 * Every file a cue plays, in order. One entry for a plain recording; the
 * ordered part list for a combined announcement; null when nothing usable.
 */
export function audioPathsForCue(cue: {
  id: number;
  deliveryMethod: string;
  audioFileId: number | null;
}): string[] | null {
  if (cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE") {
    const rows = db
      .select({ storedName: schema.audioFiles.storedName })
      .from(schema.soundCueParts)
      .innerJoin(schema.audioFiles, eq(schema.soundCueParts.audioFileId, schema.audioFiles.id))
      .where(eq(schema.soundCueParts.cueId, cue.id))
      .orderBy(asc(schema.soundCueParts.position))
      .all();
    return rows.length > 0 ? rows.map((r) => audioPath(r.storedName)) : null;
  }
  const single = audioPathForCue(cue.audioFileId);
  return single ? [single] : null;
}

export function audioPathForCue(audioFileId: number | null | undefined): string | undefined {
  if (!audioFileId) return undefined;
  const f = db
    .select({ storedName: schema.audioFiles.storedName })
    .from(schema.audioFiles)
    .where(eq(schema.audioFiles.id, audioFileId))
    .get();
  return f ? audioPath(f.storedName) : undefined;
}

/** Talkback addresses speakers by Protect id; zones store MACs. */
function speakerIdsForMacs(macs: string[]): string[] {
  if (macs.length === 0) return [];
  return db
    .select({ id: schema.speakers.id })
    .from(schema.speakers)
    .where(inArray(schema.speakers.mac, macs))
    .all()
    .map((s) => s.id);
}

function auditAction(run: RunRow): string {
  if (run.source === "EMERGENCY") return "emergency.executed";
  if (run.source === "DRILL") return "drill.step";
  if (run.source === "MANUAL") return "cue.executed";
  return "bell.executed";
}

/** Executes a run that is already CLAIMED; writes the terminal status + audit. */
export async function executeClaimedRun(adapter: ProtectAdapter, runId: number): Promise<ExecOutcome> {
  const run = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, runId)).get();
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== "CLAIMED") throw new Error(`run ${runId} is ${run.status}, expected CLAIMED`);

  db.update(schema.scheduledRuns)
    .set({ status: "EXECUTING" })
    .where(eq(schema.scheduledRuns.id, runId))
    .run();

  // One cue at a time: overlapping playback is silently dropped by the speaker
  // (talkback) or rejected with HTTP 500 (TTS). Scheduled bells wait longer
  // than manual triggers — a bell two seconds late is fine, a hung button is not.
  const playMs = estimateDurationMs({
    deliveryMethod: run.deliveryMethod,
    ttsText: run.ttsText,
    estimatedDurationMs: run.estimatedDurationMs,
  });
  // A recording holds the speaker for its own length plus the talkback
  // recovery window, so whatever comes next cannot open a session too soon and
  // lose its opening seconds.
  const durationMs =
    run.deliveryMethod === "PROTECT_TALKBACK_AUDIO"
      ? playMs + (TALKBACK_RECOVERY_MS - COOLDOWN_MS)
      : playMs;
  // Drill steps are as patient as scheduled bells: the sequence is timed, and
  // a step giving up after 4s would leave a gap mid-drill. They deliberately
  // do NOT preempt like emergencies — practice must never shove a real alert
  // off the speaker.
  const maxWaitMs = run.source === "SCHEDULE" || run.source === "DRILL" ? 15_000 : 4_000;

  // Emergencies take the speaker immediately rather than queueing behind a
  // bell or announcement. Everything else waits its turn.
  const isEmergency = run.source === "EMERGENCY";
  if (isEmergency) forceClaimSpeaker(durationMs);

  let outcome: ExecOutcome;
  if (!isEmergency && !(await acquireSpeaker(durationMs, maxWaitMs))) {
    outcome = {
      status: "FAILED",
      message: `speaker busy — another cue was still playing after ${maxWaitMs / 1000}s`,
    };
  } else {
    try {
      outcome = await performDelivery(adapter, run);
      // The device itself rejects playback while it is still sounding
      // (Protect answers 5xx). That is not something the lock can override, so
      // an emergency keeps trying for a few seconds until the speaker frees up.
      // A 5xx means nothing was played, so retrying cannot double up.
      // A 5xx means the device refused because it is still sounding — nothing
      // played, so retrying cannot double up.
      const retriesWhenBusy = isEmergency || run.source === "DRILL";
      if (retriesWhenBusy && outcome.status === "FAILED" && (outcome.httpStatus ?? 0) >= 500) {
        const deadline =
          Date.now() + (run.source === "DRILL" ? DRILL_BUSY_RETRY_MS : PREEMPT_RETRY_MS);
        while (Date.now() < deadline) {
          await sleep(1500);
          outcome = await performDelivery(adapter, run);
          if (outcome.status !== "FAILED" || (outcome.httpStatus ?? 0) < 500) break;
        }
      }
    } catch (err) {
      outcome = { status: "FAILED", message: errorDetail(err) };
    }
    // A failure means nothing is playing; free the speaker immediately.
    if (outcome.status !== "SUCCESS") releaseSpeaker();
  }

  db.update(schema.scheduledRuns)
    .set({
      status: outcome.status,
      executedAt: Date.now(),
      httpStatus: outcome.httpStatus,
      latencyMs: outcome.latencyMs === undefined ? undefined : Math.round(outcome.latencyMs * 10) / 10,
      resultMessage: outcome.message,
    })
    .where(eq(schema.scheduledRuns.id, runId))
    .run();

  writeAudit({
    userId: run.requestedBy,
    action: auditAction(run),
    targetType: "run",
    targetId: runId,
    isEmergency: run.source === "EMERGENCY",
    detail: { cue: run.cueName, method: run.deliveryMethod, status: outcome.status, message: outcome.message },
  });

  return outcome;
}

export interface ManualTrigger {
  source: "MANUAL" | "EMERGENCY";
  requestedBy: number;
  cue?: typeof schema.soundCues.$inferSelect;
  adhoc?: { ttsText: string; ttsTone: string; targetMacs: string[] };
  /** Play an uploaded file directly, without a saved cue. */
  audioFile?: { name: string; path: string; durationMs?: number | null };
  /** Re-trigger: copy the delivery snapshot of a previous run. */
  copyOf?: RunRow;
  localDate: string;
  localTime: string;
}

/**
 * Manual/emergency path — runs in the web process so a dead worker can never
 * block a human-initiated bell. Inserts the run pre-CLAIMED and executes inline.
 */
export async function triggerManualRun(adapter: ProtectAdapter, t: ManualTrigger): Promise<{ runId: number; outcome: ExecOutcome }> {
  const now = Date.now();
  const base = {
    source: t.source,
    scheduledAtUtc: now,
    localDate: t.localDate,
    localTime: t.localTime,
    status: "CLAIMED" as const,
    claimedAt: now,
    requestedBy: t.requestedBy,
    createdAt: now,
  };
  const cuePaths = t.cue ? audioPathsForCue(t.cue) : null;
  const values = t.cue
    ? {
        ...base,
        cueId: t.cue.id,
        cueName: t.cue.name,
        // A combined announcement is delivered as one spliced talkback run:
        // the row carries the flattened file list, never the cue type.
        deliveryMethod:
          t.cue.deliveryMethod === "PROTECT_TALKBACK_COMPOSITE"
            ? ("PROTECT_TALKBACK_AUDIO" as const)
            : t.cue.deliveryMethod,
        webhookId: t.cue.webhookId,
        ttsText: t.cue.ttsText,
        ttsTone: t.cue.ttsTone,
        audioPath: cuePaths?.length === 1 ? cuePaths[0] : null,
        audioPaths: cuePaths && cuePaths.length > 1 ? JSON.stringify(cuePaths) : null,
        estimatedDurationMs: t.cue.estimatedDurationMs,
      }
    : t.audioFile
      ? {
          ...base,
          cueName: t.audioFile.name,
          deliveryMethod: "PROTECT_TALKBACK_AUDIO" as const,
          audioPath: t.audioFile.path,
          estimatedDurationMs: t.audioFile.durationMs ?? null,
        }
      : t.copyOf
      ? {
          ...base,
          cueId: t.copyOf.cueId,
          cueName: `${t.copyOf.cueName ?? "run"} (re-trigger)`,
          deliveryMethod: t.copyOf.deliveryMethod,
          webhookId: t.copyOf.webhookId,
          ttsText: t.copyOf.ttsText,
          ttsTone: t.copyOf.ttsTone,
          targetMacs: t.copyOf.targetMacs,
        }
      : {
          ...base,
          cueName: "(typed announcement)",
          deliveryMethod: "PROTECT_NATIVE_TTS" as const,
          ttsText: t.adhoc!.ttsText,
          ttsTone: t.adhoc!.ttsTone,
          targetMacs: JSON.stringify(t.adhoc!.targetMacs),
        };

  const inserted = db.insert(schema.scheduledRuns).values(values).returning({ id: schema.scheduledRuns.id }).get();
  const outcome = await executeClaimedRun(adapter, inserted.id);
  return { runId: inserted.id, outcome };
}
