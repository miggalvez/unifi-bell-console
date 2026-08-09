import { describe, expect, it, vi, beforeEach } from "vitest";
import { db, schema } from "@/lib/db/client";
import { coerceTone, isValidTone, TTS_TONES, DEFAULT_TONE } from "@/lib/protect/tones";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import { updateSystemState } from "@/lib/state";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { insertClaimedRun, seedSpeaker } from "./helpers";

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  updateSystemState({ speakerBusyUntil: null });
});

describe("TTS voices", () => {
  // Protect returns HTTP 400 for any voice outside this list — verified by
  // probing 32 candidates against Protect 7.1.87.
  it("accepts only the voices Protect actually supports", () => {
    expect(TTS_TONES.map((t) => t.value)).toEqual(["welcome", "neutral"]);
    expect(isValidTone("welcome")).toBe(true);
    expect(isValidTone("neutral")).toBe(true);
    for (const bad of ["alert", "warning", "emergency", "urgent", "", "Welcome"]) {
      expect(isValidTone(bad)).toBe(false);
    }
  });

  it("coerces anything invalid to the default rather than failing the cue", () => {
    expect(coerceTone("neutral")).toBe("neutral");
    expect(coerceTone("warning")).toBe(DEFAULT_TONE);
    expect(coerceTone(null)).toBe(DEFAULT_TONE);
    expect(coerceTone(undefined)).toBe(DEFAULT_TONE);
  });

  it("never sends an invalid voice to Protect, even from stored data", async () => {
    seedSpeaker("AA11BB", "Hall");
    // A cue saved before validation existed could still hold a bad voice.
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Head to the nearest exit",
      ttsTone: "warning",
    });
    const speak = vi.fn().mockResolvedValue({ status: 200, ms: 50 });
    const adapter = { speak, triggerWebhook: vi.fn(), metaInfo: vi.fn(), listSpeakers: vi.fn(), patchSpeaker: vi.fn(), testSound: vi.fn(), bootstrap: vi.fn() } as unknown as ProtectAdapter;

    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("SUCCESS");
    expect(speak).toHaveBeenCalledWith("Head to the nearest exit", ["AA11BB"], DEFAULT_TONE);
  });

  it("explains a 400 instead of reporting a bare status code", async () => {
    seedSpeaker("CC22DD", "Gym");
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Test",
      ttsTone: "welcome",
    });
    const adapter = {
      speak: vi.fn().mockResolvedValue({ status: 400, ms: 20, detail: "invalid tone" }),
      triggerWebhook: vi.fn(), metaInfo: vi.fn(), listSpeakers: vi.fn(), patchSpeaker: vi.fn(), testSound: vi.fn(), bootstrap: vi.fn(),
    } as unknown as ProtectAdapter;

    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.message).toContain("Protect rejected");
    expect(outcome.message).toContain("invalid tone");
  });
});
