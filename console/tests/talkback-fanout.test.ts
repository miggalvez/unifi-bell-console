import { describe, expect, it, vi } from "vitest";

// streamToSpeakers fans one encode out to one socket per speaker. These tests
// replace the three outside seams — ffmpeg, the Protect login, the talkback
// WebSocket — so what is under test is how per-speaker results are reported.

type Mode = "ok" | "refused" | "closes-before-audio" | "cut-off";

const seams = vi.hoisted(() => ({
  /** How each speaker's socket behaves, keyed by speaker id. Default "ok". */
  modes: new Map<string, Mode>(),
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

    constructor(url: string) {
      super();
      this.mode = seams.modes.get(new URL(url).searchParams.get("speaker")!) ?? "ok";
      setTimeout(() => {
        if (this.mode === "refused") {
          this.emit("unexpected-response", {}, { statusCode: 500 });
          return;
        }
        this.readyState = 1;
        this.emit("open");
        // The speaker hangs up during the arm delay, before any audio.
        if (this.mode === "closes-before-audio") this.readyState = 3;
      }, 0);
    }

    send(): void {
      this.sent++;
      if (this.mode === "cut-off" && this.sent >= 2) this.readyState = 3;
    }

    close(): void {
      this.readyState = 3;
    }
  }
  return { default: FakeSocket };
});

const { streamToSpeakers, TalkbackError } = await import("@/lib/protect/talkback");

function setModes(modes: Record<string, Mode>): void {
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
