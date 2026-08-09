import { describe, expect, it, vi, beforeEach } from "vitest";

// Recorded alerts stream over talkback; stub the transport seam so these
// tests exercise the alert loop's own logic.
vi.mock("@/lib/protect/talkback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protect/talkback")>()),
  streamToSpeakers: vi.fn(async () => [120]),
  streamLoopToSpeakers: vi.fn(async () => ({ cycles: 4, frames: 400, reconnects: 0, ended: "until" as const })),
}));
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { updateSystemState, getSystemState } from "@/lib/state";
import {
  _resetAlertStreamForTests,
  alertStreamSettled,
  readAlertState,
  startAlert,
  stopAlert,
  tickAlert,
  minimumRepeatSeconds,
  MIN_REPEAT_SECONDS,
} from "@/lib/alerts";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { seedUser, seedWebhookCue, seedSpeaker, insertClaimedRun } from "./helpers";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import { claimNextDueRun } from "@/lib/scheduler/claim";
import { tryClaimSpeaker } from "@/lib/speaker-lock";
import { blockedByActiveAlert } from "@/lib/alert-guard";

function fakeAdapter(): ProtectAdapter {
  return {
    metaInfo: vi.fn(),
    listSpeakers: vi.fn(),
    patchSpeaker: vi.fn(),
    testSound: vi.fn(),
    triggerWebhook: vi.fn().mockResolvedValue({ status: 204, ms: 10 }),
    speak: vi.fn().mockResolvedValue({ status: 200, ms: 50 }),
    bootstrap: vi.fn(),
  } as unknown as ProtectAdapter;
}

let userId: number;
let cueId: number;

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  updateSystemState({
    speakerBusyUntil: null,
    alertCueId: null,
    alertStartedAt: null,
    alertStartedBy: null,
    alertRepeatSeconds: null,
    alertUntil: null,
    alertLastPlayedAt: null,
    pausedUntil: null,
  });
  _resetAlertStreamForTests();
  if (!userId) userId = seedUser();
  if (!cueId) {
    cueId = seedWebhookCue("Lockdown", "alert.lockdown");
    db.update(schema.soundCues).set({ isEmergency: true }).where(eq(schema.soundCues.id, cueId)).run();
    seedSpeaker("AAA000", "Hall");
  }
});

describe("repeating emergency alerts", () => {
  it("is inactive until started, and reports who started it", () => {
    expect(readAlertState().active).toBe(false);
    startAlert({ cueId, userId, repeatSeconds: 15 });
    const s = readAlertState();
    expect(s.active).toBe(true);
    expect(s.cueName).toBe("Lockdown");
    expect(s.startedByName).toBe("Tester");
    expect(s.repeatSeconds).toBe(15);
  });

  it("plays immediately on the first tick, then waits for the interval", async () => {
    startAlert({ cueId, userId, repeatSeconds: 20 });
    const adapter = fakeAdapter();

    expect(await tickAlert(adapter)).toBe("played");
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(1);

    // A tick a moment later must not play again.
    expect(await tickAlert(adapter, Date.now() + 1000)).toBe("waiting");
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(1);

    // Once the interval has elapsed it repeats. The speaker lock is keyed to
    // real time, so release it to match the simulated jump forward.
    updateSystemState({ speakerBusyUntil: null });
    expect(await tickAlert(adapter, Date.now() + 21_000)).toBe("played");
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(2);
  });

  it("stops when told to, and stays stopped", async () => {
    startAlert({ cueId, userId });
    const adapter = fakeAdapter();
    await tickAlert(adapter);
    stopAlert(userId);

    expect(readAlertState().active).toBe(false);
    expect(await tickAlert(adapter, Date.now() + 600_000)).toBe("idle");
  });

  it("auto-stops at the time limit — a forgotten alert cannot sound all night", async () => {
    startAlert({ cueId, userId, maxMinutes: 5 });
    const adapter = fakeAdapter();
    expect(await tickAlert(adapter)).toBe("played");

    const past = Date.now() + 6 * 60_000;
    expect(await tickAlert(adapter, past)).toBe("expired");
    expect(readAlertState(past).active).toBe(false);
  });

  it("releases its cue so the sound can then be deleted", async () => {
    const doomed = seedWebhookCue("Temporary", "alert.temp");
    startAlert({ cueId: doomed, userId });

    // A foreign key stops the alert pointing at a deleted sound, which is why
    // deleting one stops the alert first. After that the row is removable.
    expect(() => db.delete(schema.soundCues).where(eq(schema.soundCues.id, doomed)).run()).toThrow();
    stopAlert(userId);
    db.delete(schema.soundCues).where(eq(schema.soundCues.id, doomed)).run();

    expect(readAlertState().active).toBe(false);
    expect(await tickAlert(fakeAdapter())).toBe("idle");
  });

  it("records every repetition as an emergency run for the audit trail", async () => {
    startAlert({ cueId, userId, repeatSeconds: 10 });
    const adapter = fakeAdapter();
    await tickAlert(adapter);
    await tickAlert(adapter, Date.now() + 11_000);

    const runs = db.select().from(schema.scheduledRuns).all();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.source === "EMERGENCY")).toBe(true);
    expect(runs.every((r) => r.requestedBy === userId)).toBe(true);
  });

  it("keeps sounding while bells are paused", async () => {
    updateSystemState({ pausedUntil: Date.now() + 3_600_000, pauseReason: "testing" });
    startAlert({ cueId, userId });
    const adapter = fakeAdapter();
    expect(await tickAlert(adapter)).toBe("played");
    expect(adapter.triggerWebhook).toHaveBeenCalled();
  });

  it("never repeats faster than the sound itself lasts", () => {
    expect(minimumRepeatSeconds({ deliveryMethod: "PROTECT_WEBHOOK" })).toBeGreaterThanOrEqual(MIN_REPEAT_SECONDS);
    // A 45s recording must not restart every 10s.
    expect(
      minimumRepeatSeconds({ deliveryMethod: "PROTECT_TALKBACK_AUDIO", estimatedDurationMs: 45_000 }),
    ).toBeGreaterThanOrEqual(46);
  });

  it("needs no session-release margin for recordings — the stream is continuous", () => {
    // Recorded alerts loop inside ONE talkback session with the repeat gap
    // rendered in-stream, so repetitions cannot collide: the floor is just the
    // sound's own length. (Under the per-session model this was duration + 9s.)
    const floor = minimumRepeatSeconds({
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      estimatedDurationMs: 20_000,
    });
    expect(floor).toBe(21);
    // Webhook and TTS repetitions are separate deliveries and keep the margin.
    expect(
      minimumRepeatSeconds({ deliveryMethod: "PROTECT_NATIVE_TTS", ttsText: "x".repeat(260) }),
    ).toBeGreaterThanOrEqual(25);
  });

  it("clamps a too-fast requested interval up to the floor", () => {
    startAlert({ cueId, userId, repeatSeconds: 1 });
    expect(getSystemState().alertRepeatSeconds).toBe(MIN_REPEAT_SECONDS);
  });
});

