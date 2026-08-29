/**
 * Keychain-remote (fob) alarm provisioning. The console owns a set of alarms
 * on the NVR's v2 Alarm Manager — one per enabled fob mapping — each wired
 * "button press → webhook back to us". This module reconciles desired state
 * (the fob_mappings table + the configured base URL) against what the NVR
 * actually has, creating and deleting as needed.
 *
 * Ownership contract: we only ever touch alarms we created, recognized by the
 * "Bell Console: " title prefix or a stored alarm id. Everything else on the
 * NVR is somebody else's and is never listed, edited, or deleted.
 *
 * There is no alarm-update call (unverified on this surface), so any config
 * change is delete + recreate — which also re-mints the bearer token.
 */
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema, sqlite } from "@/lib/db/client";
import { getSetting, updateSystemState } from "@/lib/state";
import { writeAudit } from "@/lib/audit";
import type { ProtectAdapter } from "@/lib/protect/adapter";

export const FOB_ALARM_TITLE_PREFIX = "Bell Console: ";
export const FOB_TRIGGER_ID = "protect:button.buttonPressed";

/** How long one reconcile pass may hold the cross-process lease. */
const LEASE_MS = 60_000;
/** Settings key for the console URL the NVR posts webhooks to. */
export const FOB_BASE_URL_KEY = "fobWebhookBaseUrl";

export type FobMappingRow = typeof schema.fobMappings.$inferSelect;
export type FobButton = FobMappingRow["button"];
export type FobPressType = FobMappingRow["pressType"];

export const FOB_BUTTON_LABELS: Record<FobButton, string> = {
  arm: "Arm",
  night: "Night Mode",
  disarm: "Disarm",
  panic: "Panic",
  left: "Left",
  right: "Right",
};

export const FOB_PRESS_LABELS: Record<FobPressType, string> = {
  press: "single press",
  longPress: "long press",
  doublePress: "double press",
};

export function buildAlarmTitle(m: FobMappingRow, fobName: string | null): string {
  const who = fobName?.trim() || m.fobMac;
  return `${FOB_ALARM_TITLE_PREFIX}${who} — ${FOB_BUTTON_LABELS[m.button]} (${FOB_PRESS_LABELS[m.pressType]}) [#${m.id}]`;
}

/** Scope token format verified against the NVR's live all-buttons catalogue. */
export function buildScopeValue(m: Pick<FobMappingRow, "fobMac" | "button">): string {
  return `${m.fobMac}:button=${m.button}`;
}

