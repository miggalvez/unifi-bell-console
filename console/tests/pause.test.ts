import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { db, schema } from "@/lib/db/client";
import { getSystemState, updateSystemState } from "@/lib/state";
import { seedUser } from "./helpers";
import { setPause } from "@/app/(console)/actions";

let userId: number;

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: userId, role: "ADMIN", displayName: "Tester" }),
}));

const NOW = DateTime.fromISO("2027-03-08T06:00", { zone: "America/Chicago" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW.toJSDate());
  updateSystemState({ pausedUntil: null, pauseReason: null, pausedBy: null, pausedAt: null });
  db.delete(schema.auditLog).run();
  db.delete(schema.users).run();
  userId = seedUser();
});

afterEach(() => vi.useRealTimers());

describe("schedule pause", () => {
  it("can resume at a specific school-clock time", async () => {
    const form = new FormData();
    form.set("reason", "Testing in progress");
    form.set("minutes", "until_time");
    form.set("pauseUntil", "07:15");

    const result = await setPause(form);

    expect(result.ok).toBe(true);
    expect(getSystemState().pausedUntil).toBe(
      DateTime.fromISO("2027-03-08T07:15", { zone: "America/Chicago" }).toMillis(),
    );
  });

  it("refuses a resume time that already passed", async () => {
    const form = new FormData();
    form.set("reason", "Testing in progress");
    form.set("minutes", "until_time");
    form.set("pauseUntil", "05:30");

    const result = await setPause(form);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Pick a time later today.");
    expect(getSystemState().pausedUntil).toBeNull();
  });
});
