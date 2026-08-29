import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { fakeProtectAdapter, seedFob, seedFobMapping, seedSpeaker, seedTtsCue } from "./helpers";
import { updateSystemState, getSystemState } from "@/lib/state";
import { startAlert } from "@/lib/alerts";
import { getFobServiceUserId, FOB_SERVICE_USERNAME } from "@/lib/fobs/service-user";
import { verifyPassword } from "@/lib/auth/password";
import { sha256hex } from "@/lib/fobs/provision";
import {
  FOB_DEDUPE_MS,
  claimFobPress,
  dispatchFobPress,
  verifyFobToken,
} from "@/lib/fobs/dispatch";

const TOKEN = "super-secret-token";

function seedEmergencyCue(name = "Lockdown"): number {
  const now = Date.now();
  return db
    .insert(schema.soundCues)
    .values({
      name,
      deliveryMethod: "PROTECT_NATIVE_TTS",
      ttsText: "Lockdown now",
      ttsTone: "welcome",
      isEmergency: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.soundCues.id })
    .get().id;
}

function audits(action: string) {
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).all();
}

beforeEach(() => {
  // The alert block references sound_cues; clear it before deleting cue rows.
  updateSystemState({
    alertCueId: null,
    alertStartedAt: null,
    alertStartedBy: null,
    alertRepeatSeconds: null,
    alertUntil: null,
    alertLastPlayedAt: null,
    drillSequenceId: null,
    speakerBusyUntil: null,
  });
  db.delete(schema.auditLog).run();
  db.delete(schema.scheduledRuns).run();
  db.delete(schema.fobMappings).run();
  db.delete(schema.fobs).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.sessions).run();
  db.delete(schema.users).run();
  db.delete(schema.settings).run();
  db.delete(schema.speakers).run();
  seedFob();
});

describe("the service user", () => {
  it("is created once, reused after, and can never log in", async () => {
    const id = getFobServiceUserId();
    expect(getFobServiceUserId()).toBe(id);
    const row = db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;
    expect(row.username).toBe(FOB_SERVICE_USERNAME);
    expect(row.canEmergency).toBe(true);
    // The sentinel hash is not scrypt$… — no password can ever verify.
    await expect(verifyPassword("anything", row.passwordHash)).resolves.toBe(false);
    await expect(verifyPassword(row.passwordHash, row.passwordHash)).resolves.toBe(false);
  });
});

describe("verifyFobToken", () => {
  it("accepts only the exact token", () => {
    const mapping = { tokenHash: sha256hex(TOKEN) };
    expect(verifyFobToken(mapping, TOKEN)).toBe(true);
    expect(verifyFobToken(mapping, "wrong")).toBe(false);
    expect(verifyFobToken(mapping, null)).toBe(false);
    expect(verifyFobToken({ tokenHash: null }, TOKEN)).toBe(false);
  });
});

describe("claimFobPress", () => {
  it("lets exactly one press through per window", () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const now = Date.now();
    expect(claimFobPress(id, now)).toBe(true);
    expect(claimFobPress(id, now + 10)).toBe(false);
    expect(claimFobPress(id, now + FOB_DEDUPE_MS)).toBe(true);
  });
});

