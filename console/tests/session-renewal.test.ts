import { describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db/client";
import { createSession, validateSessionDetailed } from "@/lib/auth/session";
import { seedUser } from "./helpers";

const DAY = 86_400_000;

describe("sliding session renewal", () => {
  it("reports a new expiry only when it actually moved", () => {
    const userId = seedUser();
    const { token, expiresAt } = createSession(userId);

    // Fresh: most of the fortnight remains, nothing to renew.
    expect(validateSessionDetailed(token)?.renewedExpiresAt).toBeUndefined();

    // Age it to three days left.
    const before = Date.now();
    db.update(schema.sessions).set({ expiresAt: before + 3 * DAY }).run();
    const renewed = validateSessionDetailed(token);
    expect(renewed?.user.id).toBe(userId);
    expect(renewed?.renewedExpiresAt).toBeGreaterThanOrEqual(before + 14 * DAY);
    expect(renewed?.renewedExpiresAt).toBeLessThanOrEqual(Date.now() + 14 * DAY);
    expect(renewed!.renewedExpiresAt!).toBeGreaterThan(expiresAt);

    // The row moved with it, and the next check is quiet again.
    expect(db.select().from(schema.sessions).get()?.expiresAt).toBe(renewed?.renewedExpiresAt);
    expect(validateSessionDetailed(token)?.renewedExpiresAt).toBeUndefined();
  });

  it("still rejects an expired session", () => {
    const { token } = createSession(db.select().from(schema.users).get()!.id);
    db.update(schema.sessions).set({ expiresAt: Date.now() - 1 }).run();
    expect(validateSessionDetailed(token)).toBeNull();
  });
});