export function buildWebhookUrl(baseUrl: string, mappingId: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/fob-hooks/${mappingId}`;
}

/**
 * What must match on the NVR for the alarm to be considered current. Action
 * and cue are deliberately absent: they are console-side dispatch, and
 * changing them must not churn NVR alarms.
 */
export function desiredConfigHash(
  m: Pick<FobMappingRow, "fobMac" | "button" | "pressType">,
  baseUrl: string,
): string {
  return sha256hex(
    JSON.stringify({ fobMac: m.fobMac, button: m.button, pressType: m.pressType, baseUrl }),
  );
}

export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateBaseUrl(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a full URL, like http://192.168.1.50:3000" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "The address must start with http:// or https://" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]") {
    return {
      ok: false,
      error: "Use this machine's LAN address — the NVR cannot reach localhost.",
    };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "The address should not include a query or #fragment." };
  }
  return { ok: true, value: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** Asks the worker to reconcile on its next pass (a few seconds). */
export function requestFobReconcile(): void {
  updateSystemState({ fobReprovisionFlag: true });
}

/**
 * Push config toward the NVR right away so the UI shows Active within a
 * moment — but never make an admin wait on a slow or dead NVR. Callers set
 * the flag first (requestFobReconcile) so the worker remains the guaranteed
 * path; the lease keeps the two from double-creating.
 */
export async function attemptFobReconcile(adapter: ProtectAdapter): Promise<void> {
  const attempt = reconcileFobAlarms(adapter).catch(() => undefined);
  await Promise.race([attempt, new Promise((r) => setTimeout(r, 4000))]);
}

export interface ReconcileResult {
  /** False when another pass holds the lease (or the lease claim failed). */
  ran: boolean;
  /** False when the NVR's Alarm Manager has no fob button trigger. */
  supported: boolean;
  created: number;
  deleted: number;
  errors: number;
}

const NOT_RUN: ReconcileResult = { ran: false, supported: true, created: 0, deleted: 0, errors: 0 };

/** Claim the cross-process lease; the worker and inline attempts both come here. */
function tryClaimLease(now: number): boolean {
  const claim = sqlite.transaction(() => {
    const state = db
      .select({ lockUntil: schema.systemState.fobProvisionLockUntil })
      .from(schema.systemState)
      .where(eq(schema.systemState.id, 1))
      .get();
    if ((state?.lockUntil ?? 0) > now) return false;
    db.update(schema.systemState)
      .set({ fobProvisionLockUntil: now + LEASE_MS })
      .where(eq(schema.systemState.id, 1))
      .run();
    return true;
  });
  return claim.immediate();
}

function releaseLease(): void {
  updateSystemState({ fobProvisionLockUntil: null });
}

function markMapping(id: number, patch: Partial<typeof schema.fobMappings.$inferInsert>): void {
  db.update(schema.fobMappings)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.fobMappings.id, id))
    .run();
}

/** Best-effort pressType/scope out of the alarm read model. Undefined = unknown. */
function readAlarmConfig(raw: Record<string, unknown>): {
  pressType?: string;
  scopeValue?: string;
} {
  const out: { pressType?: string; scopeValue?: string } = {};
  try {
    const cats = raw.trigger_categories as { triggers?: { data?: { pressType?: unknown } }[] }[] | undefined;
    for (const cat of cats ?? []) {
      for (const t of cat.triggers ?? []) {
        if (typeof t.data?.pressType === "string") out.pressType = t.data.pressType;
      }
    }
    const scope = raw.scope as { data?: { scope_all_buttons?: unknown[] } } | undefined;
    const first = scope?.data?.scope_all_buttons?.[0];
    if (typeof first === "string") out.scopeValue = first;
  } catch {
    // Read-model shape drifted — treat as unknown rather than claim a mismatch.
  }
  return out;
}

/**
 * One reconcile pass. Never throws for per-alarm problems (each marks its
 * mapping ERROR and moves on); a transport-level failure (NVR unreachable)
 * records a global error and leaves the reprovision flag set for a retry.
 */
export async function reconcileFobAlarms(
  adapter: ProtectAdapter,
  opts: { force?: boolean } = {},
): Promise<ReconcileResult> {
  const now = Date.now();
  if (!tryClaimLease(now)) return NOT_RUN;

  let created = 0;
  let deleted = 0;
  let errors = 0;
  let supported = true;

  try {
    updateSystemState({ fobReprovisionFlag: false });

    const mappings = db.select().from(schema.fobMappings).all();
    const enabled = mappings.filter((m) => m.isEnabled);
    const baseUrl = getSetting<string | null>(FOB_BASE_URL_KEY, null);

    if (enabled.length > 0 && !baseUrl) {
      for (const m of enabled) {
        markMapping(m.id, {
          provisionState: "ERROR",
          provisionError: "Set the console address in Settings first.",
        });
      }
      updateSystemState({
        fobLastReconcileAt: now,
        fobLastReconcileError: "Console address not configured.",
      });
      return { ran: true, supported, created, deleted, errors: enabled.length };
    }

    let triggerIds: string[];
    let nvrAlarms: Awaited<ReturnType<ProtectAdapter["listAlarms"]>>;
    try {
      triggerIds = await adapter.alarmManifestTriggerIds();
      nvrAlarms = await adapter.listAlarms();
    } catch (err) {
      const message = String((err as Error).message ?? err).slice(0, 300);
      updateSystemState({
        fobLastReconcileAt: now,
        fobLastReconcileError: message,
        fobReprovisionFlag: true, // retry soon; worker spaces failed attempts
      });
      return { ran: true, supported, created, deleted, errors: errors + 1 };
    }

    const fobNames = new Map(
      db.select({ mac: schema.fobs.mac, name: schema.fobs.name }).from(schema.fobs).all()
        .map((f) => [f.mac, f.name] as const),
    );

    const knownIds = new Set(mappings.map((m) => m.nvrAlarmId).filter((x): x is string => !!x));
    const owned = nvrAlarms.filter(
      (a) => a.title.startsWith(FOB_ALARM_TITLE_PREFIX) || knownIds.has(a.id),
    );
    const ownedById = new Map(owned.map((a) => [a.id, a]));

    if (!triggerIds.includes(FOB_TRIGGER_ID)) {
      // This UniFi OS has no fob button trigger (old Protect, or the external
      // alarm manager is off). Nothing we provisioned can work — say so and
      // clean up rather than leaving dead alarms around.
      supported = false;
      for (const a of owned) {
        try {
          await adapter.deleteAlarm(a.id);
          deleted++;
        } catch {
          errors++;
        }
      }
      for (const m of mappings) {
        markMapping(m.id, {
          nvrAlarmId: null,
          tokenHash: null,
          desiredHash: null,
          provisionState: "UNSUPPORTED",
          provisionError:
            "This UniFi OS version has no keychain-remote button trigger — update Protect on the NVR.",
        });
      }
      updateSystemState({ fobLastReconcileAt: now, fobLastReconcileError: null });
      return { ran: true, supported, created, deleted, errors };
    }

    // Create / recreate every enabled mapping that is missing or stale.
    const validAlarmIds = new Set<string>();
    for (const m of enabled) {
      const desired = desiredConfigHash(m, baseUrl!);
      const existing = m.nvrAlarmId ? ownedById.get(m.nvrAlarmId) : undefined;

      let stale =
        opts.force || !existing || !m.tokenHash || m.desiredHash !== desired;
      if (!stale && existing) {
        const cfg = readAlarmConfig(existing.raw);
        if (
          (cfg.pressType !== undefined && cfg.pressType !== m.pressType) ||
          (cfg.scopeValue !== undefined && cfg.scopeValue !== buildScopeValue(m))
        ) {
          stale = true; // someone edited it on the NVR — take it back
        }
      }

      if (!stale) {
        validAlarmIds.add(m.nvrAlarmId!);
        if (m.provisionState !== "OK") {
          markMapping(m.id, { provisionState: "OK", provisionError: null });
        }
        continue;
      }

      try {
        if (existing) {
          await adapter.deleteAlarm(existing.id);
          deleted++;
        }
        const token = randomBytes(32).toString("base64url");
        const alarmId = await adapter.createAlarm({
          title: buildAlarmTitle(m, fobNames.get(m.fobMac) ?? null),
          pressType: m.pressType,
          scopeValue: buildScopeValue(m),
          webhook: { url: buildWebhookUrl(baseUrl!, m.id), token },
        });
        created++;
        validAlarmIds.add(alarmId);
        markMapping(m.id, {
          nvrAlarmId: alarmId,
          tokenHash: sha256hex(token),
          desiredHash: desired,
          provisionState: "OK",
          provisionError: null,
        });
      } catch (err) {
        errors++;
        markMapping(m.id, {
          provisionState: "ERROR",
          provisionError: String((err as Error).message ?? err).slice(0, 300),
        });
      }
    }

    // Sweep: every owned alarm no enabled mapping stands behind — deleted or
    // disabled mappings, and half-created strays from an earlier crash.
    for (const a of owned) {
      if (validAlarmIds.has(a.id)) continue;
      try {
        await adapter.deleteAlarm(a.id);
        deleted++;
      } catch {
        errors++;
      }
    }
    for (const m of mappings) {
      if (m.isEnabled || !m.nvrAlarmId) continue;
      markMapping(m.id, {
        nvrAlarmId: null,
        tokenHash: null,
        desiredHash: null,
        provisionState: "PENDING",
        provisionError: null,
      });
    }

    updateSystemState({
      fobLastReconcileAt: now,
      fobLastReconcileError: null,
      ...(errors > 0 ? { fobReprovisionFlag: true } : {}),
    });
    if (created > 0 || deleted > 0) {
      writeAudit({ action: "fob.provisioned", detail: { created, deleted, errors } });
    } else if (errors > 0) {
      writeAudit({ action: "fob.provision_failed", detail: { errors } });
    }
    return { ran: true, supported, created, deleted, errors };
  } finally {
    releaseLease();
  }
}
