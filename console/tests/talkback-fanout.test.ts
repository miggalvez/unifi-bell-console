import { describe, expect, it, vi } from "vitest";

// streamToSpeakers fans one encode out to one socket per speaker. These tests
// replace the three outside seams — ffmpeg, the Protect login, the talkback
// WebSocket — so what is under test is how per-speaker results are reported.

type Mode = "ok" | "refused" | "closes-before-audio" | "cut-off" | "errors-mid-stream";

const seams = vi.hoisted(() => ({
  /** How each speaker's socket behaves, keyed by speaker id. Default "ok". */
  modes: new Map<string, Mode>(),
  /** Ms each speaker's socket takes to open, keyed by speaker id. Default 0. */
  openDelay: new Map<string, number>(),
  /** When each speaker was sent its first frame (epoch ms). */
  firstSendAt: new Map<string, number>(),
  /** Frames the fake ffmpeg "encodes". Few enough to send inside LEAD_MS. */
  frames: 5,
  /** A valid ADTS stream of n minimal frames (7-byte header + 2 bytes). */
  adts(n: number): Buffer {
    const len = 9;
    const one = Buffer.alloc(len);
    one[0] = 0xff;
    one[1] = 0xf1;
    one[3] = (len >> 11) & 0x03;
    one[4] = (len >> 3) & 0xff;
    one[5] = (len & 0x07) << 5;
    return Buffer.concat(Array.from({ length: n }, () => one));
  },
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: () => {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      setTimeout(() => {
        proc.stdout.emit("data", seams.adts(seams.frames));
        proc.emit("close", 0);
      }, 0);
      return proc;
    },
  };
});

vi.mock("@/lib/protect/private", () => ({
  PrivateSession: class {},
  getPrivateSession: () => ({ authHeaders: async () => ({ cookie: "TOKEN=x" }), invalidate: () => {} }),
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    private sent = 0;
    private readonly mode: Mode;
    private readonly speaker: string;

    constructor(url: string) {
      super();
      this.speaker = new URL(url).searchParams.get("speaker")!;
      this.mode = seams.modes.get(this.speaker) ?? "ok";
      setTimeout(() => {
        if (this.mode === "refused") {
          this.emit("unexpected-response", {}, { statusCode: 500 });
          return;
        }
        this.readyState = 1;
        this.emit("open");
        // The speaker hangs up during the arm delay, before any audio.
        if (this.mode === "closes-before-audio") this.readyState = 3;
      }, seams.openDelay.get(this.speaker) ?? 0);
    }

    send(): void {
      if (this.sent === 0) seams.firstSendAt.set(this.speaker, Date.now());
      this.sent++;
      if (this.mode === "cut-off" && this.sent >= 2) this.readyState = 3;
      // The socket fails outright after two frames are already on their way.
      if (this.mode === "errors-mid-stream" && this.sent > 2) throw new Error("write EPIPE");
    }

    close(): void {
      this.readyState = 3;
    }
  }
  return { default: FakeSocket };
});

const { streamToSpeakers, streamLoopToSpeakers, TalkbackError, ARM_MS, SYNC_WAIT_MS } = await import(
  "@/lib/protect/talkback"
);

function setModes(modes: Record<string, Mode>, openDelay: Record<string, number> = {}): void {
  seams.openDelay.clear();
  seams.firstSendAt.clear();
  for (const [id, ms] of Object.entries(openDelay)) seams.openDelay.set(id, ms);
  seams.modes.clear();
  for (const [id, mode] of Object.entries(modes)) seams.modes.set(id, mode);
}

