import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/lib/db/client";
import { loadAnnouncementCues } from "@/lib/announcement-cues";

function seedCue(name: string, patch: Partial<typeof schema.soundCues.$inferInsert> = {}) {
  const now = Date.now();
  db.insert(schema.soundCues)
    .values({
      name,
      deliveryMethod: "PROTECT_WEBHOOK",
      webhookId: `wh.${name}`,
      ttsTone: "welcome",
      createdAt: now,
      updatedAt: now,
      ...patch,
    })
    .run();
}

beforeEach(() => {
  db.delete(schema.soundCues).run();
  db.delete(schema.zones).run();
});

describe("loadAnnouncementCues", () => {
  it("splits enabled cues into presets and emergencies, in tile order", () => {
    seedCue("Recess", { sortOrder: 2 });
    seedCue("Class change", { sortOrder: 1 });
    seedCue("Assembly", { sortOrder: 2 });
    seedCue("Lockdown", { isEmergency: true, sortOrder: 1 });
    seedCue("All clear", { isEmergency: true, sortOrder: 2 });
    seedCue("Old bell", { isEnabled: false });
    seedCue("Old alert", { isEmergency: true, isEnabled: false });

    const { presets, emergencies } = loadAnnouncementCues({ canEmergency: true });
    expect(presets.map((c) => c.name)).toEqual(["Class change", "Assembly", "Recess"]);
    expect(emergencies.map((c) => c.name)).toEqual(["Lockdown", "All clear"]);
  });

  it("hides emergency cues from people without the permission", () => {
    seedCue("Lockdown", { isEmergency: true });
    seedCue("Recess");
    const { presets, emergencies } = loadAnnouncementCues({ canEmergency: false });
    expect(presets.map((c) => c.name)).toEqual(["Recess"]);
    expect(emergencies).toEqual([]);
  });

  it("lists zones for the speaker picker", () => {
    db.insert(schema.zones).values({ name: "Outdoors", createdAt: Date.now() }).run();
    expect(loadAnnouncementCues({ canEmergency: false }).zones.map((z) => z.name)).toEqual(["Outdoors"]);
  });
});
