import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: fetchMock,
}));

import { Response } from "undici";
import { PrivateSession } from "@/lib/protect/private";

// What Protect 7.3.70 returns for the legacy dry run once the v2 Alarm
// Manager is on (observed 2026-11-02).
const REFUSED = '{"error":"This operation is not available when global alarm manager is enabled","name":"BAD_REQUEST"}';

type Reply = { status: number; body?: string };

/** Routes by path; login always succeeds. Returns the non-login calls. */
function protect(routes: Record<string, Reply[]>) {
  const calls: { path: string; body: unknown }[] = [];
  fetchMock.mockImplementation(async (url: string, init: { body?: string }) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/login") {
      return new Response("{}", { status: 200, headers: { "set-cookie": "TOKEN=t; Path=/" } });
    }
    calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = routes[path]?.shift();
    if (!reply) throw new Error(`unexpected call to ${path}`);
    return new Response(reply.status === 204 ? null : (reply.body ?? ""), { status: reply.status });
  });
  return calls;
}

const LEGACY = "/proxy/protect/api/automations/run";
const V2 = "/api/v2/alarms/protect/test";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("PrivateSession.speak", () => {
  it("uses the legacy dry run while Protect accepts it", async () => {
    const calls = protect({ [LEGACY]: [{ status: 200 }] });
    const r = await new PrivateSession("u", "p").speak("Hello", ["AA11BB22CC33"], "neutral");
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.path)).toEqual([LEGACY]);
  });

  it("moves to the v2 Alarm Manager dry run when the legacy one is refused, and stays there", async () => {
    const calls = protect({
      [LEGACY]: [{ status: 400, body: REFUSED }],
      [V2]: [{ status: 204 }, { status: 204 }],
    });
    const session = new PrivateSession("u", "p");

    const first = await session.speak("Announcement check", ["AA11BB22CC33", "DD44EE55FF66"], "neutral");
    expect(first).toMatchObject({ status: 204, detail: "" });
    expect(calls.map((c) => c.path)).toEqual([LEGACY, V2]);
    const body = calls[1].body as { actions_data: { id: string; data: unknown }[][] };
    expect(body.actions_data[0][0]).toMatchObject({
      id: "protect:sound.customMessage",
      data: { sources: ["AA11BB22CC33", "DD44EE55FF66"], text: "Announcement check", tone: "neutral" },
    });
    // An explicit empty target_ids list suppresses the sound action even
    // though data.sources names the intended speakers. Do not serialize it.
    expect(body.actions_data[0][0]).not.toHaveProperty("target_ids");

    await session.speak("Second", ["AA11BB22CC33"]);
    expect(calls.map((c) => c.path)).toEqual([LEGACY, V2, V2]);
  });

  it("reports other legacy rejections as they are, without trying v2", async () => {
    const calls = protect({ [LEGACY]: [{ status: 400, body: '{"name":"ZOD_PARSE_ERROR"}' }] });
    const r = await new PrivateSession("u", "p").speak("Hello", ["AA11BB22CC33"]);
    expect(r).toMatchObject({ status: 400, detail: '{"name":"ZOD_PARSE_ERROR"}' });
    expect(calls.map((c) => c.path)).toEqual([LEGACY]);
  });

  it("keeps the v2 rejection text for the run log", async () => {
    protect({
      [LEGACY]: [{ status: 400, body: REFUSED }],
      [V2]: [{ status: 400, body: "Alarm validation issues: [] has less than 1 item" }],
    });
    const r = await new PrivateSession("u", "p").speak("Hello", []);
    expect(r).toMatchObject({ status: 400, detail: "Alarm validation issues: [] has less than 1 item" });
  });
});