describe("streamToSpeakers reports every speaker's share", () => {
  it("all speakers: everyone got every frame, nothing missed", async () => {
    setModes({ hall: "ok", gym: "ok" });
    const r = await streamToSpeakers(["hall", "gym"], { beeps: 1 });
    expect(r.frames).toBe(5);
    expect(r.sent).toEqual([5, 5]);
    expect(r.missed).toEqual([]);
    expect(r.late).toEqual([]);
  });

  it("some speakers: names the ones that got nothing, with why", async () => {
    setModes({ gym: "refused", hall: "ok", office: "ok", lab: "closes-before-audio" });
    const r = await streamToSpeakers(["gym", "hall", "office", "lab"], { beeps: 1 });
    // The shape of the real 2026-11-02 runs: 0/314/314/0.
    expect(r.sent).toEqual([0, 5, 5, 0]);
    expect(r.missed).toEqual([
      { speakerId: "gym", partial: false, error: expect.stringMatching(/HTTP 500/) },
      { speakerId: "lab", partial: false, error: expect.stringMatching(/closed the talkback session/) },
    ]);
  });

  it("a speaker cut off mid-stream is a shortfall too, marked partial", async () => {
    setModes({ hall: "ok", gym: "cut-off" });
    const r = await streamToSpeakers(["hall", "gym"], { beeps: 1 });
    expect(r.sent).toEqual([5, 2]);
    expect(r.missed).toEqual([{ speakerId: "gym", partial: true, error: undefined }]);
  });

  it("no speakers: throws, saying nothing was transmitted", async () => {
    setModes({ hall: "refused", gym: "refused" });
    const err = await streamToSpeakers(["hall", "gym"], { beeps: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TalkbackError);
    expect((err as InstanceType<typeof TalkbackError>).transmitted).toBe(false);
    expect((err as Error).message).toMatch(/HTTP 500/);
  });
});

describe("streamToSpeakers starts every speaker on one clock", () => {
  // Timer slop on a loaded CI box; far below the 150ms the sockets differ by.
  const TOGETHER_MS = 40;

  it("speakers whose connections open at different speeds still start together", async () => {
    setModes({ hall: "ok", gym: "ok", lab: "ok" }, { hall: 0, gym: 150, lab: 300 });
    const t0 = Date.now();
    const r = await streamToSpeakers(["hall", "gym", "lab"], { beeps: 1 });
    const starts = ["hall", "gym", "lab"].map((id) => seams.firstSendAt.get(id)!);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(TOGETHER_MS);
    // The slowest connection still got its whole arm delay before any audio.
    expect(Math.min(...starts) - t0).toBeGreaterThanOrEqual(300 + ARM_MS - 5);
    expect(r.sent).toEqual([5, 5, 5]);
    expect(r.late).toEqual([]);
  });

  it("does not hold the building for one slow connection: it starts late, and is named", async () => {
    const slowBy = 400;
    setModes({ hall: "ok", gym: "ok" }, { hall: 0, gym: SYNC_WAIT_MS + slowBy });
    const t0 = Date.now();
    const r = await streamToSpeakers(["hall", "gym"], { beeps: 1 });
    const hall = seams.firstSendAt.get("hall")! - t0;
    const gym = seams.firstSendAt.get("gym")! - t0;
    // Hall waited the sync window and no longer.
    expect(hall).toBeGreaterThanOrEqual(SYNC_WAIT_MS + ARM_MS - 5);
    expect(hall).toBeLessThan(SYNC_WAIT_MS + ARM_MS + 100);
    // Gym played all of it, behind — with its own full arm delay.
    expect(gym).toBeGreaterThanOrEqual(SYNC_WAIT_MS + slowBy + ARM_MS - 5);
    expect(r.sent).toEqual([5, 5]);
    expect(r.missed).toEqual([]);
    expect(r.late).toHaveLength(1);
    expect(r.late[0].speakerId).toBe("gym");
    expect(Math.abs(r.late[0].lateMs - slowBy)).toBeLessThan(100);
  });

  it("a connection that fails outright never delays the others", async () => {
    setModes({ hall: "ok", gym: "refused" }, { hall: 0, gym: 200 });
    const t0 = Date.now();
    const r = await streamToSpeakers(["hall", "gym"], { beeps: 1 });
    expect(seams.firstSendAt.get("hall")! - t0).toBeLessThan(200 + ARM_MS + 100);
    expect(r.sent).toEqual([5, 0]);
    expect(r.late).toEqual([]);
  });

  it("every speaker hanging up before audio is still reported as safe to retry", async () => {
    setModes({ hall: "closes-before-audio", gym: "closes-before-audio" });
    const err = await streamToSpeakers(["hall", "gym"], { beeps: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TalkbackError);
    expect((err as InstanceType<typeof TalkbackError>).transmitted).toBe(false);
    expect((err as InstanceType<typeof TalkbackError>).retryable).toBe(true);
  });
});

describe("streamToSpeakers never calls a bell retryable once anyone heard part of it", () => {
  // One speaker hangs up before audio (on its own: safe to retry). The other
  // takes two frames and then its socket errors. A retry would ring the bell
  // from the top a second time in that second room — whichever speaker the
  // caller happened to list first.
  for (const order of [["lab", "gym"], ["gym", "lab"]]) {
    it(`refused + cut off by an error, listed ${order.join(" then ")}`, async () => {
      setModes({ lab: "closes-before-audio", gym: "errors-mid-stream" });
      const err = await streamToSpeakers(order, { beeps: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TalkbackError);
      expect((err as InstanceType<typeof TalkbackError>).transmitted).toBe(true);
      expect((err as InstanceType<typeof TalkbackError>).retryable).toBe(false);
      expect((err as Error).message).toMatch(/EPIPE/);
    });
  }

  it("nobody heard anything and one failure is the passing kind: retryable, in either order", async () => {
    for (const order of [["lab", "gym"], ["gym", "lab"]]) {
      setModes({ lab: "closes-before-audio", gym: "refused" });
      const err = await streamToSpeakers(order, { beeps: 1 }).catch((e: unknown) => e);
      expect((err as InstanceType<typeof TalkbackError>).transmitted).toBe(false);
      expect((err as InstanceType<typeof TalkbackError>).retryable).toBe(true);
    }
  });
});

describe("a measurement stream can be told to get off the speakers", () => {
  it("stops mid-stream on request, and reports the short count", async () => {
    setModes({ hall: "ok" });
    seams.frames = 40; // long enough to still be sending when the stop lands
    let stop = false;
    setTimeout(() => (stop = true), ARM_MS + 300);
    const t0 = Date.now();
    const r = await streamToSpeakers(["hall"], { beeps: 1, shouldStop: () => stop }).finally(() => (seams.frames = 5));
    expect(r.sent[0]).toBeGreaterThan(0);
    expect(r.sent[0]).toBeLessThan(40);
    expect(r.missed).toEqual([{ speakerId: "hall", partial: true, error: undefined }]);
    expect(Date.now() - t0).toBeLessThan(ARM_MS + 300 + 150);
  });

  it("stops during the silent hold without sending a frame", async () => {
    setModes({ hall: "ok" });
    let stop = false;
    setTimeout(() => (stop = true), 300);
    const t0 = Date.now();
    const err = await streamToSpeakers(["hall"], { beeps: 1, armMs: 5_000, shouldStop: () => stop }).catch((e: unknown) => e);
    expect(seams.firstSendAt.has("hall")).toBe(false);
    expect((err as InstanceType<typeof TalkbackError>).transmitted).toBe(false);
    expect((err as InstanceType<typeof TalkbackError>).retryable).toBe(false);
    expect(Date.now() - t0).toBeLessThan(300 + 250);
  });
});

describe("streamLoopToSpeakers starts every speaker's first cycle on one clock", () => {
  // Alerts and drill sounds open with a spoken announcement; four copies of it
  // a fraction of a second apart are harder to understand than a bell is.
  const loop = (ids: string[], o: { until: number; shouldStop?: () => boolean }) =>
    streamLoopToSpeakers(ids, { files: ["a.mp3"], shouldStop: () => false, ...o });

  it("speakers whose connections open at different speeds still start together", async () => {
    setModes({ hall: "ok", gym: "ok", lab: "ok" }, { hall: 0, gym: 150, lab: 300 });
    const t0 = Date.now();
    const r = await loop(["hall", "gym", "lab"], { until: t0 + 300 + ARM_MS + 250 });
    const starts = ["hall", "gym", "lab"].map((id) => seams.firstSendAt.get(id)!);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(40);
    // The slowest connection still got its whole arm delay before any audio.
    expect(Math.min(...starts) - t0).toBeGreaterThanOrEqual(300 + ARM_MS - 5);
    expect(r.cycles).toBeGreaterThan(0);
    expect(r.missed).toEqual([]);
  });

  it("does not hold the alert for one slow connection: the rest start after the sync window", async () => {
    setModes({ hall: "ok", gym: "ok" }, { hall: 0, gym: SYNC_WAIT_MS + 400 });
    const t0 = Date.now();
    await loop(["hall", "gym"], { until: t0 + SYNC_WAIT_MS + 400 + ARM_MS + 250 });
    const hall = seams.firstSendAt.get("hall")! - t0;
    const gym = seams.firstSendAt.get("gym")! - t0;
    expect(hall).toBeGreaterThanOrEqual(SYNC_WAIT_MS + ARM_MS - 5);
    expect(hall).toBeLessThan(SYNC_WAIT_MS + ARM_MS + 150);
    // The slow one plays too, behind, with its own full arm delay.
    expect(gym).toBeGreaterThanOrEqual(SYNC_WAIT_MS + 400 + ARM_MS - 5);
  });

  it("Stop pressed while waiting for a slow speaker: nothing is sent, and it says stopped", async () => {
    setModes({ hall: "ok", gym: "ok" }, { hall: 0, gym: 1_200 });
    let stop = false;
    setTimeout(() => (stop = true), 200);
    const r = await loop(["hall", "gym"], { until: Date.now() + 60_000, shouldStop: () => stop });
    expect(seams.firstSendAt.size).toBe(0);
    expect(r.ended).toBe("stopped");
    expect(r.cycles).toBe(0);
  });

  it(
    "a speaker that refuses the connection never holds the others",
    async () => {
      setModes({ hall: "ok", gym: "refused" }, { hall: 0, gym: 100 });
      const t0 = Date.now();
      // Short alert: the refused speaker is still in its first retry wait when
      // the deadline passes, so this ends without it.
      await loop(["hall", "gym"], { until: t0 + 100 + ARM_MS + 300 });
      // Hall started one arm delay after gym's refusal came back — not after
      // the sync window, and not after gym's retry.
      expect(seams.firstSendAt.get("hall")! - t0).toBeLessThan(100 + ARM_MS + 150);
    },
    12_000,
  );
});
