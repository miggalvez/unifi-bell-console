import { vi } from "vitest";
import { db, schema } from "@/lib/db/client";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { FOB_TRIGGER_ID } from "@/lib/fobs/provision";

export function seedUser(): number {
  const now = Date.now();
  return db
    .insert(schema.users)
    .values({
      username: "tester",
      displayName: "Tester",
      passwordHash: "x",
      role: "ADMIN",
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.users.id })
    .get().id;
}

export function seedWebhookCue(name = "Bell", webhookId = "bell.test"): number {
  const now = Date.now();
  return db
    .insert(schema.soundCues)
    .values({ name, deliveryMethod: "PROTECT_WEBHOOK", webhookId, ttsTone: "welcome", createdAt: now, updatedAt: now })
    .returning({ id: schema.soundCues.id })
    .get().id;
}

export function seedTtsCue(name = "Speech", ttsText = "Hello", zoneId?: number): number {
  const now = Date.now();
  return db
    .insert(schema.soundCues)
    .values({
      name,
      deliveryMethod: "PROTECT_NATIVE_TTS",
      ttsText,
      ttsTone: "welcome",
      zoneId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.soundCues.id })
    .get().id;
}

export function seedPlan(name = "Normal Day"): number {
  const now = Date.now();
  return db
    .insert(schema.bellPlans)
    .values({ name, createdAt: now, updatedAt: now })
    .returning({ id: schema.bellPlans.id })
    .get().id;
}

export function seedEvent(planId: number, time: string, cueId: number, label?: string): number {
  return db
    .insert(schema.bellEvents)
    .values({ bellPlanId: planId, time, cueId, label })
    .returning({ id: schema.bellEvents.id })
    .get().id;
}

export function assignAllWeekdays(planId: number | null): void {
  for (let d = 0; d <= 6; d++) {
    db.insert(schema.weekSchedule)
      .values({ dayOfWeek: d, bellPlanId: planId })
      .onConflictDoUpdate({ target: schema.weekSchedule.dayOfWeek, set: { bellPlanId: planId } })
      .run();
  }
}

export function seedSpeaker(mac: string, name = "Speaker"): void {
  db.insert(schema.speakers).values({ id: `spk-${mac}`, mac, name, state: "CONNECTED" }).run();
}

/**
 * The one fake ProtectAdapter for tests. Every method is a vi.fn() with a
 * benign default, so a test overrides only what it exercises — and interface
 * growth means adding one line here instead of touching every test file.
 */
export function fakeProtectAdapter(overrides: Partial<ProtectAdapter> = {}): ProtectAdapter {
  return {
    metaInfo: vi.fn(),
    listSpeakers: vi.fn(),
    patchSpeaker: vi.fn(),
    testSound: vi.fn(),
    triggerWebhook: vi.fn().mockResolvedValue({ status: 204, ms: 10 }),
    speak: vi.fn().mockResolvedValue({ status: 200, ms: 50 }),
    bootstrap: vi.fn().mockResolvedValue({}),
    alarmManifestTriggerIds: vi.fn().mockResolvedValue([FOB_TRIGGER_ID]),
    listButtonScopes: vi.fn().mockResolvedValue([]),
    listAlarms: vi.fn().mockResolvedValue([]),
    createAlarm: vi.fn().mockResolvedValue("alarm-id-1"),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function seedFob(mac = "AABBCCDDEE01", name = "USL Fob"): string {
  db.insert(schema.fobs)
    .values({ mac, name, state: "CONNECTED", lastPolledAt: Date.now() })
    .run();
  return mac;
}

export function seedFobMapping(
  values: Partial<typeof schema.fobMappings.$inferInsert> & { cueId?: number | null } = {},
): number {
  const now = Date.now();
  return db
    .insert(schema.fobMappings)
    .values({
      fobMac: "AABBCCDDEE01",
      button: "panic",
      pressType: "longPress",
      action: "STOP_ALERT",
      cueId: null,
      createdAt: now,
      updatedAt: now,
      ...values,
    })
    .returning({ id: schema.fobMappings.id })
    .get().id;
}

export function insertClaimedRun(values: Partial<typeof schema.scheduledRuns.$inferInsert>): number {
  const now = Date.now();
  return db
    .insert(schema.scheduledRuns)
    .values({
      source: "MANUAL",
      deliveryMethod: "PROTECT_WEBHOOK",
      webhookId: "bell.test",
      cueName: "Bell",
      scheduledAtUtc: now,
      localDate: "2027-01-01",
      localTime: "08:00",
      status: "CLAIMED",
      claimedAt: now,
      createdAt: now,
      ...values,
    })
    .returning({ id: schema.scheduledRuns.id })
    .get().id;
}