describe("dispatchFobPress", () => {
  it("404s an unknown mapping and 401s a bad token, both audited", async () => {
    const adapter = fakeProtectAdapter();
    expect((await dispatchFobPress(adapter, 999, TOKEN)).kind).toBe("unknown");

    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId, tokenHash: sha256hex(TOKEN) });
    expect((await dispatchFobPress(adapter, id, "wrong")).kind).toBe("unauthorized");
    expect(audits("fob.press_rejected")).toHaveLength(1);
  });

  it("answers 'disabled' for a real press on a switched-off mapping", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({
      action: "TRIGGER_CUE",
      cueId,
      tokenHash: sha256hex(TOKEN),
      isEnabled: false,
    });
    const r = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN);
    expect(r.kind).toBe("disabled");
  });

  it("suppresses the second press inside the dedupe window", async () => {
    const id = seedFobMapping({ action: "STOP_ALERT", cueId: null, tokenHash: sha256hex(TOKEN) });
    const adapter = fakeProtectAdapter();
    const now = Date.now();
    expect((await dispatchFobPress(adapter, id, TOKEN, now)).kind).toBe("accepted");
    expect((await dispatchFobPress(adapter, id, TOKEN, now + 100)).kind).toBe("duplicate");
  });

  it("STOP_ALERT silences an active alert as the service user", async () => {
    const cueId = seedEmergencyCue();
    startAlert({ cueId, userId: getFobServiceUserId() });
    expect(getSystemState().alertCueId).toBe(cueId);

    const id = seedFobMapping({ action: "STOP_ALERT", cueId: null, tokenHash: sha256hex(TOKEN) });
    const r = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN);
    expect(r.kind).toBe("accepted");
    expect(getSystemState().alertCueId).toBeNull();
    expect(audits("fob.press")).toHaveLength(1);
  });

  it("START_ALERT starts the alert attributed to the service user, repeat floored", async () => {
    const cueId = seedEmergencyCue();
    const id = seedFobMapping({
      action: "START_ALERT",
      cueId,
      repeatSeconds: 10, // below the cue's own length floor
      tokenHash: sha256hex(TOKEN),
    });
    const r = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN);
    expect(r.kind).toBe("accepted");
    const s = getSystemState();
    expect(s.alertCueId).toBe(cueId);
    expect(s.alertStartedBy).toBe(getFobServiceUserId());
    expect(s.alertRepeatSeconds).toBeGreaterThanOrEqual(10);
  });

  it("a re-press of the same alert is a no-op, not a restart", async () => {
    const cueId = seedEmergencyCue();
    const id = seedFobMapping({ action: "START_ALERT", cueId, tokenHash: sha256hex(TOKEN) });
    const first = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN);
    expect(first.kind).toBe("accepted");
    const startedAt = getSystemState().alertStartedAt;

    const again = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN, Date.now() + FOB_DEDUPE_MS + 1);
    expect(again).toMatchObject({ kind: "accepted", note: "already active" });
    expect(getSystemState().alertStartedAt).toBe(startedAt);
  });

  it("rejects START_ALERT on a non-emergency or disabled cue", async () => {
    const plainCue = seedTtsCue();
    const id = seedFobMapping({ action: "START_ALERT", cueId: plainCue, tokenHash: sha256hex(TOKEN) });
    const r = await dispatchFobPress(fakeProtectAdapter(), id, TOKEN);
    expect(r.kind).toBe("rejected");
    expect(getSystemState().alertCueId).toBeNull();

    const offCue = seedEmergencyCue("Off cue");
    db.update(schema.soundCues).set({ isEnabled: false }).where(eq(schema.soundCues.id, offCue)).run();
    const id2 = seedFobMapping({ button: "arm", action: "START_ALERT", cueId: offCue, tokenHash: sha256hex(TOKEN) });
    expect((await dispatchFobPress(fakeProtectAdapter(), id2, TOKEN)).kind).toBe("rejected");
  });

  it("TRIGGER_CUE plays the cue as the service user", async () => {
    seedSpeaker("AABBCCDDEEFF");
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId, tokenHash: sha256hex(TOKEN) });
    const adapter = fakeProtectAdapter();

    const r = await dispatchFobPress(adapter, id, TOKEN);
    expect(r.kind).toBe("accepted");
    // Playback is fire-and-forget; wait for the run row it inserts.
    await vi.waitFor(() => {
      const run = db.select().from(schema.scheduledRuns).get();
      expect(run).toBeDefined();
      expect(run!.source).toBe("MANUAL");
      expect(run!.requestedBy).toBe(getFobServiceUserId());
    });
  });

  it("TRIGGER_CUE of a routine cue is blocked while an alert sounds; emergency one-shots are not", async () => {
    const alertCue = seedEmergencyCue();
    startAlert({ cueId: alertCue, userId: getFobServiceUserId() });

    const routine = seedTtsCue();
    const idRoutine = seedFobMapping({ action: "TRIGGER_CUE", cueId: routine, tokenHash: sha256hex(TOKEN) });
    const blocked = await dispatchFobPress(fakeProtectAdapter(), idRoutine, TOKEN);
    expect(blocked.kind).toBe("rejected");

    seedSpeaker("AABBCCDDEEFF");
    const oneShot = seedEmergencyCue("Evacuate");
    const idEmergency = seedFobMapping({
      button: "arm",
      action: "TRIGGER_CUE",
      cueId: oneShot,
      tokenHash: sha256hex(TOKEN),
    });
    const r = await dispatchFobPress(fakeProtectAdapter(), idEmergency, TOKEN);
    expect(r.kind).toBe("accepted");
    await vi.waitFor(() => {
      const run = db.select().from(schema.scheduledRuns).get();
      expect(run).toBeDefined();
      expect(run!.source).toBe("EMERGENCY");
    });
  });
});
