import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { fakeProtectAdapter, seedFob, seedFobMapping, seedTtsCue } from "./helpers";
import { getSystemState, setSetting, updateSystemState } from "@/lib/state";
import {
  FOB_ALARM_TITLE_PREFIX,
  FOB_BASE_URL_KEY,
  FOB_TRIGGER_ID,
  buildAlarmTitle,
  buildScopeValue,
  buildWebhookUrl,
  desiredConfigHash,
  reconcileFobAlarms,
  sha256hex,
  validateBaseUrl,
} from "@/lib/fobs/provision";
import { PrivateSession, type AlarmCreateSpec } from "@/lib/protect/private";

const MAC = "AABBCCDDEE01";
const BASE = "http://192.168.1.50:3000";

function mappingRow(id: number) {
  return db.select().from(schema.fobMappings).where(eq(schema.fobMappings.id, id)).get()!;
}

beforeEach(() => {
  db.delete(schema.fobMappings).run();
  db.delete(schema.fobs).run();
  db.delete(schema.soundCues).run();
  db.delete(schema.settings).run();
  db.delete(schema.auditLog).run();
  updateSystemState({
    fobReprovisionFlag: false,
    fobProvisionLockUntil: null,
    fobLastReconcileAt: null,
    fobLastReconcileError: null,
  });
  setSetting(FOB_BASE_URL_KEY, BASE);
});

describe("builders", () => {
  it("builds titles inside the ownership prefix, unique per mapping", () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const title = buildAlarmTitle(mappingRow(id), "Front Office");
    expect(title.startsWith(FOB_ALARM_TITLE_PREFIX)).toBe(true);
    expect(title).toContain("Front Office");
    expect(title).toContain(`[#${id}]`);
    // Falls back to the MAC when the fob has no name.
    expect(buildAlarmTitle(mappingRow(id), null)).toContain(MAC);
  });

  it("builds the scope token the NVR's catalogue uses", () => {
    expect(buildScopeValue({ fobMac: MAC, button: "panic" })).toBe(`${MAC}:button=panic`);
  });

  it("builds webhook URLs without double slashes", () => {
    expect(buildWebhookUrl("http://x:3000/", 7)).toBe("http://x:3000/api/fob-hooks/7");
    expect(buildWebhookUrl("http://x:3000", 7)).toBe("http://x:3000/api/fob-hooks/7");
  });

  it("changes the desired hash only for NVR-side fields", () => {
    const m = { fobMac: MAC, button: "panic" as const, pressType: "longPress" as const };
    const base = desiredConfigHash(m, BASE);
    expect(desiredConfigHash(m, BASE)).toBe(base);
    expect(desiredConfigHash({ ...m, pressType: "press" }, BASE)).not.toBe(base);
    expect(desiredConfigHash(m, "http://elsewhere:3000")).not.toBe(base);
  });

  it.each([
    ["http://192.168.1.50:3000", true],
    ["https://bells.school.lan", true],
    ["http://localhost:3000", false],
    ["http://127.0.0.1:3000", false],
    ["http://[::1]:3000", false],
    ["not a url", false],
    ["ftp://192.168.1.50", false],
    ["http://192.168.1.50:3000/?x=1", false],
  ])("validateBaseUrl(%s) -> %s", (raw, ok) => {
    expect(validateBaseUrl(raw).ok).toBe(ok);
  });

  it("normalizes a trailing slash away", () => {
    const r = validateBaseUrl("http://192.168.1.50:3000/");
    expect(r).toEqual({ ok: true, value: "http://192.168.1.50:3000" });
  });
});

