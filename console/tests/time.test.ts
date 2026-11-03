import { afterEach, describe, expect, it } from "vitest";
import { Settings } from "luxon";
import { localToUtcEpoch } from "@/lib/scheduler/time";

// Luxon resolves ambiguous local times with the zone offset at the moment the
// process first parses a date, and caches it. Pretend the process started in
// each season and check the answer no longer depends on it.
const realNow = Settings.now;
function processStartedAt(iso: string): void {
  Settings.now = () => Date.parse(iso);
  Settings.resetCaches();
}

afterEach(() => {
  Settings.now = realNow;
  Settings.resetCaches();
});

describe.each([
  ["daylight time", "2026-08-15T12:00:00Z"],
  ["standard time", "2026-12-15T12:00:00Z"],
])("localToUtcEpoch, process started during %s", (_season, startedAt) => {
  it("resolves fall-back's repeated hour to its first occurrence (CDT)", () => {
    processStartedAt(startedAt);
    expect(localToUtcEpoch("2027-11-07", "01:00")).toBe(Date.parse("2027-11-07T06:00:00Z"));
    expect(localToUtcEpoch("2027-11-07", "01:30")).toBe(Date.parse("2027-11-07T06:30:00Z"));
    expect(localToUtcEpoch("2027-11-07", "01:59")).toBe(Date.parse("2027-11-07T06:59:00Z"));
  });

  it("leaves the times either side of the repeated hour alone", () => {
    processStartedAt(startedAt);
    expect(localToUtcEpoch("2027-11-07", "00:59")).toBe(Date.parse("2027-11-07T05:59:00Z"));
    expect(localToUtcEpoch("2027-11-07", "02:00")).toBe(Date.parse("2027-11-07T08:00:00Z"));
  });

  it("still maps spring-forward's missing hour forward", () => {
    processStartedAt(startedAt);
    expect(localToUtcEpoch("2027-03-14", "02:30")).toBe(Date.parse("2027-03-14T08:30:00Z"));
  });
});
