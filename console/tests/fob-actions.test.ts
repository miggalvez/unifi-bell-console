import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { seedFob, seedTtsCue, seedUser } from "./helpers";
import { getSetting, getSystemState, updateSystemState } from "@/lib/state";
import { FOB_BASE_URL_KEY } from "@/lib/fobs/provision";
import { getFobServiceUserId } from "@/lib/fobs/service-user";

let adminId: number;

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: adminId, role: "ADMIN", displayName: "Tester" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
// The inline reconcile nudge talks to the NVR; these tests exercise the
// actions' own validation, so stub just that call and keep the rest real.
vi.mock("@/lib/fobs/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fobs/provision")>()),
  reconcileFobAlarms: vi.fn(async () => ({ ran: true, supported: true, created: 0, deleted: 0, errors: 0 })),
}));

import {
  createFobMapping,
  deleteFobMapping,
  setFobBaseUrl,
  setFobMappingEnabled,
  updateFobMapping,
} from "@/app/(console)/remotes/actions";
import { resetUserPassword, updateUser } from "@/app/(console)/settings/actions";

const MAC = "AABBCCDDEE01";

function emergencyCue(name = "Lockdown"): number {
  const now = Date.now();
  return db
    .insert(schema.soundCues)
    .values({
      name,
      deliveryMethod: "PROTECT_NATIVE_TTS",
      ttsText: "Lockdown",
      ttsTone: "welcome",
      isEmergency: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.soundCues.id })
    .get().id;
}

const validCreate = (over: Partial<Parameters<typeof createFobMapping>[0]> = {}) => ({
  fobMac: MAC,
  button: "panic" as const,
  pressType: "longPress" as const,
  action: "START_ALERT" as const,
  cueId: null as number | null,
  repeatSeconds: null as number | null,
  ...over,
});

beforeEach(() => {
  db.delete(schema.auditLog).run();
  db.delete(schema.fobMappings).run();
  db.delete(schema.fobs).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.sessions).run();
  db.delete(schema.users).run();
  db.delete(schema.settings).run();
  updateSystemState({ fobReprovisionFlag: false, fobProvisionLockUntil: null });
  adminId = seedUser();
  seedFob();
});

describe("setFobBaseUrl", () => {
  it("stores a valid LAN address and raises the reprovision flag", async () => {
    const fd = new FormData();
    fd.set("baseUrl", "http://192.168.1.50:3000/");
    const r = await setFobBaseUrl(fd);
    expect(r.ok).toBe(true);
    expect(getSetting<string | null>(FOB_BASE_URL_KEY, null)).toBe("http://192.168.1.50:3000");
    expect(getSystemState().fobReprovisionFlag).toBe(true);
  });

  it("refuses localhost", async () => {
    const fd = new FormData();
    fd.set("baseUrl", "http://localhost:3000");
    const r = await setFobBaseUrl(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("LAN");
  });
});

describe("createFobMapping", () => {
  it("creates a valid emergency mapping and flags a reconcile", async () => {
    const cueId = emergencyCue();
    const r = await createFobMapping(validCreate({ cueId }));
    expect(r).toEqual({ ok: true });
    const row = db.select().from(schema.fobMappings).get()!;
    expect(row.provisionState).toBe("PENDING");
    expect(getSystemState().fobReprovisionFlag).toBe(true);
  });

  it("refuses a single press for an emergency alert", async () => {
    const cueId = emergencyCue();
    const r = await createFobMapping(validCreate({ cueId, pressType: "press" }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("long press or double press");
  });

  it("refuses a non-emergency cue for START_ALERT", async () => {
    const cueId = seedTtsCue();
    const r = await createFobMapping(validCreate({ cueId }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("emergency");
  });

  it("requires a cue for playback actions and strips it for STOP_ALERT", async () => {
    const none = await createFobMapping(validCreate({ action: "TRIGGER_CUE" }));
    expect(none.ok).toBe(false);

    const cueId = emergencyCue();
    const stop = await createFobMapping(validCreate({ action: "STOP_ALERT", cueId, pressType: "press" }));
    expect(stop.ok).toBe(true);
    expect(db.select().from(schema.fobMappings).get()!.cueId).toBeNull();
  });

  it("enforces repeat bounds", async () => {
    const cueId = emergencyCue();
    const r = await createFobMapping(validCreate({ cueId, repeatSeconds: 5 }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("10–300");
  });

  it("reports an already-mapped slot in plain words", async () => {
    const cueId = emergencyCue();
    expect((await createFobMapping(validCreate({ cueId }))).ok).toBe(true);
    const dup = await createFobMapping(validCreate({ cueId }));
    expect(dup.ok).toBe(false);
    expect(dup.error).toContain("already mapped");
  });

  it("rejects a malformed MAC", async () => {
    const cueId = emergencyCue();
    const r = await createFobMapping(validCreate({ cueId, fobMac: "not-a-mac" }));
    expect(r.ok).toBe(false);
  });
});

describe("editing mappings", () => {
  it("updates in place with the same validation", async () => {
    const cueId = emergencyCue();
    await createFobMapping(validCreate({ cueId }));
    const id = db.select().from(schema.fobMappings).get()!.id;

    const bad = await updateFobMapping(id, {
      button: "panic",
      pressType: "press",
      action: "START_ALERT",
      cueId,
      repeatSeconds: null,
    });
    expect(bad.ok).toBe(false);

    const good = await updateFobMapping(id, {
      button: "arm",
      pressType: "doublePress",
      action: "START_ALERT",
      cueId,
      repeatSeconds: 30,
    });
    expect(good.ok).toBe(true);
    const row = db.select().from(schema.fobMappings).get()!;
    expect(row.button).toBe("arm");
    expect(row.repeatSeconds).toBe(30);
  });

  it("toggles enabled with a strict boolean and deletes cleanly", async () => {
    const cueId = emergencyCue();
    await createFobMapping(validCreate({ cueId }));
    const id = db.select().from(schema.fobMappings).get()!.id;

    expect((await setFobMappingEnabled(id, false)).ok).toBe(true);
    expect(db.select().from(schema.fobMappings).get()!.isEnabled).toBe(false);
    expect((await setFobMappingEnabled(id, "yes" as unknown as boolean)).ok).toBe(false);

    expect((await deleteFobMapping(id)).ok).toBe(true);
    expect(db.select().from(schema.fobMappings).all()).toHaveLength(0);
  });
});

describe("the service user stays locked down", () => {
  it("cannot be edited or given a password through the settings actions", async () => {
    const serviceId = getFobServiceUserId();
    const edit = await updateUser(serviceId, { canEmergency: false });
    expect(edit.ok).toBe(false);
    expect(edit.error).toContain("managed by the system");

    const reset = await resetUserPassword(serviceId, "password123");
    expect(reset.ok).toBe(false);
    // And the hash is untouched — still the unloggable sentinel.
    const row = db.select().from(schema.users).where(eq(schema.users.id, serviceId)).get()!;
    expect(row.passwordHash).toBe("*fob*");
  });
});