describe("reconcileFobAlarms", () => {
  it("creates an alarm for an enabled mapping and records token + hashes", async () => {
    seedFob(MAC, "Front Office");
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId, pressType: "press" });
    const adapter = fakeProtectAdapter();

    const r = await reconcileFobAlarms(adapter);
    expect(r).toMatchObject({ ran: true, supported: true, created: 1, deleted: 0, errors: 0 });

    const spec = vi.mocked(adapter.createAlarm).mock.calls[0][0];
    expect(spec.title).toBe(`${FOB_ALARM_TITLE_PREFIX}Front Office — Panic (single press) [#${id}]`);
    expect(spec.pressType).toBe("press");
    expect(spec.scopeValue).toBe(`${MAC}:button=panic`);
    expect(spec.webhook.url).toBe(`${BASE}/api/fob-hooks/${id}`);

    const row = mappingRow(id);
    expect(row.provisionState).toBe("OK");
    expect(row.nvrAlarmId).toBe("alarm-id-1");
    expect(row.tokenHash).toBe(sha256hex(spec.webhook.token));
    expect(row.desiredHash).toBe(desiredConfigHash(row, BASE));
    expect(getSystemState().fobReprovisionFlag).toBe(false);
  });

  it("is a no-op when the alarm already matches, and recreates on base URL change", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const adapter = fakeProtectAdapter();
    await reconcileFobAlarms(adapter);
    const alarmId = mappingRow(id).nvrAlarmId!;

    vi.mocked(adapter.listAlarms).mockResolvedValue([
      { id: alarmId, title: `${FOB_ALARM_TITLE_PREFIX}x [#${id}]`, raw: {} },
    ]);
    const second = await reconcileFobAlarms(adapter);
    expect(second).toMatchObject({ created: 0, deleted: 0 });
    expect(vi.mocked(adapter.createAlarm)).toHaveBeenCalledTimes(1);

    setSetting(FOB_BASE_URL_KEY, "http://192.168.1.99:3000");
    const third = await reconcileFobAlarms(adapter);
    expect(third).toMatchObject({ created: 1, deleted: 1 });
    expect(vi.mocked(adapter.deleteAlarm)).toHaveBeenCalledWith(alarmId);
  });

  it("recreates when the NVR-side config was edited by hand", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId, pressType: "longPress" });
    const adapter = fakeProtectAdapter();
    await reconcileFobAlarms(adapter);
    const alarmId = mappingRow(id).nvrAlarmId!;

    vi.mocked(adapter.listAlarms).mockResolvedValue([
      {
        id: alarmId,
        title: `${FOB_ALARM_TITLE_PREFIX}x [#${id}]`,
        raw: {
          trigger_categories: [{ triggers: [{ data: { pressType: "press" } }] }],
          scope: { data: { scope_all_buttons: [`${MAC}:button=panic`] } },
        },
      },
    ]);
    const r = await reconcileFobAlarms(adapter);
    expect(r).toMatchObject({ created: 1, deleted: 1 });
  });

  it("sweeps orphaned console-owned alarms and never touches foreign ones", async () => {
    const adapter = fakeProtectAdapter({
      listAlarms: vi.fn().mockResolvedValue([
        { id: "stray", title: `${FOB_ALARM_TITLE_PREFIX}left over [#999]`, raw: {} },
        { id: "theirs", title: "Ring doorbell notification", raw: {} },
      ]),
    });
    const r = await reconcileFobAlarms(adapter);
    expect(r.deleted).toBe(1);
    expect(vi.mocked(adapter.deleteAlarm)).toHaveBeenCalledWith("stray");
    expect(vi.mocked(adapter.deleteAlarm)).not.toHaveBeenCalledWith("theirs");
  });

  it("marks everything UNSUPPORTED and cleans up when the trigger is absent", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId, nvrAlarmId: "old", tokenHash: "x" });
    const adapter = fakeProtectAdapter({
      alarmManifestTriggerIds: vi.fn().mockResolvedValue(["protect:ai.nls"]),
      listAlarms: vi.fn().mockResolvedValue([{ id: "old", title: `${FOB_ALARM_TITLE_PREFIX}x [#${id}]`, raw: {} }]),
    });
    const r = await reconcileFobAlarms(adapter);
    expect(r.supported).toBe(false);
    expect(r.deleted).toBe(1);
    const row = mappingRow(id);
    expect(row.provisionState).toBe("UNSUPPORTED");
    expect(row.nvrAlarmId).toBeNull();
  });

  it("records a global error and keeps the flag set when the NVR is unreachable", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const adapter = fakeProtectAdapter({
      alarmManifestTriggerIds: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });
    const r = await reconcileFobAlarms(adapter);
    expect(r.errors).toBe(1);
    const s = getSystemState();
    expect(s.fobLastReconcileError).toContain("fetch failed");
    expect(s.fobReprovisionFlag).toBe(true);
    expect(mappingRow(id).provisionState).toBe("PENDING"); // untouched
  });

  it("asks for the console address before provisioning anything", async () => {
    db.delete(schema.settings).run();
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const adapter = fakeProtectAdapter();
    const r = await reconcileFobAlarms(adapter);
    expect(r.errors).toBe(1);
    expect(mappingRow(id).provisionError).toContain("console address");
    expect(vi.mocked(adapter.createAlarm)).not.toHaveBeenCalled();
  });

  it("sweeps a disabled mapping's alarm and resets its provisioning fields", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const adapter = fakeProtectAdapter();
    await reconcileFobAlarms(adapter);
    const alarmId = mappingRow(id).nvrAlarmId!;

    db.update(schema.fobMappings).set({ isEnabled: false }).where(eq(schema.fobMappings.id, id)).run();
    vi.mocked(adapter.listAlarms).mockResolvedValue([
      { id: alarmId, title: `${FOB_ALARM_TITLE_PREFIX}x [#${id}]`, raw: {} },
    ]);
    const r = await reconcileFobAlarms(adapter);
    expect(r.deleted).toBe(1);
    const row = mappingRow(id);
    expect(row.nvrAlarmId).toBeNull();
    expect(row.tokenHash).toBeNull();
    expect(row.provisionState).toBe("PENDING");
  });

  it("does not run while another pass holds the lease", async () => {
    updateSystemState({ fobProvisionLockUntil: Date.now() + 30_000 });
    const adapter = fakeProtectAdapter();
    const r = await reconcileFobAlarms(adapter);
    expect(r.ran).toBe(false);
    expect(vi.mocked(adapter.listAlarms)).not.toHaveBeenCalled();
  });

  it("force recreates a healthy alarm with a fresh token", async () => {
    const cueId = seedTtsCue();
    const id = seedFobMapping({ action: "TRIGGER_CUE", cueId });
    const adapter = fakeProtectAdapter();
    await reconcileFobAlarms(adapter);
    const before = mappingRow(id).tokenHash;
    vi.mocked(adapter.listAlarms).mockResolvedValue([
      { id: mappingRow(id).nvrAlarmId!, title: `${FOB_ALARM_TITLE_PREFIX}x [#${id}]`, raw: {} },
    ]);
    const r = await reconcileFobAlarms(adapter, { force: true });
    expect(r).toMatchObject({ created: 1, deleted: 1 });
    expect(mappingRow(id).tokenHash).not.toBe(before);
  });
});