describe("emergencies override everything else", () => {
  it("seizes the speaker instead of failing when a bell holds it", async () => {
    // A long bell is mid-playback and holds the lock.
    tryClaimSpeaker(120_000);

    const id = insertClaimedRun({
      source: "EMERGENCY",
      cueName: "Lockdown",
      webhookId: "alert.lockdown",
    });
    const adapter = fakeAdapter();
    const outcome = await executeClaimedRun(adapter, id);

    expect(outcome.status).toBe("SUCCESS");
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it("still makes a routine cue wait its turn", async () => {
    tryClaimSpeaker(120_000);
    const id = insertClaimedRun({ source: "MANUAL", cueName: "Lunch" });
    const adapter = fakeAdapter();
    const outcome = await executeClaimedRun(adapter, id);

    expect(outcome.status).toBe("FAILED");
    expect(outcome.message).toContain("speaker busy");
    expect(adapter.triggerWebhook).not.toHaveBeenCalled();
  });

  it("stands scheduled bells down while an alert is sounding", () => {
    startAlert({ cueId, userId });
    const now = Date.now();
    const bell = db
      .insert(schema.scheduledRuns)
      .values({
        source: "SCHEDULE",
        deliveryMethod: "PROTECT_WEBHOOK",
        webhookId: "bell.period",
        cueName: "Period bell",
        scheduledAtUtc: now - 500,
        localDate: "2027-01-01",
        localTime: "08:00",
        status: "PENDING",
        createdAt: now,
      })
      .returning({ id: schema.scheduledRuns.id })
      .get();

    const decision = claimNextDueRun();
    expect(decision).toEqual({ kind: "skipped_paused", runId: bell.id });
    const row = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, bell.id)).get()!;
    expect(row.status).toBe("SKIPPED_PAUSED");
    expect(row.resultMessage).toContain("emergency alert");
  });

  it("blocks routine announcements while an alert is sounding", () => {
    startAlert({ cueId, userId });
    const blocked = blockedByActiveAlert();
    expect(blocked?.status).toBe("BLOCKED");
    expect(blocked?.message).toContain("Lockdown");
  });

  it("allows routine announcements again once the alert stops", () => {
    startAlert({ cueId, userId });
    stopAlert(userId);
    expect(blockedByActiveAlert()).toBeNull();
  });
});

