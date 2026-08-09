import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { updateSystemState, setSetting } from "@/lib/state";
import { startAlert } from "@/lib/alerts";
import {
  DEFAULT_PREAMBLE_CUE_NAME,
  _resetDrillStreamForTests,
  drillStreamSettled,
  effectiveSteps,
  preambleCue,
  estimateSequenceMs,
  readDrillState,
  startDrill,
  stopDrill,
  tickDrill,
} from "@/lib/drills";
import { estimateDurationMs } from "@/lib/speaker-lock";
import { cycleSecondsFor } from "@/lib/drills";
import { createDrill, setDrillAnnouncement } from "@/app/(console)/drills/actions";
import { createCue } from "@/app/(console)/sounds/actions";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { claimNextDueRun } from "@/lib/scheduler/claim";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { seedUser, seedWebhookCue, seedSpeaker } from "./helpers";

// Server actions run inside a Next request scope in production. Stub the two
// seams that need one — auth and cache revalidation — so the action's own
// validation is what these tests exercise.
vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: userId, role: "ADMIN", displayName: "Tester" }),
  requireUser: async () => ({ id: userId, role: "ADMIN", displayName: "Tester" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// An uploaded announcement is delivered over talkback, which shells out to
// ffmpeg. Stub that one seam so the drill logic itself is what is under test.
vi.mock("@/lib/protect/talkback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protect/talkback")>()),
  streamToSpeakers: vi.fn(async () => [120]),
  streamLoopToSpeakers: vi.fn(async () => ({ cycles: 5, frames: 500, reconnects: 0, ended: "until" as const })),
}));

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
let preambleId: number;
let lockdownId: number;
let allClearId: number;
let alertCueId: number;

type Step = { kind: "PLAY" | "WAIT"; cueId?: number; waitSeconds?: number; repeatForSeconds?: number };

let seqCounter = 0;
function seedSequence(steps: Step[], name = `Drill ${++seqCounter}`): number {
  const now = Date.now();
  const id = db
    .insert(schema.drillSequences)
    .values({ name, createdBy: userId, createdAt: now, updatedAt: now })
    .returning({ id: schema.drillSequences.id })
    .get().id;
  steps.forEach((s, i) =>
    db
      .insert(schema.drillSteps)
      .values({
        sequenceId: id,
        position: i,
        kind: s.kind,
        cueId: s.cueId ?? null,
        waitSeconds: s.waitSeconds ?? null,
        repeatForSeconds: s.repeatForSeconds ?? null,
        createdAt: now,
      })
      .run(),
  );
  return id;
}

/** A cue backed by an uploaded recording, delivered over talkback. */
function seedRecordedCue(name: string): number {
  const now = Date.now();
  const audioId = db
    .insert(schema.audioFiles)
    .values({ name, storedName: `${name}.mp3`, sizeBytes: 1000, durationMs: 2000, createdAt: now })
    .returning({ id: schema.audioFiles.id })
    .get().id;
  return db
    .insert(schema.soundCues)
    .values({
      name: `${name} ${now}`,
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      audioFileId: audioId,
      estimatedDurationMs: 2000,
      ttsTone: "neutral",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.soundCues.id })
    .get().id;
}

/** The lockdown → 5 min → all-clear script from the feature request. */
function classicSequence(): number {
  return seedSequence([
    { kind: "PLAY", cueId: lockdownId },
    { kind: "WAIT", waitSeconds: 300 },
    { kind: "PLAY", cueId: allClearId },
  ]);
}

/** Advances past whatever the tick just scheduled, then ticks again. */
async function nextTick(adapter: ProtectAdapter, jumpMs = 10_000): Promise<string> {
  updateSystemState({ speakerBusyUntil: null });
  const at = (readDrillState().nextStepAt ?? Date.now()) + 50;
  return tickDrill(adapter, Math.max(at, Date.now()) + (jumpMs < 0 ? jumpMs : 0));
}

const runNames = () =>
  db
    .select({ name: schema.scheduledRuns.cueName })
    .from(schema.scheduledRuns)
    .all()
    .map((r) => r.name ?? "");

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
    drillSequenceId: null,
    drillStartedAt: null,
    drillStartedBy: null,
    drillStepIndex: null,
    drillNextStepAt: null,
    drillStepEndsAt: null,
    drillStepPhase: null,
    drillUntil: null,
    pausedUntil: null,
  });
  if (!userId) {
    userId = seedUser();
    seedSpeaker("AAA000", "Hall");
    // Migrations seed the real announcement cue; look it up rather than
    // inventing one, so the tests exercise what ships.
    preambleId =
      db
        .select({ id: schema.soundCues.id })
        .from(schema.soundCues)
        .where(eq(schema.soundCues.name, DEFAULT_PREAMBLE_CUE_NAME))
        .get()?.id ?? 0;
    lockdownId = seedWebhookCue("Lockdown tone", "alert.lockdown");
    allClearId = seedWebhookCue("All clear", "alert.allclear");
    alertCueId = seedWebhookCue("Real lockdown", "alert.real");
    db.update(schema.soundCues).set({ isEmergency: true }).where(eq(schema.soundCues.id, alertCueId)).run();
  }
  setSetting("missedGraceMinutes", 2);
  _resetDrillStreamForTests();
});

