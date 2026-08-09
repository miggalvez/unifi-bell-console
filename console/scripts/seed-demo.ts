/**
 * Seeds a self-contained DEMO database with believable fictional school data,
 * so anyone can explore the interface with no UniFi hardware at all:
 *
 *   npm run demo        # seeds data/demo.db, then serves on :3001
 *   sign in as  demo / demo1234   (or  staff / demo1234  for the staff view)
 *
 * UI demo only: playing sounds needs a real NVR, and the scheduler worker is
 * not started — nothing rings. Everything here is fictional; the database
 * lives at data/demo.db (gitignored) and reseeds from scratch on every run.
 */
import { rmSync } from "node:fs";
import { DateTime } from "luxon";

const DB = process.env.DB_PATH;
if (!DB || !DB.includes("demo")) {
  console.error("Refusing to run: set DB_PATH to a demo database, e.g. DB_PATH=data/demo.db");
  process.exit(1);
}
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

async function main(): Promise<void> {
  // Imported AFTER the wipe: opening the client runs migrations on the fresh file.
  const { db, schema, sqlite } = await import("@/lib/db/client");
  const { hashPassword } = await import("@/lib/auth/password");
  const { env } = await import("@/env");

  const now = Date.now();
  const tz = env.schoolTz;
  const local = (epoch: number) => {
    const dt = DateTime.fromMillis(epoch, { zone: tz });
    return { localDate: dt.toFormat("yyyy-LL-dd"), localTime: dt.toFormat("HH:mm") };
  };

  // ── people ──
  const [admin, staff] = [
    { username: "demo", displayName: "Alex Rivera", role: "ADMIN" as const, canEmergency: true },
    { username: "staff", displayName: "Jordan Lee", role: "STAFF" as const, canEmergency: true },
  ].map((u) => ({ ...u, id: 0 }));
  for (const u of [admin, staff]) {
    u.id = db
      .insert(schema.users)
      .values({
        username: u.username,
        displayName: u.displayName,
        passwordHash: await hashPassword("demo1234"),
        role: u.role,
        canEmergency: u.canEmergency,
        createdAt: now - 90 * 86_400_000,
        updatedAt: now - 90 * 86_400_000,
      })
      .returning({ id: schema.users.id })
      .get().id;
  }

  // ── speakers & zones ──
  const speakers = [
    { id: "demo-hall", mac: "AA1111111111", name: "Main Hall", volume: 80 },
    { id: "demo-cafeteria", mac: "AA2222222222", name: "Cafeteria", volume: 70 },
    { id: "demo-playground", mac: "AA3333333333", name: "Playground", volume: 100 },
  ];
  for (const s of speakers) {
    db.insert(schema.speakers)
      .values({
        ...s,
        state: "CONNECTED",
        status: "—",
        firmwareVersion: "1.0.6",
        lastSeenOnlineAt: now,
        lastPolledAt: now,
      })
      .run();
  }
  const outdoorZone = db
    .insert(schema.zones)
    .values({ name: "Outdoors", description: "Playground only", createdAt: now })
    .returning({ id: schema.zones.id })
    .get().id;
  db.insert(schema.zoneMembers).values({ zoneId: outdoorZone, speakerMac: "AA3333333333" }).run();

  // ── audio library (rows only — the demo never plays them) ──
  const audio = (name: string, durationMs: number) =>
    db
      .insert(schema.audioFiles)
      .values({
        name,
        storedName: `demo-${name.toLowerCase().replace(/[^a-z]+/g, "-")}.mp3`,
        sizeBytes: Math.round(durationMs * 4),
        durationMs,
        uploadedBy: admin.id,
        createdAt: now - 30 * 86_400_000,
      })
      .returning({ id: schema.audioFiles.id })
      .get().id;
  const chimeAudio = audio("Attention chime", 3_000);
  const lockdownAudio = audio("Lockdown message", 12_000);
  const allClearAudio = audio("All-clear message", 8_000);

  // ── sounds & messages ──
  const cue = (v: Partial<typeof schema.soundCues.$inferInsert>) =>
    db
      .insert(schema.soundCues)
      .values({
        name: "x",
        deliveryMethod: "PROTECT_WEBHOOK",
        ttsTone: "welcome",
        createdAt: now - 30 * 86_400_000,
        updatedAt: now - 30 * 86_400_000,
        ...v,
      })
      .returning({ id: schema.soundCues.id })
      .get().id;
  const classChange = cue({ name: "Class change", deliveryMethod: "PROTECT_WEBHOOK", webhookId: "bell.class-change", estimatedDurationMs: 4_000, description: "Standard two-tone bell" });
  const recess = cue({ name: "Recess bell", deliveryMethod: "PROTECT_WEBHOOK", webhookId: "bell.recess", estimatedDurationMs: 4_000 });
  cue({ name: "Morning welcome", deliveryMethod: "PROTECT_NATIVE_TTS", ttsText: "Good morning, and welcome to another great day of learning.", description: "Spoken by the speakers' own voice" });
  const lockdownCue = cue({ name: "Lockdown message", deliveryMethod: "PROTECT_TALKBACK_AUDIO", audioFileId: lockdownAudio, estimatedDurationMs: 12_000, isEmergency: true });
  const allClearCue = cue({ name: "All clear", deliveryMethod: "PROTECT_TALKBACK_AUDIO", audioFileId: allClearAudio, estimatedDurationMs: 8_000, isEmergency: true });
  const combined = cue({ name: "Attention + lockdown", deliveryMethod: "PROTECT_TALKBACK_COMPOSITE", estimatedDurationMs: 15_000, isEmergency: true, description: "Chime, then the message — one seamless announcement" });
  for (const [i, a] of [chimeAudio, lockdownAudio].entries()) {
    db.insert(schema.soundCueParts).values({ cueId: combined, position: i, audioFileId: a }).run();
  }

  // ── bell plans & schedule ──
  const plan = (name: string, description: string, times: [string, number, string?][]) => {
    const id = db
      .insert(schema.bellPlans)
      .values({ name, description, createdAt: now - 60 * 86_400_000, updatedAt: now - 7 * 86_400_000 })
      .returning({ id: schema.bellPlans.id })
      .get().id;
    for (const [time, cueId, label] of times) {
      db.insert(schema.bellEvents).values({ bellPlanId: id, time, cueId, label }).run();
    }
    return id;
  };
  const normal = plan("Normal School Day", "Regular timetable, first bell to dismissal", [
    ["08:00", classChange, "First bell"],
    ["08:50", classChange],
    ["09:40", classChange],
    ["10:30", recess, "Morning recess"],
    ["10:45", classChange],
    ["11:35", classChange],
    ["12:20", recess, "Lunch"],
    ["13:05", classChange],
    ["13:55", classChange],
    ["15:30", classChange, "Dismissal"],
  ]);
  const early = plan("Early Release Day", "Shortened periods, out by 1:30", [
    ["08:00", classChange, "First bell"],
    ["09:10", classChange],
    ["10:20", recess, "Recess"],
    ["11:30", classChange],
    ["13:30", classChange, "Dismissal"],
  ]);
  for (let d = 1; d <= 5; d++) {
    db.insert(schema.weekSchedule).values({ dayOfWeek: d, bellPlanId: normal }).run();
  }
  const nextWed = DateTime.fromMillis(now, { zone: tz }).plus({ days: ((3 - DateTime.fromMillis(now, { zone: tz }).weekday + 7) % 7) || 7 });
  db.insert(schema.calendarExceptions)
    .values({ date: nextWed.toFormat("yyyy-LL-dd"), type: "USE_PLAN", bellPlanId: early, note: "Parent–teacher conferences", createdBy: admin.id, createdAt: now })
    .run();

  // ── history & upcoming runs ──
  const run = (v: Partial<typeof schema.scheduledRuns.$inferInsert>, at: number) =>
    db.insert(schema.scheduledRuns)
      .values({
        source: "SCHEDULE",
        deliveryMethod: "PROTECT_WEBHOOK",
        webhookId: "bell.class-change",
        cueId: classChange,
        cueName: "Class change",
        scheduledAtUtc: at,
        ...local(at),
        status: "SUCCESS",
        httpStatus: 204,
        latencyMs: 28 + Math.round(Math.sin(at) * 6),
        executedAt: at + 400,
        createdAt: at - 86_400_000,
        ...v,
      })
      .run();
  // Yesterday's bells rang on time.
  const y8 = DateTime.fromMillis(now, { zone: tz }).minus({ days: 1 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  for (const [h, m, label] of [[8, 0, "First bell"], [10, 30, "Morning recess"], [12, 20, "Lunch"], [15, 30, "Dismissal"]] as [number, number, string][]) {
    run({ cueName: label === "Morning recess" || label === "Lunch" ? "Recess bell" : "Class change" }, y8.set({ hour: h, minute: m }).toMillis());
  }
  run(
    { source: "MANUAL", deliveryMethod: "PROTECT_NATIVE_TTS", webhookId: null, cueId: null, cueName: "(typed announcement)", ttsText: "Bus 12 is running ten minutes late this afternoon.", httpStatus: 200, requestedBy: staff.id },
    y8.set({ hour: 14, minute: 5 }).toMillis(),
  );
  // Upcoming: the next few scheduled bells.
  let upcoming = DateTime.fromMillis(now, { zone: tz }).plus({ hours: 1 }).set({ minute: 0, second: 0, millisecond: 0 });
  for (const label of ["Class change", "Recess bell", "Class change"]) {
    run({ cueName: label, status: "PENDING", httpStatus: null, latencyMs: null, executedAt: null }, upcoming.toMillis());
    upcoming = upcoming.plus({ minutes: 50 });
  }

  // ── a drill, on the books ──
  const seq = db
    .insert(schema.drillSequences)
    .values({ name: "Lockdown drill", description: "Termly practice, whole building", createdBy: admin.id, createdAt: now - 20 * 86_400_000, updatedAt: now - 20 * 86_400_000 })
    .returning({ id: schema.drillSequences.id })
    .get().id;
  const steps: [string, Partial<typeof schema.drillSteps.$inferInsert>][] = [
    ["PLAY", { cueId: combined, repeatForSeconds: 240 }],
    ["WAIT", { waitSeconds: 300 }],
    ["PLAY", { cueId: allClearCue }],
  ];
  steps.forEach(([kind, v], i) =>
    db.insert(schema.drillSteps).values({ sequenceId: seq, position: i, kind: kind as "PLAY" | "WAIT", createdAt: now, ...v }).run(),
  );
  db.update(schema.settings); // no-op keeps imports honest
  db.insert(schema.settings).values({ key: "drillPreambleCueId", value: "null" }).onConflictDoNothing().run();

  // ── audit trail & health ──
  const audit = (at: number, userId: number | null, action: string, detail?: object) =>
    db.insert(schema.auditLog).values({ at, userId, action, detail: detail ? JSON.stringify(detail) : null }).run();
  audit(now - 3_600_000, admin.id, "auth.login");
  audit(now - 3_000_000, admin.id, "cue.update", { name: "Lockdown message" });
  audit(now - 86_400_000 * 6, admin.id, "drill.start", { name: "Lockdown drill", steps: 3 });
  audit(now - 86_400_000 * 6 + 600_000, admin.id, "drill.finish", { completed: true });

  db.update(schema.systemState)
    .set({ lastHealthOkAt: now - 12_000, consecutiveHealthFailures: 0, apiKeyExpiresAt: now + 25 * 86_400_000 })
    .run();

  sqlite.close();
  console.log(`demo database seeded at ${DB} — sign in as demo / demo1234`);
}

main().catch((e) => {
  console.error("seed failed:", e);
  process.exit(1);
});