describe("PrivateSession.createAlarm body", () => {
  it("posts the exact serde shape the NVR validated live", async () => {
    const session = new PrivateSession("u", "p");
    const captured: { method: string; path: string; body: unknown }[] = [];
    session.request = vi.fn(async (method: string, path: string, body?: unknown) => {
      captured.push({ method, path, body });
      return {
        res: { status: 200, json: async () => ({ id: "new-alarm" }), text: async () => "" },
        ms: 1,
      } as unknown as Awaited<ReturnType<PrivateSession["request"]>>;
    });

    const spec: AlarmCreateSpec = {
      title: "Bell Console: t",
      pressType: "longPress",
      scopeValue: `${MAC}:button=panic`,
      webhook: { url: "http://192.168.1.50:3000/api/fob-hooks/1", token: "tok" },
    };
    await expect(session.createAlarm(spec)).resolves.toBe("new-alarm");
    expect(captured[0].method).toBe("POST");
    expect(captured[0].path).toBe("/api/v2/alarms/protect");
    expect(captured[0].body).toEqual({
      title: "Bell Console: t",
      triggers_data: [
        [{ id: "protect:button.buttonPressed", precondition_config: null, data: { pressType: "longPress" } }],
      ],
      actions_data: [
        [
          {
            id: "protect:webhook",
            target_ids: [],
            data: {
              url: "http://192.168.1.50:3000/api/fob-hooks/1",
              method: "POST",
              auth: { variant: "bearer", token: "tok" },
            },
          },
        ],
      ],
      scope: { mode: "include", data: { scope_all_buttons: [`${MAC}:button=panic`] } },
      suppression: null,
      restriction: null,
    });
  });
});

describe("PrivateSession on a UniFi OS without the v2 Alarm Manager", () => {
  function sessionAnswering(status: number) {
    const session = new PrivateSession("u", "p");
    session.request = vi.fn(async () => ({
      res: { status, json: async () => ({}), text: async () => "Alarm manifest not found" },
      ms: 1,
    }) as unknown as Awaited<ReturnType<PrivateSession["request"]>>);
    return session;
  }

  it("treats a 404 manifest/list as 'no triggers', not a transport failure", async () => {
    await expect(sessionAnswering(404).alarmManifestTriggerIds()).resolves.toEqual([]);
    await expect(sessionAnswering(404).listAlarms()).resolves.toEqual([]);
  });

  it("still throws on real failures so the reconciler retries them", async () => {
    await expect(sessionAnswering(500).alarmManifestTriggerIds()).rejects.toThrow("HTTP 500");
    await expect(sessionAnswering(500).listAlarms()).rejects.toThrow("HTTP 500");
  });
});

describe("trigger id constant", () => {
  it("matches the manifest id verified on the live NVR", () => {
    expect(FOB_TRIGGER_ID).toBe("protect:button.buttonPressed");
  });
});