describe("drill sequences", () => {
  it("seeds the mandatory drill announcement through the migrations", () => {
    expect(preambleId).toBeGreaterThan(0);
    const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, preambleId)).get()!;
    expect(cue.ttsText).toBe("This is a drill.");
  });

  it("walks the whole script, tagging each sound on both sides", async () => {
    const sequenceId = classicSequence();
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();

    expect(await tickDrill(adapter)).toBe("announced"); // tag before
    expect(await nextTick(adapter)).toBe("played"); // the lockdown tone
    expect(await nextTick(adapter)).toBe("announced"); // tag after
    expect(await nextTick(adapter)).toBe("waiting"); // the 5-minute pause starts

    // Nothing goes out during the pause.
    const during = runNames().length;
    updateSystemState({ speakerBusyUntil: null });
    expect(await tickDrill(adapter, Date.now() + 60_000)).toBe("waiting");
    expect(runNames().length).toBe(during);

    // The all-clear is bracketed too, like every other sound.
    expect(await nextTick(adapter)).toBe("announced");
    expect(await nextTick(adapter)).toBe("played");
    expect(await nextTick(adapter)).toBe("announced");
    expect(await nextTick(adapter)).toBe("finished");
    expect(readDrillState().active).toBe(false);

    const tag = "Drill preamble (drill announcement)";
    expect(runNames()).toEqual([tag, "Lockdown tone", tag, tag, "All clear", tag]);
  });

  it("puts the tag on both sides of every sound", async () => {
    const sequenceId = classicSequence();
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    for (let i = 0; i < 12 && readDrillState().active; i++) await nextTick(adapter);

    const names = runNames();
    const isTag = (n?: string) => /drill announcement/i.test(n ?? "");
    // No sound is ever heard without the tag immediately before AND after it.
    names.forEach((n, i) => {
      if (!isTag(n)) {
        expect(isTag(names[i - 1])).toBe(true);
        expect(isTag(names[i + 1])).toBe(true);
      }
    });
    expect(names.filter(isTag)).toHaveLength(4); // two sounds, two tags each
  });

  it("records every step as a DRILL run, never as an emergency", async () => {
    const sequenceId = classicSequence();
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);
    await nextTick(adapter);

    const runs = db.select().from(schema.scheduledRuns).all();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.source === "DRILL")).toBe(true);
    expect(runs.some((r) => r.source === "EMERGENCY")).toBe(false);
  });

  it("refuses to start while a real emergency alert is sounding", () => {
    startAlert({ cueId: alertCueId, userId });
    const r = startDrill({ sequenceId: classicSequence(), userId });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/emergency alert/i);
    expect(readDrillState().active).toBe(false);
  });

  it("refuses to start a second drill on top of a running one", () => {
    const sequenceId = classicSequence();
    expect(startDrill({ sequenceId, userId }).ok).toBe(true);
    const second = startDrill({ sequenceId, userId });
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already running/i);
  });

  it("gives the backstop room for a five-minute pause", () => {
    const sequenceId = classicSequence();
    expect(estimateSequenceMs(effectiveSteps(sequenceId)!)).toBeGreaterThan(300_000);
    startDrill({ sequenceId, userId });
    expect(readDrillState().until! - Date.now()).toBeGreaterThan(300_000);
  });
});

