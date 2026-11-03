import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { fakeProtectAdapter, insertClaimedRun, seedSpeaker, seedTtsCue } from "./helpers";
import { getSystemState, updateSystemState } from "@/lib/state";
import { streamToSpeakers, TalkbackError } from "@/lib/protect/talkback";

// The real streamer by default (the setup-failure test below relies on it);
// individual tests script the fan-out result.
vi.mock("@/lib/protect/talkback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/protect/talkback")>();
  return { ...actual, streamToSpeakers: vi.fn(actual.streamToSpeakers) };
});
const streamMock = vi.mocked(streamToSpeakers);

function fakeAdapter(overrides: Partial<ProtectAdapter>): ProtectAdapter {
  return fakeProtectAdapter({
    speak: vi.fn().mockResolvedValue({ status: 200, ms: 100 }),
    ...overrides,
  });
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

  it("treats the v2 Alarm Manager's 204 as a played announcement", async () => {
    const id = insertClaimedRun({
      deliveryMethod: "PROTECT_NATIVE_TTS",
      webhookId: null,
      ttsText: "Announcement check",
    });
    const adapter = fakeAdapter({ speak: vi.fn().mockResolvedValue({ status: 204, ms: 650, detail: "" }) });
    const outcome = await executeClaimedRun(adapter, id);
    expect(outcome.status).toBe("SUCCESS");
    expect(runRow(id).httpStatus).toBe(204);
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

describe("talkback runs that reach only some speakers", () => {
  // Four speakers, two of them offline in Protect — the 2026-11-02 school setup.
  const hall = "AB0001";
  const office = "AB0002";
  const gym = "AB0003";
  const lab = "AB0004";
  seedSpeaker(hall, "Hall");
  seedSpeaker(office, "Office");
  seedSpeaker(gym, "Basement Gym");
  seedSpeaker(lab, "Basement Lab");
  db.update(schema.speakers)
    .set({ state: "DISCONNECTED" })
    .where(eq(schema.speakers.mac, gym))
    .run();
  db.update(schema.speakers)
    .set({ state: "DISCONNECTED" })
    .where(eq(schema.speakers.mac, lab))
    .run();
  const all = [gym, hall, office, lab];

  beforeEach(() => {
    streamMock.mockClear();
  });

  function talkbackRun(macs: string[]): number {
    return insertClaimedRun({
      deliveryMethod: "PROTECT_TALKBACK_AUDIO",
      webhookId: null,
      audioPath: "/sounds/passing-bell.mp3",
      estimatedDurationMs: 13_000,
      targetMacs: JSON.stringify(macs),
      source: "SCHEDULE",
      cueName: "Passing bell",
    });
  }

  it("all speakers: plain SUCCESS, as before", async () => {
    streamMock.mockImplementationOnce(async (ids) => ({ frames: 314, sent: ids.map(() => 314), missed: [] }));
    const id = talkbackRun([hall, office]);
    const outcome = await executeClaimedRun(fakeAdapter({}), id);
    expect(outcome.status).toBe("SUCCESS");
    expect(runRow(id).status).toBe("SUCCESS");
    expect(runRow(id).resultMessage).toBe("streamed 314/314 frames (no delivery confirmation available)");
  });

  it("some speakers: PARTIAL, naming the speakers that missed it and why", async () => {
    streamMock.mockImplementationOnce(async (ids) => ({
      frames: 314,
      sent: ids.map((sid) => (sid === `spk-${gym}` || sid === `spk-${lab}` ? 0 : 314)),
      missed: ids
        .filter((sid) => sid === `spk-${gym}` || sid === `spk-${lab}`)
        .map((speakerId) => ({ speakerId, partial: false, error: "talkback WS rejected: HTTP 500" })),
    }));
    const id = talkbackRun(all);
    const outcome = await executeClaimedRun(fakeAdapter({}), id);

    expect(outcome.status).toBe("PARTIAL");
    const row = runRow(id);
    expect(row.status).toBe("PARTIAL");
    expect(row.resultMessage).toMatch(/^2 of 4 speakers missed it: /);
    expect(row.resultMessage).toContain("Basement Gym (Protect reports it disconnected)");
    expect(row.resultMessage).toContain("Basement Lab (Protect reports it disconnected)");
    expect(row.resultMessage).not.toMatch(/Hall|Office/);
    // The per-speaker counts are still there for whoever debugs it.
    expect(row.resultMessage).toMatch(/streamed (0|314)\/(0|314)\/(0|314)\/(0|314) of 314 frames$/);
    // It did play, so the speaker keeps its recovery window like a success.
    expect(getSystemState().speakerBusyUntil ?? 0).toBeGreaterThan(Date.now() + 10_000);
    // Never retried: that would ring a second time where it already played.
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("says why when the speaker looks online, and flags one cut off partway", async () => {
    streamMock.mockImplementationOnce(async (ids) => ({
      frames: 314,
      sent: ids.map((sid) => (sid === `spk-${hall}` ? 0 : 120)),
      missed: [
        { speakerId: `spk-${hall}`, partial: false, error: "talkback WS rejected: HTTP 404" },
        { speakerId: `spk-${office}`, partial: true },
      ],
    }));
    const id = talkbackRun([hall, office]);
    const outcome = await executeClaimedRun(fakeAdapter({}), id);
    expect(outcome.status).toBe("PARTIAL");
    expect(outcome.message).toContain("2 of 2 speakers missed it");
    expect(outcome.message).toContain("Hall (talkback WS rejected: HTTP 404)");
    expect(outcome.message).toContain("Office (cut off partway)");
  });

  it("no speakers: FAILED, and the speaker is freed at once", async () => {
    streamMock.mockRejectedValueOnce(new TalkbackError("talkback WS rejected: HTTP 500", false));
    const id = talkbackRun([gym, lab]);
    const outcome = await executeClaimedRun(fakeAdapter({}), id);
    expect(outcome.status).toBe("FAILED");
    expect(runRow(id).resultMessage).toMatch(/HTTP 500/);
    expect(getSystemState().speakerBusyUntil ?? 0).toBeLessThan(Date.now() + 10_000);
  });
});
