/**
 * Fob inventory cache, filled from the private bootstrap. Upsert-only like the
 * speakers cache: a fob that drops out of a poll (dead battery, out of range)
 * goes stale instead of vanishing, and its mappings stay put.
 */
import { db, schema } from "@/lib/db/client";
import { normMac } from "@/lib/protect/adapter";
import type { Bootstrap } from "@/lib/protect/private";

export function upsertFobsFromBootstrap(b: Bootstrap, now = Date.now()): number {
  let touched = 0;
  for (const f of b.fobs ?? []) {
    if (!f.mac) continue;
    touched++;
    const values = {
      mac: normMac(f.mac),
      protectId: f.id ?? null,
      name: f.name ?? null,
      state: f.state ?? null,
      batteryStatus: f.wirelessConnectionState?.batteryStatus
        ? JSON.stringify(f.wirelessConnectionState.batteryStatus)
        : null,
      firmwareVersion: f.firmwareVersion ?? null,
      lastSeenAt: typeof f.lastSeen === "number" ? f.lastSeen : null,
      lastPolledAt: now,
      raw: JSON.stringify(f),
    };
    db.insert(schema.fobs)
      .values(values)
      .onConflictDoUpdate({ target: schema.fobs.mac, set: values })
      .run();
  }
  return touched;
}