describe("a sound can repeat, the way a real alert does", () => {
  it("keeps re-playing the tone for the configured length, then moves on", async () => {
    const sequenceId = seedSequence([
      { kind: "PLAY", cueId: lockdownId, repeatForSeconds: 150 },
      { kind: "PLAY", cueId: allClearId },
    ]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();

    expect(await tickDrill(adapter)).toBe("announced");
    expect(await nextTick(adapter)).toBe("played");
    expect(await nextTick(adapter)).toBe("announced");

    // Still on the same step, repeating.
    expect(readDrillState().stepIndex).toBe(0);
    expect(readDrillState().repeatingUntil).toBeGreaterThan(Date.now());

    let lockdowns = 1;
    for (let i = 0; i < 30 && readDrillState().stepIndex === 0; i++) {
      const before = runNames().filter((n) => n === "Lockdown tone").length;
      await nextTick(adapter);
      lockdowns = runNames().filter((n) => n === "Lockdown tone").length;
      expect(lockdowns).toBeGreaterThanOrEqual(before);
    }

    // ~120s at every 20s, so several repeats — not one, and not endless.
    expect(lockdowns).toBeGreaterThan(2);
    expect(lockdowns).toBeLessThan(15);
    expect(readDrillState().stepIndex).toBeGreaterThan(0);
  });

  it("shares one tag between consecutive soundings rather than saying it twice", async () => {
    const sequenceId = seedSequence([
      { kind: "PLAY", cueId: lockdownId, repeatForSeconds: 150 },
    ]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    for (let i = 0; i < 40 && readDrillState().active; i++) await nextTick(adapter);

    const names = runNames();
    const isTag = (n?: string) => /drill announcement/i.test(n ?? "");
    const tones = names.filter((n) => !isTag(n)).length;
    expect(tones).toBeGreaterThan(2);
    // N soundings need N+1 tags, not 2N: the tag between two of them closes
    // the first and opens the second.
    expect(names.filter(isTag).length).toBe(tones + 1);
    names.forEach((n, i) => {
      if (!isTag(n)) {
        expect(isTag(names[i - 1])).toBe(true);
        expect(isTag(names[i + 1])).toBe(true);
      }
    });
  });

  it("plays once when no repeat is configured", async () => {
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: lockdownId }]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    for (let i = 0; i < 6 && readDrillState().active; i++) await nextTick(adapter);
    expect(runNames().filter((n) => n === "Lockdown tone")).toHaveLength(1);
  });

  it("reports the sounding time in the step label, so staff can see it", () => {
    const sequenceId = seedSequence([
      { kind: "PLAY", cueId: lockdownId, repeatForSeconds: 120 },
    ]);
    expect(effectiveSteps(sequenceId)![0].label).toBe("Lockdown tone — sounding for 2 min");
  });

});

describe("a drill never outranks a real emergency", () => {
  it("aborts mid-sequence the moment a real alert starts, cancelling the all-clear", async () => {
    const sequenceId = classicSequence();
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);
    await nextTick(adapter);
    const before = runNames().length;

    startAlert({ cueId: alertCueId, userId });
    expect(await nextTick(adapter)).toBe("aborted");

    expect(readDrillState().active).toBe(false);
    updateSystemState({ speakerBusyUntil: null });
    expect(await tickDrill(adapter, Date.now() + 400_000)).toBe("idle");
    expect(runNames().length).toBe(before);
    expect(runNames()).not.toContain("All clear");

    const abort = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all().at(-1)!;
    expect(abort.detail).toMatch(/real emergency alert/i);
  });

  it("blocks routine announcements while a drill runs, naming the drill", () => {
    startDrill({ sequenceId: seedSequence([{ kind: "PLAY", cueId: lockdownId }], "Named drill"), userId });
    const blocked = blockedByActiveAlert();
    expect(blocked?.status).toBe("BLOCKED");
    expect(blocked?.message).toMatch(/Named drill/);
  });

  it("stands scheduled bells down during a drill", () => {
    startDrill({ sequenceId: classicSequence(), userId });
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

    expect(claimNextDueRun()).toEqual({ kind: "skipped_paused", runId: bell.id });
    const row = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, bell.id)).get()!;
    expect(row.status).toBe("SKIPPED_PAUSED");
    expect(row.resultMessage).toMatch(/drill/i);
  });
});

