import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/sqlite-core";

// Conventions: timestamps are UTC epoch ms integers. Local wall-clock values
// (school timezone) are text — 'YYYY-MM-DD' dates and 'HH:MM' times — and are
// converted to UTC only by the scheduler materializer.

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["ADMIN", "STAFF"] }).notNull().default("STAFF"),
  canEmergency: integer("can_emergency", { mode: "boolean" }).notNull().default(false),
  isDisabled: integer("is_disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    // id = sha256(raw token); the raw token lives only in the user's cookie
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

// Cache of Protect speakers, refreshed by the worker's health poller
export const speakers = sqliteTable("speakers", {
  id: text("id").primaryKey(), // Protect device id
  mac: text("mac").notNull().unique(), // normalized uppercase hex, no separators
  name: text("name"),
  state: text("state"),
  status: text("status"),
  volume: integer("volume"),
  micVolume: integer("mic_volume"),
  firmwareVersion: text("firmware_version"),
  lastSeenOnlineAt: integer("last_seen_online_at"),
  lastPolledAt: integer("last_polled_at"),
  raw: text("raw"), // full official-API object, JSON, for debugging
});

export const zones = sqliteTable("zones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
});

export const zoneMembers = sqliteTable(
  "zone_members",
  {
    zoneId: integer("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "cascade" }),
    // MAC, not Protect id: physical identity, and what TTS `sources` targets
    speakerMac: text("speaker_mac").notNull(),
  },
  (t) => [primaryKey({ columns: [t.zoneId, t.speakerMac] })],
);

// Uploaded audio, streamed to speakers over Protect's talkback WebSocket.
// Files live on disk (data/audio/); this table is the catalogue.
export const audioFiles = sqliteTable("audio_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  storedName: text("stored_name").notNull().unique(), // filename on disk
  originalName: text("original_name"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").notNull(),
  durationMs: integer("duration_ms"),
  uploadedBy: integer("uploaded_by").references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

export const soundCues = sqliteTable(
  "sound_cues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    description: text("description"),
    deliveryMethod: text("delivery_method", {
      enum: ["PROTECT_WEBHOOK", "PROTECT_NATIVE_TTS", "PROTECT_TALKBACK_AUDIO", "PROTECT_TALKBACK_COMPOSITE"],
    }).notNull(),
    webhookId: text("webhook_id"),
    ttsText: text("tts_text"),
    ttsTone: text("tts_tone").notNull().default("welcome"),
    audioFileId: integer("audio_file_id").references(() => audioFiles.id, { onDelete: "restrict" }),
    /** Playback length, used by the speaker lock. Null = fall back to a default. */
    estimatedDurationMs: integer("estimated_duration_ms"),
    // For TTS cues: playback targets. For webhook cues: informational only —
    // the Protect Alarm Manager automation owns speaker targeting.
    zoneId: integer("zone_id").references(() => zones.id, { onDelete: "set null" }),
    isEmergency: integer("is_emergency", { mode: "boolean" }).notNull().default(false),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // Unqualified column names on purpose: drizzle-kit rebuilds this table
    // through a __new_ temp name, and a table-qualified CHECK breaks on rename.
    check(
      "cue_method_fields",
      sql`(delivery_method = 'PROTECT_WEBHOOK' AND webhook_id IS NOT NULL)
        OR (delivery_method = 'PROTECT_NATIVE_TTS' AND tts_text IS NOT NULL)
        OR (delivery_method = 'PROTECT_TALKBACK_AUDIO' AND audio_file_id IS NOT NULL)
        OR (delivery_method = 'PROTECT_TALKBACK_COMPOSITE')`,
    ),
  ],
);

/**
 * The ordered recordings inside a combined announcement
 * (PROTECT_TALKBACK_COMPOSITE) — an attention chime, then a spoken message,
 * spliced into ONE talkback stream at play time so there is no gap between
 * them. Recordings only: a spoken (TTS) message is rendered by Protect itself
 * and cannot enter a talkback stream — record the words instead.
 */
export const soundCueParts = sqliteTable(
  "sound_cue_parts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cueId: integer("cue_id")
      .notNull()
      .references(() => soundCues.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** restrict: deleting a recording out from under an announcement must fail loudly. */
    audioFileId: integer("audio_file_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "restrict" }),
  },
  (t) => [uniqueIndex("cue_part_position_uniq").on(t.cueId, t.position)],
);

export const bellPlans = sqliteTable("bell_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const bellEvents = sqliteTable(
  "bell_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bellPlanId: integer("bell_plan_id")
      .notNull()
      .references(() => bellPlans.id, { onDelete: "cascade" }),
    time: text("time").notNull(), // 'HH:MM' school-local
    cueId: integer("cue_id")
      .notNull()
      .references(() => soundCues.id, { onDelete: "restrict" }),
    label: text("label"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("bell_events_plan_idx").on(t.bellPlanId)],
);

// One row per weekday (0=Sunday..6=Saturday); null plan = no bells that day
export const weekSchedule = sqliteTable("week_schedule", {
  dayOfWeek: integer("day_of_week").primaryKey(),
  bellPlanId: integer("bell_plan_id").references(() => bellPlans.id, {
    onDelete: "set null",
  }),
});

export const calendarExceptions = sqliteTable("calendar_exceptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull().unique(), // 'YYYY-MM-DD' school-local
  type: text("type", { enum: ["NO_SCHOOL", "USE_PLAN"] }).notNull(),
  bellPlanId: integer("bell_plan_id").references(() => bellPlans.id, {
    onDelete: "cascade",
  }),
  note: text("note"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at").notNull(),
});

/**
 * One-day changes made from the staff-facing Today view. These live beside the
 * schedule definition instead of only mutating a materialized run, so the
 * worker's six-hour horizon refresh cannot accidentally undo a skipped or
 * delayed bell.
 */
export const bellEventOverrides = sqliteTable(
  "bell_event_overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    localDate: text("local_date").notNull(),
    bellEventId: integer("bell_event_id")
      .notNull()
      .references(() => bellEvents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["SKIP", "DELAY"] }).notNull(),
    /** School-local HH:MM; required only for DELAY. */
    effectiveTime: text("effective_time"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("bell_event_override_date_event_uniq").on(t.localDate, t.bellEventId),
    check(
      "bell_event_override_kind_fields",
      sql`(kind = 'SKIP' AND effective_time IS NULL)
        OR (kind = 'DELAY' AND effective_time IS NOT NULL)`,
    ),
  ],
);

// One lifecycle for scheduled, manual, and emergency playback. Execution
// fields are snapshotted at materialize/trigger time so later cue edits
// cannot rewrite history.
export const scheduledRuns = sqliteTable(
  "scheduled_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source", { enum: ["SCHEDULE", "MANUAL", "EMERGENCY", "DRILL"] }).notNull(),
    bellEventId: integer("bell_event_id").references(() => bellEvents.id, {
      onDelete: "set null",
    }),
    cueId: integer("cue_id").references(() => soundCues.id, { onDelete: "set null" }),
    cueName: text("cue_name"),
    deliveryMethod: text("delivery_method", {
      enum: ["PROTECT_WEBHOOK", "PROTECT_NATIVE_TTS", "PROTECT_TALKBACK_AUDIO"],
    }).notNull(),
    webhookId: text("webhook_id"),
    ttsText: text("tts_text"),
    ttsTone: text("tts_tone"),
    /** Snapshot of the file path at trigger time, so history survives deletion. */
    audioPath: text("audio_path"),
    /**
     * JSON array of paths played as ONE continuous talkback stream. Used by
     * drills to glue the "this is a drill" announcement to the sound it
     * introduces, so the pair costs one session rather than two.
     */
    audioPaths: text("audio_paths"),
    /** Playback length snapshot; the speaker lock is held this long. */
    estimatedDurationMs: integer("estimated_duration_ms"),
    targetMacs: text("target_macs"), // JSON array; null = resolve at execution
    scheduledAtUtc: integer("scheduled_at_utc").notNull(),
    localDate: text("local_date").notNull(),
    localTime: text("local_time").notNull(),
    status: text("status", {
      enum: [
        "PENDING",
        "CLAIMED",
        "EXECUTING",
        "SUCCESS",
        "FAILED",
        "MISSED",
        "DELIVERY_UNCERTAIN",
        "SKIPPED_PAUSED",
      ],
    })
      .notNull()
      .default("PENDING"),
    claimedAt: integer("claimed_at"),
    executedAt: integer("executed_at"),
    httpStatus: integer("http_status"),
    latencyMs: real("latency_ms"),
    resultMessage: text("result_message"),
    requestedBy: integer("requested_by").references(() => users.id), // null = scheduler
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("runs_event_time_uniq")
      .on(t.bellEventId, t.scheduledAtUtc)
      .where(sql`bell_event_id IS NOT NULL`),
    index("runs_claim_idx").on(t.status, t.scheduledAtUtc),
    index("runs_date_idx").on(t.localDate),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    userId: integer("user_id").references(() => users.id), // null = system
    action: text("action").notNull(), // e.g. auth.login, cue.trigger, pause.enable
    targetType: text("target_type"),
    targetId: text("target_id"),
    isEmergency: integer("is_emergency", { mode: "boolean" }).notNull().default(false),
    detail: text("detail"), // JSON
  },
  (t) => [index("audit_at_idx").on(t.at), index("audit_emergency_idx").on(t.isEmergency)],
);