describe("a recorded alert streams continuously", () => {
  function seedRecordedAlertCue(name: string, durationMs = 20_000): number {
    const now = Date.now();
    const audioId = db
      .insert(schema.audioFiles)
      .values({ name, storedName: `${name}-${now}.mp3`, sizeBytes: 1000, durationMs, createdAt: now })
      .returning({ id: schema.audioFiles.id })
      .get().id;
    return db
      .insert(schema.soundCues)
      .values({
        name: `${name} ${now}`,
        deliveryMethod: "PROTECT_TALKBACK_AUDIO",
        audioFileId: audioId,
        estimatedDurationMs: durationMs,
        ttsTone: "neutral",
        isEmergency: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.soundCues.id })
      .get().id;
  }

  async function loopMock() {
    const { streamLoopToSpeakers } = await import("@/lib/protect/talkback");
    return streamLoopToSpeakers as unknown as ReturnType<typeof vi.fn>;
  }

  it("plays as ONE looped session with the repeat gap rendered in-stream", async () => {
    const mock = await loopMock();
    mock.mockClear();
    mock.mockImplementation(async () => ({ cycles: 7, frames: 700, reconnects: 1, ended: "until" as const }));

    const rec = seedRecordedAlertCue("Siren");
    startAlert({ cueId: rec, userId, repeatSeconds: 30, maxMinutes: 5 });
    const adapter = fakeAdapter();

    expect(await tickAlert(adapter)).toBe("played");
    // While the stream lives, ticks have nothing to do.
    expect(await tickAlert(adapter, Date.now() + 60_000)).toBe("waiting");
    await alertStreamSettled();

    expect(mock).toHaveBeenCalledTimes(1);
    const opts = mock.mock.calls[0][1] as { gapSeconds?: number; until: number; files: string[] };
    // 30s start-to-start minus the 20s sound = 10s of in-stream silence.
    expect(opts.gapSeconds).toBe(10);
    expect(opts.until).toBe(readAlertState().until);

    const run = db.select().from(schema.scheduledRuns).all().at(-1)!;
    expect(run.source).toBe("EMERGENCY");
    expect(run.cueName).toMatch(/sounding continuously/);
    expect(run.status).toBe("SUCCESS");
    expect(run.resultMessage).toMatch(/sounded 7×.*1 reconnect/);
    stopAlert(userId);
  });

  it("Stop alert silences the stream within a frame", async () => {
    const mock = await loopMock();
    mock.mockClear();
    let captured: { shouldStop: () => boolean } | null = null;
    let finish!: (r: unknown) => void;
    mock.mockImplementation(
      (_ids: string[], opts: { shouldStop: () => boolean }) =>
        new Promise((resolve) => {
          captured = opts;
          finish = resolve;
        }),
    );

    const rec = seedRecordedAlertCue("Siren 2");
    startAlert({ cueId: rec, userId, maxMinutes: 5 });
    expect(await tickAlert(fakeAdapter())).toBe("played");
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 5));
    expect(captured!.shouldStop()).toBe(false);

    stopAlert(userId);
    // The frame loop checks this every ~43ms — this is what makes the button
    // actually silence the speaker instead of letting 20s of audio finish.
    expect(captured!.shouldStop()).toBe(true);

    finish({ cycles: 2, frames: 200, reconnects: 0, ended: "stopped" });
    await alertStreamSettled();
  });

  it("a failed stream does not kill the alert — the next tick starts another", async () => {
    const mock = await loopMock();
    mock.mockClear();
    mock
      .mockImplementationOnce(async () => {
        throw new Error("socket kept dying");
      })
      .mockImplementation(async () => ({ cycles: 1, frames: 100, reconnects: 0, ended: "until" as const }));

    const rec = seedRecordedAlertCue("Siren 3");
    startAlert({ cueId: rec, userId, maxMinutes: 5 });
    const adapter = fakeAdapter();

    expect(await tickAlert(adapter)).toBe("played");
    await alertStreamSettled();
    const failed = db.select().from(schema.scheduledRuns).all().at(-1)!;
    expect(failed.status).toBe("FAILED");
    // Still active: an emergency must keep trying.
    expect(readAlertState().active).toBe(true);

    expect(await tickAlert(adapter)).toBe("played");
    await alertStreamSettled();
    expect(db.select().from(schema.scheduledRuns).all().at(-1)!.status).toBe("SUCCESS");
    stopAlert(userId);
  });

  it("webhook alerts keep the per-repetition path", async () => {
    const mock = await loopMock();
    mock.mockClear();
    startAlert({ cueId, userId, repeatSeconds: 20 });
    const adapter = fakeAdapter();
    expect(await tickAlert(adapter)).toBe("played");
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(1);
    expect(mock).not.toHaveBeenCalled();
    stopAlert(userId);
  });
});