describe("a drill abandons itself rather than misfiring", () => {
  it("aborts if the announcement does not play, so no tone goes out unwarned", async () => {
    startDrill({ sequenceId: classicSequence(), userId });
    const adapter = fakeAdapter();
    // The announcement is a TTS cue; make Protect reject it.
    (adapter.speak as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 400, ms: 5 });

    expect(await tickDrill(adapter)).toBe("aborted");
    expect(readDrillState().active).toBe(false);
    expect(adapter.triggerWebhook).not.toHaveBeenCalled();
    expect(runNames()).not.toContain("Lockdown tone");

    const abort = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all().at(-1)!;
    expect(abort.detail).toMatch(/rather than sounding an emergency tone/i);
  });

  it("aborts instead of firing a step that came due long ago", async () => {
    startDrill({ sequenceId: classicSequence(), userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);

    // The worker was down across the pause: the next step is far overdue.
    updateSystemState({ speakerBusyUntil: null, drillNextStepAt: Date.now() - 20 * 60_000 });
    expect(await tickDrill(adapter, Date.now())).toBe("aborted");

    const abort = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all().at(-1)!;
    expect(abort.detail).toMatch(/late/i);
    expect(readDrillState().active).toBe(false);
  });

  it("still fires a step that is only slightly late", async () => {
    startDrill({ sequenceId: classicSequence(), userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);

    updateSystemState({ speakerBusyUntil: null, drillNextStepAt: Date.now() - 30_000 });
    expect(await tickDrill(adapter, Date.now())).toBe("played");
  });

  it("aborts if a sound it needs is turned off while it is running", async () => {
    startDrill({ sequenceId: classicSequence(), userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);

    db.update(schema.soundCues).set({ isEnabled: false }).where(eq(schema.soundCues.id, allClearId)).run();
    updateSystemState({ speakerBusyUntil: null });
    expect(await tickDrill(adapter, Date.now() + 10_000)).toBe("aborted");
    db.update(schema.soundCues).set({ isEnabled: true }).where(eq(schema.soundCues.id, allClearId)).run();
  });

  it("can be stopped by hand at any point, and stays stopped", async () => {
    startDrill({ sequenceId: classicSequence(), userId });
    const adapter = fakeAdapter();
    await tickDrill(adapter);
    stopDrill(userId);

    expect(readDrillState().active).toBe(false);
    expect(await tickDrill(adapter, Date.now() + 600_000)).toBe("idle");
  });
});

describe("a long sound must not be talked over", () => {
  /** A speaker that behaves like the real one: 500 while it is still sounding. */
  function realisticAdapter(actualPlayMs: number) {
    let busyUntil = 0;
    const speak = vi.fn(async () => {
      if (Date.now() < busyUntil) return { status: 500, ms: 5 };
      busyUntil = Date.now() + actualPlayMs;
      return { status: 200, ms: 50 };
    });
    const triggerWebhook = vi.fn(async () => {
      if (Date.now() < busyUntil) return { status: 500, ms: 5 };
      busyUntil = Date.now() + actualPlayMs;
      return { status: 204, ms: 10 };
    });
    return {
      metaInfo: vi.fn(), listSpeakers: vi.fn(), patchSpeaker: vi.fn(), testSound: vi.fn(),
      triggerWebhook, speak, bootstrap: vi.fn(),
    } as unknown as ProtectAdapter;
  }

  it("knows how long an 18s sound is when the cue declares it", () => {
    const long = seedWebhookCue("Armed intruder", "alert.intruder");
    db.update(schema.soundCues).set({ estimatedDurationMs: 18_000 }).where(eq(schema.soundCues.id, long)).run();
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: long }]);
    const step = effectiveSteps(sequenceId)![0];
    expect(estimateDurationMs(step.cue!)).toBe(18_000);
  });

  it("reports how long one sounding takes, so staff can see how many to expect", () => {
    const long = seedWebhookCue("Armed intruder 2", "alert.intruder2");
    db.update(schema.soundCues).set({ estimatedDurationMs: 18_000 }).where(eq(schema.soundCues.id, long)).run();
    const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.id, long)).get()!;
    // 18s of message plus the shared tag after it.
    expect(cycleSecondsFor(cue)).toBeGreaterThan(18);
    expect(cycleSecondsFor(cue)).toBeLessThan(40);
  });

  it("never starts the next sounding before the previous one has finished", async () => {
    const long = seedWebhookCue("Armed intruder 3", "alert.intruder3");
    db.update(schema.soundCues).set({ estimatedDurationMs: 18_000 }).where(eq(schema.soundCues.id, long)).run();
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: long, repeatForSeconds: 120 }]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();

    const starts: number[] = [];
    for (let i = 0; i < 10 && readDrillState().active; i++) {
      const before = runNames().length;
      // The lock is keyed to real time; the tick is given simulated time.
      updateSystemState({ speakerBusyUntil: null });
      const at = (readDrillState().nextStepAt ?? Date.now());
      const r = await tickDrill(adapter, at);
      if (r === "played" && runNames().length > before) starts.push(at);
    }
    // Consecutive soundings are at least the message length apart.
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(18_000);
    }
    expect(starts.length).toBeGreaterThan(1);
  });

  it("waits out a still-busy speaker instead of abandoning the drill", async () => {
    // Protect answers 500 while the device is still sounding. Model exactly
    // that for the closing tag: refused twice, then free.
    let speakCalls = 0;
    const adapter = fakeAdapter();
    (adapter.speak as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      speakCalls += 1;
      return speakCalls >= 2 && speakCalls <= 3 ? { status: 500, ms: 5 } : { status: 200, ms: 50 };
    });

    const long = seedWebhookCue("Armed intruder 4", "alert.intruder4");
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: long }]);
    // The audit log spans the whole file; count only aborts from this test.
    const abortsBefore = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all().length;
    startDrill({ sequenceId, userId });

    expect(await tickDrill(adapter)).toBe("announced"); // opening tag
    expect(await nextTick(adapter)).toBe("played"); // the message

    // The closing tag arrives while the speaker is still going. It must wait
    // it out — a 500 means nothing played, so retrying cannot double up.
    expect(await nextTick(adapter)).toBe("announced");
    expect(readDrillState().active || runNames().length === 4).toBe(true);

    const aborts = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all();
    expect(aborts.slice(abortsBefore).filter((a) => /did not play/i.test(a.detail ?? ""))).toHaveLength(0);
  }, 20_000);

});

