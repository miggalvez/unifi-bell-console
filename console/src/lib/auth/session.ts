import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "@/lib/db/client";
import { env } from "@/env";
import { getSettingNumber } from "@/lib/state";
import { SESSION_COOKIE } from "./routing";

export { SESSION_COOKIE };

const DAY_MS = 24 * 60 * 60 * 1000;

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionUser = typeof schema.users.$inferSelect;

export function createSession(userId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  const sessionDays = getSettingNumber("sessionDays", 14);
  const expiresAt = now + sessionDays * DAY_MS;
  db.insert(schema.sessions)
    .values({ id: tokenId(token), userId, createdAt: now, expiresAt, lastSeenAt: now })
    .run();
  return { token, expiresAt };
}

export function destroySessionByToken(token: string): void {
  db.delete(schema.sessions).where(eq(schema.sessions.id, tokenId(token))).run();
}

export interface ValidatedSession {
  user: SessionUser;
  /** Set when this call pushed the expiry out — the browser cookie should follow. */
  renewedExpiresAt?: number;
}

/**
 * Validates a raw cookie token; applies sliding renewal past half-life.
 *
 * Renewal only moves the database row. The browser keeps the expiry its
 * cookie was issued with, so somewhere that *can* set cookies — a route
 * handler; Server Components cannot — must re-issue it from
 * `renewedExpiresAt`. Without that an installed phone app signs itself out a
 * fortnight after login however often it is used.
 */
export function validateSessionDetailed(token: string): ValidatedSession | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const now = Date.now();
  const id = tokenId(token);
  const row = db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.id, id), gt(schema.sessions.expiresAt, now)))
    .get();
  if (!row || row.user.isDisabled) return null;

  const sessionDays = getSettingNumber("sessionDays", 14);
  const fullTtl = sessionDays * DAY_MS;
  const remaining = row.session.expiresAt - now;
  const patch: Partial<typeof schema.sessions.$inferInsert> = { lastSeenAt: now };
  const result: ValidatedSession = { user: row.user };
  if (remaining < fullTtl / 2) {
    patch.expiresAt = now + fullTtl;
    result.renewedExpiresAt = patch.expiresAt;
  }
  db.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).run();

  return result;
}

export function validateSession(token: string): SessionUser | null {
  return validateSessionDetailed(token)?.user ?? null;
}

export function pruneExpiredSessions(): void {
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run();
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.secureCookies,
    path: "/",
    expires: new Date(expiresAt),
  };
}

/** Server-side helper: current session from the request cookie, or null. */
export async function getSessionUserDetailed(): Promise<(ValidatedSession & { token: string }) | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const validated = validateSessionDetailed(token);
  return validated ? { ...validated, token } : null;
}

/** Server-side helper: current user from the request cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return (await getSessionUserDetailed())?.user ?? null;
}
