/**
 * What happens when a keychain-remote button press arrives from the NVR.
 * The route hands us the mapping id from the URL and the bearer token; this
 * module authenticates, dedupes, and runs the mapped action as the fob
 * service user — mirroring the validation of the human server actions so a
 * button can never do what a person could not.
 */
import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { writeAudit } from "@/lib/audit";
import { blockedByActiveAlert } from "@/lib/alert-guard";
import { minimumRepeatSeconds, readAlertState, startAlert, stopAlert } from "@/lib/alerts";
import type { ProtectAdapter } from "@/lib/protect/adapter";
import { localDateTimeParts } from "@/lib/scheduler/time";
import { triggerManualRun } from "@/lib/scheduler/executor";
import { getFobServiceUserId } from "./service-user";
import { sha256hex, type FobMappingRow } from "./provision";

/**
 * Two presses of the same slot inside this window count as one. LoRa retries
 * and nervous thumbs both land here; 2s matches the speaker cooldown.
 */
export const FOB_DEDUPE_MS = 2_000;

export type FobDispatchOutcome =
  | { kind: "unauthorized" }
  | { kind: "unknown" }
  | { kind: "disabled" }
  | { kind: "duplicate" }
  | { kind: "accepted"; action: FobMappingRow["action"]; note?: string }
  | { kind: "rejected"; message: string };

export function verifyFobToken(
  mapping: Pick<FobMappingRow, "tokenHash">,
  bearer: string | null,
): boolean {
  if (!mapping.tokenHash || !bearer) return false;
  const presented = Buffer.from(sha256hex(bearer), "utf8");
  const stored = Buffer.from(mapping.tokenHash, "utf8");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * Single-winner claim on the dedupe window: one UPDATE, atomic under SQLite's
 * write lock, shared by web and worker processes alike.
 */
export function claimFobPress(mappingId: number, now = Date.now()): boolean {
  const result = db
    .update(schema.fobMappings)
    .set({ lastTriggeredAt: now })
    .where(
      and(
        eq(schema.fobMappings.id, mappingId),
        or(
          isNull(schema.fobMappings.lastTriggeredAt),
          lte(schema.fobMappings.lastTriggeredAt, now - FOB_DEDUPE_MS),
        ),
      ),
    )
    .run();
  return result.changes > 0;
}

function auditPress(
  userId: number | null,
  accepted: boolean,
  mapping: FobMappingRow,
  extra: Record<string, unknown>,
): void {
  const fob = db
    .select({ name: schema.fobs.name })
    .from(schema.fobs)
    .where(eq(schema.fobs.mac, mapping.fobMac))
    .get();
  writeAudit({
    userId,
    action: accepted ? "fob.press" : "fob.press_rejected",
    targetType: "fobMapping",
    targetId: mapping.id,
    isEmergency: mapping.action !== "TRIGGER_CUE",
    detail: {
      fobMac: mapping.fobMac,
      fobName: fob?.name ?? null,
      button: mapping.button,
      pressType: mapping.pressType,
      action: mapping.action,
      ...extra,
    },
  });
}

export async function dispatchFobPress(
  adapter: ProtectAdapter,
  mappingId: number,
  bearer: string | null,
  now = Date.now(),
): Promise<FobDispatchOutcome> {
  const mapping = db
    .select()
    .from(schema.fobMappings)
    .where(eq(schema.fobMappings.id, mappingId))
    .get();
  if (!mapping) return { kind: "unknown" };

  if (!verifyFobToken(mapping, bearer)) {
    // A wrong token on a real mapping is exactly what an admin needs to see in
    // Activity: it means a stale alarm (or an impostor) is knocking.
    auditPress(null, false, mapping, { reason: "bad token" });
    return { kind: "unauthorized" };
  }

  if (!mapping.isEnabled) {
    // The sweep removes the NVR alarm shortly; until then the press is real
    // but intentionally inert — 200 so the NVR does not count it as a failure.
    auditPress(null, false, mapping, { reason: "mapping disabled" });
    return { kind: "disabled" };
  }

  if (!claimFobPress(mappingId, now)) {
    return { kind: "duplicate" };
  }

  const serviceUserId = getFobServiceUserId();

  const reject = (message: string): FobDispatchOutcome => {
    auditPress(serviceUserId, false, mapping, { reason: message });
    return { kind: "rejected", message };
  };

  if (mapping.action === "STOP_ALERT") {
    // Unconditional, like the UI's stop: an alert that cannot be silenced is
    // its own hazard. stopAlert() no-ops and stays silent if none is active.
    stopAlert(serviceUserId);
    auditPress(serviceUserId, true, mapping, {});
    return { kind: "accepted", action: mapping.action };
  }

  const cue = mapping.cueId
    ? db.select().from(schema.soundCues).where(eq(schema.soundCues.id, mapping.cueId)).get()
    : undefined;
  if (!cue) return reject("The mapped announcement no longer exists.");
  if (!cue.isEnabled) return reject(`"${cue.name}" is turned off.`);

  if (mapping.action === "START_ALERT") {
    if (!cue.isEmergency) return reject(`"${cue.name}" is not an emergency announcement.`);
    const active = readAlertState(now);
    if (active.active && active.cueId === cue.id) {
      // Re-press while the same alert sounds: deliberately a no-op — a second
      // press must never cancel or restart a running lockdown.
      auditPress(serviceUserId, true, mapping, { cue: cue.name, note: "already active" });
      return { kind: "accepted", action: mapping.action, note: "already active" };
    }
    const floor = minimumRepeatSeconds(cue);
    startAlert({
      cueId: cue.id,
      userId: serviceUserId,
      repeatSeconds: Math.max(floor, mapping.repeatSeconds ?? floor),
    });
    auditPress(serviceUserId, true, mapping, { cue: cue.name });
    return { kind: "accepted", action: mapping.action };
  }

  // TRIGGER_CUE
  if (cue.isEmergency) {
    // One-shot emergency: no block check, source EMERGENCY — same as the UI.
    auditPress(serviceUserId, true, mapping, { cue: cue.name });
    fireAndForget(adapter, serviceUserId, mapping, cue, "EMERGENCY");
    return { kind: "accepted", action: mapping.action };
  }

  const blocked = blockedByActiveAlert();
  if (blocked) return reject(blocked.message);

  auditPress(serviceUserId, true, mapping, { cue: cue.name });
  fireAndForget(adapter, serviceUserId, mapping, cue, "MANUAL");
  return { kind: "accepted", action: mapping.action };
}

/**
 * Playback can take many seconds and the NVR's webhook timeout is unknown —
 * answer the press immediately and let the run finish on its own. Failures
 * still land in the run row and the audit log.
 */
function fireAndForget(
  adapter: ProtectAdapter,
  serviceUserId: number,
  mapping: FobMappingRow,
  cue: typeof schema.soundCues.$inferSelect,
  source: "MANUAL" | "EMERGENCY",
): void {
  void triggerManualRun(adapter, {
    source,
    requestedBy: serviceUserId,
    cue,
    ...localDateTimeParts(),
  }).catch((err) => {
    writeAudit({
      userId: serviceUserId,
      action: "fob.play_failed",
      targetType: "fobMapping",
      targetId: mapping.id,
      isEmergency: source === "EMERGENCY",
      detail: { cue: cue.name, error: String((err as Error).message ?? err).slice(0, 300) },
    });
  });
}