describe("choosing which sound announces a drill", () => {
  it("uses the seeded spoken announcement until told otherwise", () => {
    setSetting("drillPreambleCueId", null);
    expect(preambleCue()?.name).toBe(DEFAULT_PREAMBLE_CUE_NAME);
  });

  it("follows the setting to a recorded announcement, and uses its real length", () => {
    const audioId = db
      .insert(schema.audioFiles)
      .values({
        name: "Principal — this is a drill",
        storedName: "recorded-tag.mp3",
        sizeBytes: 12_345,
        durationMs: 6_200,
        createdAt: Date.now(),
      })
      .returning({ id: schema.audioFiles.id })
      .get().id;
    const now = Date.now();
    const cueId = db
      .insert(schema.soundCues)
      .values({
        name: "Drill announcement (recorded)",
        deliveryMethod: "PROTECT_TALKBACK_AUDIO",
        audioFileId: audioId,
        estimatedDurationMs: 6_200,
        ttsTone: "neutral",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.soundCues.id })
      .get().id;

    setSetting("drillPreambleCueId", cueId);
    const tag = preambleCue()!;
    expect(tag.id).toBe(cueId);
    expect(tag.deliveryMethod).toBe("PROTECT_TALKBACK_AUDIO");
    // A measured file beats a guess from text length.
    expect(estimateDurationMs(tag)).toBe(6_200);
  });

  it("plays the recorded announcement on both sides of a drill sound", async () => {
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: lockdownId }]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();
    for (let i = 0; i < 6 && readDrillState().active; i++) await nextTick(adapter);

    const names = runNames();
    expect(names.filter((n) => /Drill announcement \(recorded\)/.test(n))).toHaveLength(2);
    expect(names[1]).toBe("Lockdown tone");
  });

  it("refuses to start when the chosen announcement is turned off", () => {
    const id = preambleCue()!.id;
    db.update(schema.soundCues).set({ isEnabled: false }).where(eq(schema.soundCues.id, id)).run();
    const r = startDrill({ sequenceId: seedSequence([{ kind: "PLAY", cueId: lockdownId }]), userId });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/turned off/i);
    db.update(schema.soundCues).set({ isEnabled: true }).where(eq(schema.soundCues.id, id)).run();
  });

  it("falls back to the seeded announcement if the setting points at nothing", () => {
    setSetting("drillPreambleCueId", 999_999);
    expect(preambleCue()?.name).toBe(DEFAULT_PREAMBLE_CUE_NAME);
    setSetting("drillPreambleCueId", null);
  });
});

describe("the announcement is not an ordinary sound", () => {
  it("cannot be added as a step of its own", async () => {
    setSetting("drillPreambleCueId", null);
    const tagId = preambleCue()!.id;
    const r = await createDrill({
      name: `Self-announcing ${Date.now()}`,
      steps: [{ kind: "PLAY", cueId: tagId }],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/added around every sound automatically/i);
  });

  it("cannot be pointed at a sound that is already a step in a drill", async () => {
    seedSequence([{ kind: "PLAY", cueId: lockdownId }], `Uses lockdown ${Date.now()}`);
    const fd = new FormData();
    fd.set("cueId", String(lockdownId));
    const r = await setDrillAnnouncement(fd);
    expect(r.ok).toBe(false);
    // Names the sound and the drill that uses it, so the fix is obvious.
    expect(r.message).toMatch(/Lockdown tone/);
    expect(r.message).toMatch(/is a step in/);
  });

  it("refuses an emergency sound as the announcement", async () => {
    const fd = new FormData();
    fd.set("cueId", String(alertCueId));
    const r = await setDrillAnnouncement(fd);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/opposite of what it means/i);
  });
});

