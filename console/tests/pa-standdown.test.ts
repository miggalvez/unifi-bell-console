import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db/client";
import { updateSystemState } from "@/lib/state";
import { alertOrDrillActive, reasonPaIsNeeded } from "@/lib/pa-standdown";
import { insertClaimedRun, seedWebhookCue } from "./helpers";

// A diagnostic that makes noise asks this before every tone. It only reads:
// stopping an alert or clearing the lock is never a diagnostic's call.

const WINDOW = 5 * 60_000;

beforeEach(() => {
  db.delete(schema.scheduledRuns).run();
  updateSystemState({ speakerBusyUntil: null, alertCueId: null, alertUntil: null, drillSequenceId: null, drillUntil: null });
});

describe("reasonPaIsNeeded", () => {
  it("an idle PA with nothing due: clear", () => {
    expect(reasonPaIsNeeded(WINDOW)).toBeNull();
    expect(alertOrDrillActive()).toBeNull();
  });

  it("an emergency alert is sounding", () => {
    updateSystemState({ alertCueId: seedWebhookCue("Lockdown"), alertUntil: Date.now() + 60_000 });
    expect(reasonPaIsNeeded(WINDOW)).toMatch(/alert is sounding/);
    expect(alertOrDrillActive()).toMatch(/alert is sounding/);
  });

  it("another cue holds the speaker lock — and asking leaves the lock alone", () => {
    const until = Date.now() + 9_000;
    updateSystemState({ speakerBusyUntil: until });
    expect(reasonPaIsNeeded(WINDOW)).toMatch(/in use/);
    expect(db.select().from(schema.systemState).get()!.speakerBusyUntil).toBe(until);
  });

  it("a cue is mid-delivery", () => {
    insertClaimedRun({ status: "EXECUTING", cueName: "Passing bell" });
    expect(reasonPaIsNeeded(WINDOW)).toBe("Passing bell is playing");
  });

  it("a bell is due inside the window, but not one after it", () => {
    const now = Date.now();
    const pending = { status: "PENDING" as const, claimedAt: null, source: "SCHEDULE" as const, cueName: "School Bell" };
    insertClaimedRun({ ...pending, scheduledAtUtc: now + WINDOW + 60_000, localTime: "15:10" });
    expect(reasonPaIsNeeded(WINDOW, now)).toBeNull();
    insertClaimedRun({ ...pending, scheduledAtUtc: now + 120_000, localTime: "14:20" });
    expect(reasonPaIsNeeded(WINDOW, now)).toBe("School Bell is due at 14:20");
  });
});