/**
 * Drill sequences — a saved, ordered script for practising an emergency:
 * play a sound, wait, play another. Run on demand by staff, never scheduled
 * unattended.
 */
export const drillSequences = sqliteTable("drill_sequences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  description: text("description"),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const drillSteps = sqliteTable(
  "drill_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sequenceId: integer("sequence_id")
      .notNull()
      .references(() => drillSequences.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind", { enum: ["PLAY", "WAIT"] }).notNull(),
    /**
     * restrict, not set null: a drill quietly losing a step because someone
     * deleted a sound is worse than a clear error at deletion time.
     */
    cueId: integer("cue_id").references(() => soundCues.id, { onDelete: "restrict" }),
    waitSeconds: integer("wait_seconds"),
    /**
     * Optional repeat for a PLAY step: keep sounding for this many seconds.
     * There is no interval to configure — the alarm simply repeats back to
     * back, the way a real one does, with the drill announcement between
     * soundings. Null = play once.
     */
    repeatForSeconds: integer("repeat_for_seconds"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    // Unqualified column names — see the note on sound_cues.
    check(
      "drill_step_kind_fields",
      sql`(kind = 'PLAY' AND cue_id IS NOT NULL)
        OR (kind = 'WAIT' AND wait_seconds IS NOT NULL AND wait_seconds > 0)`,
    ),
    uniqueIndex("drill_step_position_uniq").on(t.sequenceId, t.position),
  ],
);

// Singleton row (id = 1)
export const systemState = sqliteTable(
  "system_state",
  {
    id: integer("id").primaryKey(),
    pausedUntil: integer("paused_until"), // paused iff > now
    pauseReason: text("pause_reason"),
    pausedBy: integer("paused_by").references(() => users.id),
    pausedAt: integer("paused_at"),
    ttsRevalidateFlag: integer("tts_revalidate_flag", { mode: "boolean" })
      .notNull()
      .default(false),
    ttsFlagReason: text("tts_flag_reason"),
    lastHealthOkAt: integer("last_health_ok_at"),
    lastHealthError: text("last_health_error"),
    consecutiveHealthFailures: integer("consecutive_health_failures").notNull().default(0),
    usingCloudFallback: integer("using_cloud_fallback", { mode: "boolean" })
      .notNull()
      .default(false),
    apiKeyExpiresAt: integer("api_key_expires_at"), // admin-recorded; API doesn't report it
    lastMaterializedThrough: text("last_materialized_through"), // localDate
    /** Freshness of the one-second scheduler loop, distinct from Protect health. */
    workerHeartbeatAt: integer("worker_heartbeat_at"),
    workerStartedAt: integer("worker_started_at"),
    localBackupLastAttemptAt: integer("local_backup_last_attempt_at"),
    localBackupLastSuccessAt: integer("local_backup_last_success_at"),
    localBackupLastError: text("local_backup_last_error"),
    offsiteBackupLastAttemptAt: integer("offsite_backup_last_attempt_at"),
    offsiteBackupLastSuccessAt: integer("offsite_backup_last_success_at"),
    offsiteBackupLastError: text("offsite_backup_last_error"),
    lastCompletedR2Key: text("last_completed_r2_key"),
    /**
     * Speakers cannot play two things at once: Protect returns HTTP 500 for
     * TTS during playback, and talkback sessions need spacing. Every delivery
     * claims this lock for its estimated duration.
     */
    speakerBusyUntil: integer("speaker_busy_until"),

    /**
     * A repeating emergency alert. Lives in the database, not the browser, so
     * it keeps sounding if the person who started it closes their laptop, and
     * can be stopped from any device. `alertUntil` is a hard backstop so a
     * forgotten alert cannot sound indefinitely.
     */
    alertCueId: integer("alert_cue_id").references(() => soundCues.id, { onDelete: "set null" }),
    alertStartedAt: integer("alert_started_at"),
    alertStartedBy: integer("alert_started_by").references(() => users.id),
    alertRepeatSeconds: integer("alert_repeat_seconds"),
    alertUntil: integer("alert_until"),
    alertLastPlayedAt: integer("alert_last_played_at"),

    /**
     * A running drill sequence. Same reasoning as the alert block above: the
     * step cursor lives here rather than in a browser timer, because a drill
     * with a five-minute gap in it has to survive a page close and a worker
     * restart. `drillNextStepAt` is an absolute time, never a countdown.
     */
    drillSequenceId: integer("drill_sequence_id").references(() => drillSequences.id, {
      onDelete: "set null",
    }),
    drillStartedAt: integer("drill_started_at"),
    drillStartedBy: integer("drill_started_by").references(() => users.id),
    /** Index into the sequence's saved steps. */
    drillStepIndex: integer("drill_step_index"),
    drillNextStepAt: integer("drill_next_step_at"),
    drillUntil: integer("drill_until"),
    /** Set while a repeating PLAY step is in progress: when it stops repeating. */
    drillStepEndsAt: integer("drill_step_ends_at"),
    /**
     * Where we are inside one sound: the drill tag is spoken BEFORE it and
     * again AFTER it, so every emergency sound in a drill is bracketed by
     * "this is a drill" on both sides.
     */
    drillStepPhase: text("drill_step_phase", { enum: ["BEFORE", "SOUND", "AFTER"] }),

    /**
     * Keychain-remote (fob) alarm provisioning. The flag asks the worker to
     * reconcile now; the lease keeps the worker loop and a post-edit inline
     * attempt from double-creating alarms (creates are not idempotent).
     */
    fobReprovisionFlag: integer("fob_reprovision_flag", { mode: "boolean" })
      .notNull()
      .default(false),
    fobProvisionLockUntil: integer("fob_provision_lock_until"),
    fobLastReconcileAt: integer("fob_last_reconcile_at"),
    fobLastReconcileError: text("fob_last_reconcile_error"),
  },
  (t) => [check("system_state_singleton", sql`${t.id} = 1`)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
});

// Cache of Protect keychain remotes (USL fobs), refreshed from the private
// bootstrap by the worker's firmware poller and the Remotes page's Refresh.
// Upsert-only like `speakers`: rows are never pruned, so a battery-dead fob
// shows as stale ("not seen since…") instead of vanishing.
export const fobs = sqliteTable("fobs", {
  mac: text("mac").primaryKey(), // normalized uppercase hex, no separators
  protectId: text("protect_id"), // bootstrap fob id, informational
  name: text("name"),
  state: text("state"),
  batteryStatus: text("battery_status"), // JSON wirelessConnectionState.batteryStatus
  firmwareVersion: text("firmware_version"),
  lastSeenAt: integer("last_seen_at"), // fob's own lastSeen from Protect
  lastPolledAt: integer("last_polled_at"),
  raw: text("raw"), // full bootstrap object, JSON, for debugging
});

/**
 * One fob button+press slot mapped to a console action. The reconciler mirrors
 * every enabled row onto the NVR as a v2 Alarm Manager alarm (button press →
 * webhook back to us); the provisioning fields below are owned by it.
 */
export const fobMappings = sqliteTable(
  "fob_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // MAC, not Protect id: physical identity — same reasoning as zone_members.
    // Deliberately no FK to `fobs`: a fob missing from one bootstrap poll must
    // not cascade away its mappings.
    fobMac: text("fob_mac").notNull(),
    button: text("button", {
      enum: ["arm", "night", "disarm", "panic", "left", "right"],
    }).notNull(),
    pressType: text("press_type", { enum: ["press", "longPress", "doublePress"] }).notNull(),
    action: text("action", { enum: ["START_ALERT", "TRIGGER_CUE", "STOP_ALERT"] }).notNull(),
    /**
     * restrict, not set null: a fob button quietly going dead because someone
     * deleted a sound is worse than a clear error at deletion time.
     */
    cueId: integer("cue_id").references(() => soundCues.id, { onDelete: "restrict" }),
    /** START_ALERT only; clamped by minimumRepeatSeconds at press time. */
    repeatSeconds: integer("repeat_seconds"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),

    // --- provisioning state, owned by the reconciler ---
    nvrAlarmId: text("nvr_alarm_id"),
    /**
     * sha256 hex of the bearer token minted for this mapping's NVR alarm.
     * The plaintext lives only inside the alarm body on the NVR, never here —
     * same shape as sessions.id.
     */
    tokenHash: text("token_hash"),
    /** Hash of the desired alarm config at creation; mismatch = recreate. */
    desiredHash: text("desired_hash"),
    provisionState: text("provision_state", {
      enum: ["PENDING", "OK", "ERROR", "UNSUPPORTED"],
    })
      .notNull()
      .default("PENDING"),
    provisionError: text("provision_error"),
    /** Doubles as the press-dedupe claim column (atomic conditional update). */
    lastTriggeredAt: integer("last_triggered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("fob_mapping_slot_uniq").on(t.fobMac, t.button, t.pressType),
    // Unqualified column names — see the note on sound_cues.
    check(
      "fob_mapping_action_fields",
      sql`(action = 'STOP_ALERT' AND cue_id IS NULL)
        OR (action IN ('START_ALERT','TRIGGER_CUE') AND cue_id IS NOT NULL)`,
    ),
  ],
);

// Append-only; a new row is inserted only when a version changes,
// which also sets systemState.ttsRevalidateFlag
export const protectVersions = sqliteTable("protect_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seenAt: integer("seen_at").notNull(),
  protectVersion: text("protect_version"),
  nvrFirmware: text("nvr_firmware"),
  speakerFirmware: text("speaker_firmware"), // JSON mac -> fw
});

export const healthChecks = sqliteTable(
  "health_checks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    latencyMs: real("latency_ms"),
    error: text("error"),
    speakersOnline: integer("speakers_online"),
    speakersTotal: integer("speakers_total"),
  },
  (t) => [index("health_at_idx").on(t.at)],
);
