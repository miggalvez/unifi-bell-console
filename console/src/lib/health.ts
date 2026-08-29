/**
 * Health poller + Protect version watcher. Called from the worker on an
 * interval; pure DB effects so it is testable with a fake adapter.
 */
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getSystemState, updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";
import { onFallbackChange, type OfficialSpeaker } from "@/lib/protect/official";
import { normMac, type ProtectAdapter } from "@/lib/protect/adapter";
import { upsertFobsFromBootstrap } from "@/lib/fobs/sync";

// Surface connector-fallback state on system_state so the UI can warn.
// Compare against the DB (not module state) — web and worker are separate
// processes, and dev HMR re-instantiates modules.
onFallbackChange((usingCloudFallback) => {
  try {
    if (getSystemState().usingCloudFallback === usingCloudFallback) return;
    updateSystemState({ usingCloudFallback });
    writeAudit({
      action: usingCloudFallback ? "protect.cloud_fallback_on" : "protect.cloud_fallback_off",
    });
  } catch {
    // never let telemetry break a live call path
  }
});

function upsertSpeakers(list: OfficialSpeaker[], now: number): number {
  let online = 0;
  for (const s of list) {
    const isOnline = s.state === "CONNECTED";
    if (isOnline) online++;
    db.insert(schema.speakers)
      .values({
        id: s.id,
        mac: normMac(s.mac),
        name: s.name,
        state: s.state,
        status: s.speakerState?.status,
        volume: s.volume,
        micVolume: s.micVolume,
        lastSeenOnlineAt: isOnline ? now : undefined,
        lastPolledAt: now,
        raw: JSON.stringify(s),
      })
      .onConflictDoUpdate({
        target: schema.speakers.id,
        set: {
          mac: normMac(s.mac),
          name: s.name,
          state: s.state,
          status: s.speakerState?.status,
          volume: s.volume,
          micVolume: s.micVolume,
          ...(isOnline ? { lastSeenOnlineAt: now } : {}),
          lastPolledAt: now,
          raw: JSON.stringify(s),
        },
      })
      .run();
  }
  return online;
}

function watchVersion(protectVersion: string, speakerFirmware?: Record<string, string>, nvrFirmware?: string): void {
  const last = db
    .select()
    .from(schema.protectVersions)
    .orderBy(desc(schema.protectVersions.id))
    .limit(1)
    .get();

  const fwJson = speakerFirmware === undefined ? null : JSON.stringify(speakerFirmware);

  if (!last) {
    db.insert(schema.protectVersions)
      .values({ seenAt: Date.now(), protectVersion, nvrFirmware: nvrFirmware ?? null, speakerFirmware: fwJson })
      .run();
    return;
  }

  // A field only counts as changed if we knew its previous value — filling in
  // a previously-unknown field is baseline enrichment, not an update.
  const changes: string[] = [];
  if (last.protectVersion !== null && last.protectVersion !== protectVersion) {
    changes.push(`Protect ${last.protectVersion} → ${protectVersion}`);
  }
  if (nvrFirmware !== undefined && last.nvrFirmware !== null && last.nvrFirmware !== nvrFirmware) {
    changes.push(`NVR firmware ${last.nvrFirmware} → ${nvrFirmware}`);
  }
  if (fwJson !== null && last.speakerFirmware !== null && last.speakerFirmware !== fwJson) {
    changes.push("speaker firmware updated");
  }

  if (changes.length > 0) {
    db.insert(schema.protectVersions)
      .values({
        seenAt: Date.now(),
        protectVersion,
        nvrFirmware: nvrFirmware ?? last.nvrFirmware,
        speakerFirmware: fwJson ?? last.speakerFirmware,
      })
      .run();
    const reason = `${changes.join("; ")} — re-validate typed announcements before relying on them.`;
    updateSystemState({ ttsRevalidateFlag: true, ttsFlagReason: reason });
    writeAudit({ action: "protect.version_changed", detail: { changes } });
  } else if (
    (nvrFirmware !== undefined && last.nvrFirmware === null) ||
    (fwJson !== null && last.speakerFirmware === null)
  ) {
    db.update(schema.protectVersions)
      .set({
        nvrFirmware: nvrFirmware ?? last.nvrFirmware,
        speakerFirmware: fwJson ?? last.speakerFirmware,
      })
      .where(eq(schema.protectVersions.id, last.id))
      .run();
  }
}

/** Flattens err.cause chains — undici's "fetch failed" hides the real code. */
function errorDetail(err: unknown): string {
  const parts: string[] = [];
  for (let e = err as { message?: string; code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    parts.push([e.code, e.message].filter(Boolean).join(" ") || String(e));
  }
  return parts.join(" <- ").slice(0, 500) || "unknown error";
}

export async function pollHealthOnce(adapter: ProtectAdapter): Promise<void> {
  const now = Date.now();
  try {
    const meta = await adapter.metaInfo();
    const speakers = await adapter.listSpeakers();
    const online = upsertSpeakers(speakers.body, now);

    db.insert(schema.healthChecks)
      .values({
        at: now,
        ok: true,
        latencyMs: Math.round((meta.ms + speakers.ms) * 10) / 10,
        speakersOnline: online,
        speakersTotal: speakers.body.length,
      })
      .run();
    updateSystemState({ lastHealthOkAt: now, lastHealthError: null, consecutiveHealthFailures: 0 });

    watchVersion(meta.body.applicationVersion);
  } catch (err) {
    const message = errorDetail(err);
    const state = getSystemState();
    db.insert(schema.healthChecks).values({ at: now, ok: false, error: message }).run();
    updateSystemState({
      lastHealthError: message,
      consecutiveHealthFailures: state.consecutiveHealthFailures + 1,
    });
  }
}

/** Heavier check via private bootstrap — speaker firmware versions. Hourly. */
export async function pollFirmwareOnce(adapter: ProtectAdapter): Promise<void> {
  try {
    const b = await adapter.bootstrap();
    upsertFobsFromBootstrap(b);
    const fw: Record<string, string> = {};
    for (const s of b.speakers ?? []) {
      if (s.mac && s.firmwareVersion) {
        fw[normMac(s.mac)] = s.firmwareVersion;
        db.update(schema.speakers)
          .set({ firmwareVersion: s.firmwareVersion })
          .where(eq(schema.speakers.mac, normMac(s.mac)))
          .run();
      }
    }
    const version = b.nvr?.version;
    if (version) watchVersion(version, fw, b.nvr?.firmwareVersion);
  } catch {
    // firmware watch is best-effort; the 30s poller owns error accounting
  }
}
