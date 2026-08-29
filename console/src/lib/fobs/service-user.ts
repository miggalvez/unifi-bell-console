/**
 * The synthetic user that keychain-remote (fob) presses run as. Every trigger
 * path threads a real users.id into scheduled_runs.requestedBy and the audit
 * log (FKs are enforced), so device presses need one too — and the alert
 * banner then honestly reads "started by Keychain remote".
 *
 * The row can never log in: its passwordHash is not in the scrypt$… format,
 * so verifyPassword() rejects any password before comparing. The Settings
 * users panel hides it and its actions refuse to touch it, so nobody can
 * hand it a real password.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getSetting, setSetting } from "@/lib/state";

export const FOB_SERVICE_USERNAME = "keychain-remote";
export const FOB_SERVICE_DISPLAY_NAME = "Keychain remote";
const SETTING_KEY = "fobServiceUserId";

/** Sentinel, deliberately unparseable by verifyPassword (not scrypt$…). */
const NO_LOGIN_HASH = "*fob*";

export function getFobServiceUserId(): number {
  const cached = getSetting<number | null>(SETTING_KEY, null);
  if (typeof cached === "number") {
    const row = db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, cached))
      .get();
    if (row) return row.id;
    // Settings survived but the row didn't (hand-edited DB): fall through and reseed.
  }

  const existing = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, FOB_SERVICE_USERNAME))
    .get();
  if (existing) {
    setSetting(SETTING_KEY, existing.id);
    return existing.id;
  }

  const now = Date.now();
  const id = db
    .insert(schema.users)
    .values({
      username: FOB_SERVICE_USERNAME,
      displayName: FOB_SERVICE_DISPLAY_NAME,
      passwordHash: NO_LOGIN_HASH,
      role: "STAFF",
      canEmergency: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.users.id })
    .get().id;
  setSetting(SETTING_KEY, id);
  return id;
}

export function isFobServiceUser(userId: number): boolean {
  return getSetting<number | null>(SETTING_KEY, null) === userId;
}