describe("a refused talkback session does not kill the drill", () => {
  it("retries a session the speaker closed before any audio went out", async () => {
    const { streamToSpeakers } = await import("@/lib/protect/talkback");
    const { TalkbackError } = await import("@/lib/protect/talkback");
    const mocked = streamToSpeakers as unknown as ReturnType<typeof vi.fn>;

    // Refused once — the speaker was still releasing the previous session —
    // then fine, exactly the pattern seen on hardware.
    let calls = 0;
    mocked.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new TalkbackError("the speaker closed the talkback session", false, { retryable: true });
      }
      return [120];
    });

    const rec = seedRecordedCue("Refused once");
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: rec }]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();

    expect(await tickDrill(adapter)).toBe("announced"); // the tag is TTS here
    expect(await nextTick(adapter)).toBe("played"); // the recording, refused then retried
    expect(calls).toBe(2); // one refusal, one success
    expect(readDrillState().active).toBe(true); // and the drill carries on

    mocked.mockImplementation(async () => [120]);
  }, 20_000);

  it("gives up without retrying when the failure cannot clear", async () => {
    const { streamToSpeakers, TalkbackError } = await import("@/lib/protect/talkback");
    const mocked = streamToSpeakers as unknown as ReturnType<typeof vi.fn>;
    let calls = 0;
    mocked.mockImplementation(async () => {
      calls += 1;
      throw new TalkbackError("no audio frames produced by ffmpeg", false);
    });

    const rec = seedRecordedCue("Broken file");
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: rec }]);
    startDrill({ sequenceId, userId });
    const adapter = fakeAdapter();

    expect(await tickDrill(adapter)).toBe("announced");
    await nextTick(adapter);
    // One attempt, not three: a bad file fails the same way every time, and
    // sleeping 5s to prove it just delays the error.
    expect(calls).toBe(1);
    const run = db.select().from(schema.scheduledRuns).all().at(-1)!;
    expect(run.status).toBe("FAILED");
    expect(run.resultMessage).toMatch(/ffmpeg/i);

    mocked.mockImplementation(async () => [120]);
  });
});

describe("a recorded announcement is spliced onto the sound", () => {
  it("plays both as ONE talkback session, with no gap between them", async () => {
    const { streamToSpeakers } = await import("@/lib/protect/talkback");
    const mocked = streamToSpeakers as unknown as ReturnType<typeof vi.fn>;
    const opts: unknown[] = [];
    mocked.mockImplementation(async (_ids: string[], o: unknown) => {
      opts.push(o);
      return [120];
    });

    // Both the tag and the sound are recordings.
    const recTag = seedRecordedCue("Spoken tag");
    setSetting("drillPreambleCueId", recTag);
    const alert = seedRecordedCue("Alert tone");
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: alert }]);
    startDrill({ sequenceId, userId });

    const adapter = fakeAdapter();
    expect(await tickDrill(adapter)).toBe("played"); // not "announced" — one delivery

    // One session carrying both files, tag first.
    expect(opts).toHaveLength(1);
    const sent = opts[0] as { files?: string[] };
    expect(sent.files).toHaveLength(2);
    expect(sent.files![0]).toContain("Spoken tag");
    expect(sent.files![1]).toContain("Alert tone");

    // Recorded as a single run that names both.
    const run = db.select().from(schema.scheduledRuns).all().at(-1)!;
    expect(run.cueName).toMatch(/with drill announcement/i);
    expect(JSON.parse(run.audioPaths!)).toHaveLength(2);

    setSetting("drillPreambleCueId", null);
    mocked.mockImplementation(async () => [120]);
  });

  it("abandons the drill if the spliced stream fails — the tag was inside it", async () => {
    const { streamToSpeakers, TalkbackError } = await import("@/lib/protect/talkback");
    const mocked = streamToSpeakers as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(async () => {
      throw new TalkbackError("no audio frames produced by ffmpeg", false);
    });

    const recTag = seedRecordedCue("Tag two");
    setSetting("drillPreambleCueId", recTag);
    const alert = seedRecordedCue("Alert two");
    startDrill({ sequenceId: seedSequence([{ kind: "PLAY", cueId: alert }]), userId });

    expect(await tickDrill(fakeAdapter())).toBe("aborted");
    const abort = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "drill.abort")).all().at(-1)!;
    expect(abort.detail).toMatch(/announcement did not play/i);

    setSetting("drillPreambleCueId", null);
    mocked.mockImplementation(async () => [120]);
  });

  it("still uses two sessions when the announcement is spoken, not recorded", async () => {
    setSetting("drillPreambleCueId", null); // the seeded TTS announcement
    const alert = seedRecordedCue("Alert three");
    startDrill({ sequenceId: seedSequence([{ kind: "PLAY", cueId: alert }]), userId });
    const adapter = fakeAdapter();
    // TTS cannot be spliced into a talkback stream, so the tag is its own step.
    expect(await tickDrill(adapter)).toBe("announced");
  });
});

