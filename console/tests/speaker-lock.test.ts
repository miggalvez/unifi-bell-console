import { describe, expect, it, beforeEach, vi } from "vitest";
import { db, schema } from "@/lib/db/client";
import { updateSystemState, getSystemState } from "@/lib/state";
import {
  acquireSpeaker,
  estimateDurationMs,
  releaseSpeaker,
  tryClaimSpeaker,
  COOLDOWN_MS,
  DEFAULT_DURATION_MS,
} from "@/lib/speaker-lock";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { insertClaimedRun } from "./helpers";

function fakeAdapter(overrides: Partial<ProtectAdapter> = {}): ProtectAdapter {
  return {
    metaInfo: vi.fn(),
    listSpeakers: vi.fn(),
    patchSpeaker: vi.fn(),
    testSound: vi.fn(),
    triggerWebhook: vi.fn().mockResolvedValue({ status: 204, ms: 10 }),
    speak: vi.fn().mockResolvedValue({ status: 200, ms: 100 }),
    bootstrap: vi.fn(),
    ...overrides,
  } as ProtectAdapter;
}

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  updateSystemState({ speakerBusyUntil: null });
});

describe("duration estimation", () => {
  it("prefers an explicit estimate, then audio length, then a default", () => {
    expect(estimateDurationMs({ deliveryMethod: "PROTECT_TALKBACK_AUDIO", estimatedDurationMs: 1234 })).toBe(1234);
    expect(estimateDurationMs({ deliveryMethod: "PROTECT_TALKBACK_AUDIO", audioDurationMs: 7000 })).toBe(7000);
    expect(estimateDurationMs({ deliveryMethod: "PROTECT_WEBHOOK" })).toBe(DEFAULT_DURATION_MS);
  });

  it("scales TTS with message length", () => {
    const short = estimateDurationMs({ deliveryMethod: "PROTECT_NATIVE_TTS", ttsText: "Hello" });
    const long = estimateDurationMs({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      ttsText: "Would the eighth grade students please report to the gymnasium immediately.",
    });
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(2000); // always allows for lead-in
  });
});

describe("speaker lock", () => {
  it("grants the first claim and refuses the second", () => {
    expect(tryClaimSpeaker(5000)).toBeNull();
    const wait = tryClaimSpeaker(5000);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThan(4000);
  });

  it("holds for duration plus cooldown", () => {
    const now = Date.now();
    tryClaimSpeaker(3000, now);
    expect(getSystemState().speakerBusyUntil).toBe(now + 3000 + COOLDOWN_MS);
  });

  it("frees again once the window passes", () => {
    const now = Date.now();
    tryClaimSpeaker(1000, now);
    expect(tryClaimSpeaker(1000, now + 500)).not.toBeNull();
    expect(tryClaimSpeaker(1000, now + 1000 + COOLDOWN_MS + 1)).toBeNull();
  });

  it("releaseSpeaker shortens the window without extending it", () => {
    const now = Date.now();
    tryClaimSpeaker(60_000, now);
    releaseSpeaker(0, now);
    expect(getSystemState().speakerBusyUntil!).toBeLessThanOrEqual(now);
    // A release must never push the busy window further out.
    tryClaimSpeaker(60_000, now);
    const before = getSystemState().speakerBusyUntil!;
    releaseSpeaker(120_000, now);
    expect(getSystemState().speakerBusyUntil!).toBeLessThanOrEqual(before);
  });

  it("acquireSpeaker gives up after maxWait when the speaker stays busy", async () => {
    tryClaimSpeaker(60_000);
    const got = await acquireSpeaker(1000, 400);
    expect(got).toBe(false);
  });
});

describe("executor + lock", () => {
  it("refuses to play while another cue holds the speaker", async () => {
    tryClaimSpeaker(60_000);
    const id = insertClaimedRun({});
    const adapter = fakeAdapter();
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.message).toContain("speaker busy");
    // Crucially: nothing was transmitted.
    expect(adapter.triggerWebhook).not.toHaveBeenCalled();
  });

  it("claims the speaker for the duration of a successful cue", async () => {
    const id = insertClaimedRun({});
    await executeClaimedRun(fakeAdapter(), id);
    expect(getSystemState().speakerBusyUntil!).toBeGreaterThan(Date.now());
  });

  it("frees the speaker immediately when delivery fails", async () => {
    const id = insertClaimedRun({});
    const adapter = fakeAdapter({ triggerWebhook: vi.fn().mockResolvedValue({ status: 404, ms: 5 }) });
    await executeClaimedRun(adapter, id);
    // A failed cue is not playing, so the next one must not have to wait it out.
    expect(getSystemState().speakerBusyUntil!).toBeLessThanOrEqual(Date.now() + COOLDOWN_MS);
  });
});
