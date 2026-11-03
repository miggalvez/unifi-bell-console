import { describe, expect, it } from "vitest";
import { speakerHealth } from "@/lib/speaker-health";

describe("speakerHealth", () => {
  it("is Working only when the system answers and every speaker is online", () => {
    expect(speakerHealth({ reachable: true, online: 4, total: 4 })).toEqual({
      state: "working",
      label: "Working",
      tone: "ok",
    });
  });

  it("is Degraded, not Working, when some speakers are offline", () => {
    expect(speakerHealth({ reachable: true, online: 2, total: 4 })).toEqual({
      state: "degraded",
      label: "Degraded",
      tone: "warning",
    });
  });

  it("is critical when no speaker is online", () => {
    expect(speakerHealth({ reachable: true, online: 0, total: 4 })).toMatchObject({ state: "offline", tone: "critical" });
  });

  it("an unreachable system outranks the speakers' last known state", () => {
    expect(speakerHealth({ reachable: false, online: 4, total: 4 })).toMatchObject({
      state: "unreachable",
      label: "Not responding",
      tone: "critical",
    });
  });

  it("says so when no speakers have been discovered", () => {
    expect(speakerHealth({ reachable: true, online: 0, total: 0 })).toMatchObject({ state: "none", tone: "warning" });
  });
});