describe("a repeating recorded phase streams continuously", () => {
  async function loopMock() {
    const { streamLoopToSpeakers } = await import("@/lib/protect/talkback");
    return streamLoopToSpeakers as unknown as ReturnType<typeof vi.fn>;
  }

  it("plays the whole phase as ONE looped session, then advances", async () => {
    const mock = await loopMock();
    mock.mockClear();
    mock.mockImplementation(async () => ({ cycles: 9, frames: 900, reconnects: 0, ended: "until" as const }));

    const recTag = seedRecordedCue("Loop tag");
    setSetting("drillPreambleCueId", recTag);
    const alert = seedRecordedCue("Loop alert");
    const sequenceId = seedSequence([
      { kind: "PLAY", cueId: alert, repeatForSeconds: 240 },
      { kind: "PLAY", cueId: allClearId },
    ]);
    startDrill({ sequenceId, userId });

    expect(await tickDrill(fakeAdapter())).toBe("played");
    await drillStreamSettled();

    // One loop for the phase — not one session per sounding.
    expect(mock).toHaveBeenCalledTimes(1);
    const opts = mock.mock.calls[0][1] as { files: string[]; gapSeconds?: number; until: number };
    expect(opts.files).toHaveLength(2);
    expect(opts.files[0]).toContain("Loop tag");
    expect(opts.files[1]).toContain("Loop alert");
    expect(opts.gapSeconds).toBe(0);

    // The run records the whole phase, and the drill advanced past it.
    const run = db.select().from(schema.scheduledRuns).all().at(-1)!;
    expect(run.cueName).toMatch(/sounding \(with drill announcement\)/);
    expect(run.status).toBe("SUCCESS");
    expect(run.resultMessage).toMatch(/sounded 9×/);
    expect(readDrillState().stepIndex).toBe(1);

    setSetting("drillPreambleCueId", null);
  });

  it("Stop drill flips the stream's stop predicate within a frame", async () => {
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

    const recTag = seedRecordedCue("Stop tag");
    setSetting("drillPreambleCueId", recTag);
    const alert = seedRecordedCue("Stop alert sound");
    startDrill({ sequenceId: seedSequence([{ kind: "PLAY", cueId: alert, repeatForSeconds: 240 }]), userId });

    expect(await tickDrill(fakeAdapter())).toBe("played");
    // Wait for the background task to reach the loop call.
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 5));
    expect(captured).not.toBeNull();
    expect(captured!.shouldStop()).toBe(false);

    stopDrill(userId);
    expect(captured!.shouldStop()).toBe(true); // the frame loop sees this within ~43ms

    finish({ cycles: 1, frames: 100, reconnects: 0, ended: "stopped" });
    await drillStreamSettled();
    setSetting("drillPreambleCueId", null);
  });

  it("resumes the stream after a worker restart mid-phase", async () => {
    const mock = await loopMock();
    mock.mockClear();
    mock.mockImplementation(async () => ({ cycles: 3, frames: 300, reconnects: 0, ended: "until" as const }));

    const recTag = seedRecordedCue("Resume tag");
    setSetting("drillPreambleCueId", recTag);
    const alert = seedRecordedCue("Resume alert");
    const sequenceId = seedSequence([{ kind: "PLAY", cueId: alert, repeatForSeconds: 240 }]);
    startDrill({ sequenceId, userId });

    // Simulate the dead worker: DB mid-phase, an orphaned EXECUTING run, and
    // no live stream task (the fresh process starts with none).
    const now = Date.now();
    const endsAt = now + 120_000;
    updateSystemState({ drillStepPhase: "SOUND", drillStepEndsAt: endsAt, drillNextStepAt: endsAt });
    const orphan = db
      .insert(schema.scheduledRuns)
      .values({
        source: "DRILL",
        deliveryMethod: "PROTECT_TALKBACK_AUDIO",
        cueName: "Resume alert — sounding (with drill announcement)",
        audioPath: "x",
        scheduledAtUtc: now - 60_000,
        localDate: "2027-01-01",
        localTime: "08:00",
        status: "EXECUTING",
        createdAt: now - 60_000,
      })
      .returning({ id: schema.scheduledRuns.id })
      .get();
    _resetDrillStreamForTests();

    expect(await tickDrill(fakeAdapter())).toBe("played");
    await drillStreamSettled();

    // The orphan is closed out honestly, and the stream resumed to the phase's
    // original end — not restarted for a fresh 240s.
    const orphanRow = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, orphan.id)).get()!;
    expect(orphanRow.status).toBe("DELIVERY_UNCERTAIN");
    const opts = mock.mock.calls.at(-1)![1] as { until: number };
    expect(opts.until).toBe(endsAt);

    setSetting("drillPreambleCueId", null);
  });
});

