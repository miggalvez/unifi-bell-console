import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { pollFirmwareOnce } from "@/lib/health";
import { fakeProtectAdapter, seedSpeaker } from "./helpers";

// Direct delivery needs each speaker's own address, and only Protect's private
// bootstrap carries it. The hourly poll keeps it current so a bell never has
// to ask at bell time.

const host = (mac: string) => db.select().from(schema.speakers).where(eq(schema.speakers.mac, mac)).get()?.host;

beforeEach(() => {
  db.delete(schema.speakers).run();
});

describe("pollFirmwareOnce records speaker addresses", () => {
  it("stores the address Protect reports, matched by MAC", async () => {
    seedSpeaker("AA11BB22CC33", "Hall");
    seedSpeaker("AA11BB22CC44", "Gym");
    await pollFirmwareOnce(
      fakeProtectAdapter({
        bootstrap: vi.fn().mockResolvedValue({
          speakers: [
            { id: "x", mac: "aa:11:bb:22:cc:33", firmwareVersion: "1.0.6", host: "10.0.0.1" },
            { id: "y", mac: "AA11BB22CC44", host: "10.0.0.2" },
          ],
        }),
      }),
    );
    expect(host("AA11BB22CC33")).toBe("10.0.0.1");
    expect(host("AA11BB22CC44")).toBe("10.0.0.2");
  });

  it("follows a changed address and keeps the last one when Protect omits it", async () => {
    seedSpeaker("AA11BB22CC33", "Hall");
    const poll = (speaker: object) =>
      pollFirmwareOnce(fakeProtectAdapter({ bootstrap: vi.fn().mockResolvedValue({ speakers: [speaker] }) }));
    await poll({ id: "x", mac: "AA11BB22CC33", host: "10.0.0.9" });
    await poll({ id: "x", mac: "AA11BB22CC33", host: "10.0.0.1" });
    expect(host("AA11BB22CC33")).toBe("10.0.0.1");
    await poll({ id: "x", mac: "AA11BB22CC33" });
    expect(host("AA11BB22CC33")).toBe("10.0.0.1");
  });
});
