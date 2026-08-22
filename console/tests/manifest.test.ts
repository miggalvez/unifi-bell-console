import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("web app manifest", () => {
  const m = manifest();

  it("launches into the phone app and keeps sign-in inside the app window", () => {
    expect(m.id).toBe("/m");
    expect(m.start_url).toBe("/m");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("ships every icon it points at, with separate any and maskable entries", () => {
    const icons = m.icons ?? [];
    expect(icons.filter((i) => i.purpose === "maskable")).toHaveLength(1);
    expect(icons.filter((i) => i.purpose === "any").length).toBeGreaterThanOrEqual(2);
    for (const icon of icons) {
      expect(existsSync(path.join(process.cwd(), "public", icon.src))).toBe(true);
    }
  });
});