describe("odd numbers in the drill editor are caught, not reinterpreted", () => {
  const play = (repeatForSeconds: number | null) => [
    { kind: "PLAY" as const, cueId: lockdownId, repeatForSeconds },
  ];

  it("a cleared or zero duration is a loud error, never a silent play-once", async () => {
    // The UI holds a cleared field as 0 so the step stays "Keep sounding";
    // saving it must fail with a message, not quietly degrade the drill.
    const r = await createDrill({ name: `Zero ${Date.now()}`, steps: play(0) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/how many minutes/i);
  });

  it("an oversized duration is rejected with the cap", async () => {
    const r = await createDrill({ name: `Huge ${Date.now()}`, steps: play(6000) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/capped at 30 minutes/i);
  });

  it("a fractional duration is accepted and rounded", async () => {
    const name = `Frac ${Date.now()}`;
    const r = await createDrill({ name, steps: play(150) }); // 2.5 min from the UI
    expect(r.ok).toBe(true);
    const seq = db.select().from(schema.drillSequences).where(eq(schema.drillSequences.name, name)).get()!;
    const step = db.select().from(schema.drillSteps).where(eq(schema.drillSteps.sequenceId, seq.id)).get()!;
    expect(step.repeatForSeconds).toBe(150);
  });
});

describe("combined announcements (chime + message as one cue)", () => {
  function seedAudio(name: string, durationMs: number): number {
    return db
      .insert(schema.audioFiles)
      .values({ name, storedName: `${name}-${Date.now()}.wav`, sizeBytes: 1000, durationMs, createdAt: Date.now() })
      .returning({ id: schema.audioFiles.id })
      .get().id;
  }
  function seedComposite(name: string, partIds: number[]): typeof schema.soundCues.$inferSelect {
    const now = Date.now();
    const cue = db
      .insert(schema.soundCues)
      .values({
        name,
        deliveryMethod: "PROTECT_TALKBACK_COMPOSITE",
        ttsTone: "neutral",
        estimatedDurationMs: 11_000,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    partIds.forEach((audioFileId, i) =>
      db.insert(schema.soundCueParts).values({ cueId: cue.id, position: i, audioFileId }).run(),
    );
    return cue;
  }

  it("plays its parts as ONE spliced stream, in order", async () => {
    const { streamToSpeakers } = await import("@/lib/protect/talkback");
    const mock = streamToSpeakers as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();
    const captured: unknown[] = [];
    mock.mockImplementation(async (_ids: string[], o: unknown) => {
      captured.push(o);
      return [260];
    });

    const chime = seedAudio("Attention chime", 3000);
    const msg = seedAudio("Spoken message", 8000);
    const cue = seedComposite(`Combined ${Date.now()}`, [chime, msg]);

    const { runId, outcome } = await triggerManualRun(fakeAdapter(), {
      source: "MANUAL",
      requestedBy: userId,
      cue,
      ...localDateTimeParts(),
    });

    expect(outcome.status).toBe("SUCCESS");
    // One session, chime first — not two deliveries with a gap.
    expect(captured).toHaveLength(1);
    const files = (captured[0] as { files: string[] }).files;
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("Attention chime");
    expect(files[1]).toContain("Spoken message");

    // The run row carries the flattened method, never the cue type.
    const run = db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, runId)).get()!;
    expect(run.deliveryMethod).toBe("PROTECT_TALKBACK_AUDIO");
    expect(JSON.parse(run.audioPaths!)).toHaveLength(2);
    mock.mockImplementation(async () => [120]);
  });

  it("refuses fewer than two parts", async () => {
    const chime = seedAudio("Lone chime", 3000);
    const fd = new FormData();
    fd.set("name", `One part ${Date.now()}`);
    fd.set("deliveryMethod", "PROTECT_TALKBACK_COMPOSITE");
    fd.set("partIds", JSON.stringify([chime]));
    fd.set("isEnabled", "on");
    const r = await createCue({ ok: false }, fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least two recordings/i);
  });

  it("stores the summed duration, so the speaker lock is honest", async () => {
    const chime = seedAudio("Sum chime", 3000);
    const msg = seedAudio("Sum message", 8000);
    const name = `Summed ${Date.now()}`;
    const fd = new FormData();
    fd.set("name", name);
    fd.set("deliveryMethod", "PROTECT_TALKBACK_COMPOSITE");
    fd.set("partIds", JSON.stringify([chime, msg]));
    fd.set("isEnabled", "on");
    const r = await createCue({ ok: false }, fd);
    expect(r.ok).toBe(true);
    const cue = db.select().from(schema.soundCues).where(eq(schema.soundCues.name, name)).get()!;
    expect(cue.estimatedDurationMs).toBe(11_000);
    const parts = db.select().from(schema.soundCueParts).where(eq(schema.soundCueParts.cueId, cue.id)).all();
    expect(parts.map((p) => p.audioFileId)).toEqual([chime, msg]);
  });
});
