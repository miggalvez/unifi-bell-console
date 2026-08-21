import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { PUBLIC_EXACT, isPublicPath } from "@/lib/auth/routing";

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
}

// Paths the install depends on, plus one of each prefix family.
const PUBLIC_SAMPLES = [
  ...PUBLIC_EXACT,
  "/icons/icon-192.png",
  "/api/status",
  "/_next/static/chunks/main.js",
  "/_next/image",
];

describe("proxy", () => {
  it("sends a visitor without a cookie to login, remembering where they were going", () => {
    const res = proxy(request("/m?x=1"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/m?x=1");
  });

  it("lets a visitor with a cookie through", () => {
    const res = proxy(request("/m", "bell_session=abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("never redirects away from the login page, cookie or not", () => {
    // A stale cookie must reach the login form; bouncing it to "/" would loop
    // with requireUser(), and an installed app has no address bar to escape.
    expect(proxy(request("/login")).headers.get("location")).toBeNull();
    expect(proxy(request("/login", "bell_session=stale")).headers.get("location")).toBeNull();
  });

  it.each(PUBLIC_SAMPLES)("serves %s without a session", (path) => {
    expect(isPublicPath(path)).toBe(true);
    expect(proxy(request(path)).headers.get("location")).toBeNull();
  });
});

describe("proxy matcher", () => {
  // Next compiles the matcher with path-to-regexp; for a single negative
  // lookahead group this is equivalent.
  const matcher = new RegExp(`^${config.matcher[0]}/?$`);

  it.each(PUBLIC_SAMPLES)("does not run for %s", (path) => {
    expect(matcher.test(path)).toBe(false);
  });

  it.each(["/", "/m", "/login", "/announcements", "/plans/3"])("still runs for %s", (path) => {
    expect(matcher.test(path)).toBe(true);
  });
});
