import { db, schema } from "@/lib/db/client";

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
