import { afterEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db/client";
import { createSession } from "@/lib/auth/session";
import { seedUser } from "./helpers";

// A stand-in cookie jar. getApiUser reads the session token from it and, when
// the row is renewed, writes the new cookie back — the browser-facing half of
// the sliding session that never runs in a plain unit test otherwise.
const jar = new Map<string, string>();
const setSpy = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: unknown) => setSpy(name, value, options),
  }),
}));

// Imported after the mock so guards.ts + session.ts pick up the fake cookies().
const { getApiUser } = await import("@/lib/auth/guards");

const DAY = 86_400_000;

afterEach(() => {
  jar.clear();
  setSpy.mockClear();
});

describe("getApiUser cookie renewal", () => {
  it("re-issues the cookie only when the session row was renewed", async () => {
    const userId = seedUser();
    const { token } = createSession(userId);
    jar.set("bell_session", token);

    // Fresh session: most of the fortnight remains, so nothing is written back.
    expect((await getApiUser())?.id).toBe(userId);
    expect(setSpy).not.toHaveBeenCalled();

    // Age it past the half-life: this call renews the row and must push the
    // new expiry to the browser, or an installed app logs out at 14 days.
    db.update(schema.sessions).set({ expiresAt: Date.now() + 3 * DAY }).run();
    expect((await getApiUser())?.id).toBe(userId);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const [name, value, options] = setSpy.mock.calls[0];
    expect(name).toBe("bell_session");
    expect(value).toBe(token);
    expect((options as { expires: Date }).expires.getTime()).toBeGreaterThan(Date.now() + 13 * DAY);

    // The row is now renewed, so a subsequent poll is quiet again — the cookie
    // is not re-set on every /api/status hit.
    setSpy.mockClear();
    await getApiUser();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns null and writes nothing when there is no cookie", async () => {
    expect(await getApiUser()).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns null and writes nothing for a stale token", async () => {
    const userId = db.select().from(schema.users).get()!.id;
    const { token } = createSession(userId);
    jar.set("bell_session", token);
    db.update(schema.sessions).set({ expiresAt: Date.now() - 1 }).run();
    expect(await getApiUser()).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
  });
});
