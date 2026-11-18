import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: fetchMock,
}));

import { Response } from "undici";
import { PrivateSession } from "@/lib/protect/private";

// A bell opens one talkback socket per speaker, all at once, and each asks the
// session for its cookie. The console answers sign-ins one after another, so
// four of them meant four speakers starting up to a second apart.

/** Each sign-in takes `ms` and hands out TOKEN=1, TOKEN=2, … */
function slowLogin(ms: number): { logins: () => number } {
  let n = 0;
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/login") {
      const token = ++n;
      await new Promise((r) => setTimeout(r, ms));
      return new Response("{}", { status: 200, headers: { "set-cookie": `TOKEN=${token}; Path=/` } });
    }
    throw new Error(`unexpected call to ${path}`);
  });
  return { logins: () => n };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("PrivateSession sign-in is shared", () => {
  it("four sockets asking a cold session at once cause one sign-in, and get one cookie", async () => {
    const { logins } = slowLogin(30);
    const session = new PrivateSession("u", "p");
    const got = await Promise.all([1, 2, 3, 4].map(() => session.authHeaders()));
    expect(logins()).toBe(1);
    expect(new Set(got.map((g) => g.cookie))).toEqual(new Set(["TOKEN=1"]));
  });

  it("four sockets refused for the same expired cookie share one fresh sign-in", async () => {
    const { logins } = slowLogin(30);
    const session = new PrivateSession("u", "p");
    const stale = (await session.authHeaders()).cookie;
    // Each socket's 401 lands a little after the last — the fourth arrives
    // once the fresh sign-in has already finished.
    const renewed = await Promise.all(
      [0, 5, 10, 60].map(async (afterMs) => {
        await new Promise((r) => setTimeout(r, afterMs));
        session.invalidate(stale);
        return (await session.authHeaders()).cookie;
      }),
    );
    expect(logins()).toBe(2); // the original, and exactly one renewal
    expect(new Set(renewed)).toEqual(new Set(["TOKEN=2"]));
  });

  it("a failed sign-in is not remembered: the next caller tries again", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n++;
      return n === 1
        ? new Response("rate limited", { status: 429 })
        : new Response("{}", { status: 200, headers: { "set-cookie": "TOKEN=ok; Path=/" } });
    });
    const session = new PrivateSession("u", "p");
    await expect(session.authHeaders()).rejects.toThrow(/HTTP 429/);
    expect((await session.authHeaders()).cookie).toBe("TOKEN=ok");
  });

  it("invalidate() with no argument still drops the session outright", async () => {
    const { logins } = slowLogin(1);
    const session = new PrivateSession("u", "p");
    await session.authHeaders();
    session.invalidate();
    await session.authHeaders();
    expect(logins()).toBe(2);
  });
});
