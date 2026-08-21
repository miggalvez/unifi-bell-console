import { describe, expect, it } from "vitest";
import { isPublicPath, safeNextPath } from "@/lib/auth/routing";

describe("safeNextPath", () => {
  it.each([
    ["/m", "/m"],
    ["/m?x=1", "/m?x=1"],
    ["/plans/3", "/plans/3"],
  ])("keeps a same-origin path %s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["m"],
    ["//evil.com"],
    ["/\\evil.com"],
    ["https://evil.com/m"],
    ["javascript:alert(1)"],
    ["/login"],
    ["/login?next=/m"],
    ["/m\nSet-Cookie: x"],
    ["/" + "a".repeat(600)],
  ])("falls back to / for %s", (raw) => {
    expect(safeNextPath(raw)).toBe("/");
  });

  it("drops a fragment but keeps the query", () => {
    expect(safeNextPath("/m?tab=1#top")).toBe("/m?tab=1");
  });
});

describe("isPublicPath", () => {
  it("recognises the install files and API routes", () => {
    for (const p of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/icons/icon-192.png", "/api/status", "/apple-icon.png", "/icon.png"]) {
      expect(isPublicPath(p)).toBe(true);
    }
  });
  it("keeps pages private", () => {
    for (const p of ["/", "/m", "/login", "/icons", "/announcements", "/sw.json"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });
});
