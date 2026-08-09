import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { insertClaimedRun, seedSpeaker, seedTtsCue } from "./helpers";
import { updateSystemState } from "@/lib/state";

function fakeAdapter(overrides: Partial<ProtectAdapter>): ProtectAdapter {
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

function netError(code: string): Error {
  const cause = Object.assign(new Error(code), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function runRow(id: number) {
  return db.select().from(schema.scheduledRuns).where(eq(schema.scheduledRuns.id, id)).get()!;
}

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  // Each test assumes a free speaker; the lock legitimately persists otherwise.
  updateSystemState({ speakerBusyUntil: null });
});

describe("executor", () => {
  it("webhook 204 → SUCCESS with latency recorded", async () => {
    const id = insertClaimedRun({});
    const adapter = fakeAdapter({});
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("SUCCESS");
    const row = runRow(id);
    expect(row.status).toBe("SUCCESS");
    expect(row.httpStatus).toBe(204);
    expect(adapter.triggerWebhook).toHaveBeenCalledTimes(1);
  });

  it("webhook 404 → FAILED with a helpful hint", async () => {
    const id = insertClaimedRun({ webhookId: "bell.nope" });
    const adapter = fakeAdapter({ triggerWebhook: vi.fn().mockResolvedValue({ status: 404, ms: 5 }) });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("FAILED");
    expect(runRow(id).resultMessage).toContain("bell.nope");
  });

  it("retries pre-transmission failures, then succeeds", async () => {
    const id = insertClaimedRun({});
    const trigger = vi
      .fn()
      .mockRejectedValueOnce(netError("ECONNREFUSED"))
      .mockRejectedValueOnce(netError("ECONNREFUSED"))
      .mockResolvedValue({ status: 204, ms: 10 });
    const adapter = fakeAdapter({ triggerWebhook: trigger });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("SUCCESS");
    expect(trigger).toHaveBeenCalledTimes(3);
  });

  it("NEVER retries ambiguous mid-flight errors — DELIVERY_UNCERTAIN, one call only", async () => {
    const id = insertClaimedRun({});
    const trigger = vi.fn().mockRejectedValue(netError("ECONNRESET"));
    const adapter = fakeAdapter({ triggerWebhook: trigger });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("DELIVERY_UNCERTAIN");
    expect(runRow(id).status).toBe("DELIVERY_UNCERTAIN");
    // The no-double-bell property: exactly one transmission attempt.
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("exhausted pre-transmission retries → FAILED (nothing was ever sent)", async () => {
    const id = insertClaimedRun({});
    const trigger = vi.fn().mockRejectedValue(netError("ECONNREFUSED"));
    const adapter = fakeAdapter({ triggerWebhook: trigger });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("FAILED");
    expect(trigger).toHaveBeenCalledTimes(3);
  });

  it("TTS resolves zone members at execution time", async () => {
    seedSpeaker("AAA111", "Hall");
    seedSpeaker("BBB222", "Gym");
    const zoneId = db
      .insert(schema.zones)
      .values({ name: "Gym Zone", createdAt: Date.now() })
      .returning({ id: schema.zones.id })
      .get().id;
    db.insert(schema.zoneMembers).values({ zoneId, speakerMac: "BBB222" }).run();
    const cueId = seedTtsCue("Zone Speech", "Hello gym", zoneId);

    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Hello gym",
      ttsTone: "welcome",
      cueId,
    });
    const speak = vi.fn().mockResolvedValue({ status: 200, ms: 50 });
    const adapter = fakeAdapter({ speak });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("SUCCESS");
    expect(speak).toHaveBeenCalledWith("Hello gym", ["BBB222"], "welcome");
  });

  it("TTS with no zone targets every known speaker", async () => {
    seedSpeaker("CCC333", "Lobby");
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Hello all",
      ttsTone: "welcome",
    });
    const speak = vi.fn().mockResolvedValue({ status: 200, ms: 50 });
    const adapter = fakeAdapter({ speak });
    await executeClaimedRun(adapter, id);
    const macs = speak.mock.calls[0][1] as string[];
    expect(macs).toContain("CCC333");
  });

  it("classifies a talkback setup failure as FAILED, not DELIVERY_UNCERTAIN", async () => {
    // Nothing was transmitted, so claiming uncertainty would be a lie that
    // sends someone hunting for audio that never played.
    seedSpeaker("FFF666", "Hall");
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      webhookId: null,
      audioPath: "/nonexistent/definitely-not-here.mp3",
      estimatedDurationMs: 3000,
    });
    const outcome = await executeClaimedRun(fakeAdapter({}), id);
    expect(outcome.status).toBe("FAILED");
    expect(runRow(id).status).toBe("FAILED");
  });

  it("uses snapshotted targetMacs when present", async () => {
    seedSpeaker("DDD444", "Office");
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Snapshot",
      ttsTone: "welcome",
      targetMacs: JSON.stringify(["EEE555"]),
    });
    const speak = vi.fn().mockResolvedValue({ status: 200, ms: 50 });
    const adapter = fakeAdapter({ speak });
    await executeClaimedRun(adapter, id);
    expect(speak).toHaveBeenCalledWith("Snapshot", ["EEE555"], "welcome");
  });
});

describe("Protect's 120-character TTS limit", () => {
  it("names the real cause instead of speculating about the voice", async () => {
    const longText = "x".repeat(131);
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: longText,
      cueName: "Hold All-Clear",
    });
    // What Protect actually returns for oversized text (observed 2026-08-08).
    const zod =
      '{"error":"Failed to parse \'request-body\'","name":"ZOD_PARSE_ERROR","issues":[{"code":"too_big","maximum":120,"message":"String must contain at most 120 character(s)","path":["actions",0,"metadata","text"]}]}';
    const adapter = fakeAdapter({
      speak: vi.fn().mockResolvedValue({ status: 400, ms: 97, detail: zod }),
    });

    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.message).toMatch(/at most 120 characters/);
    expect(outcome.message).toMatch(/131/);
    expect(outcome.message).not.toMatch(/voice/);
  });

  it("still points at the voice for other 400s", async () => {
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Short and valid text",
    });
    const adapter = fakeAdapter({
      speak: vi.fn().mockResolvedValue({ status: 400, ms: 5, detail: "some other rejection" }),
    });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.message).toMatch(/voice/);
  });
});
