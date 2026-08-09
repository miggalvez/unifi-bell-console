import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, schema } from "@/lib/db/client";
import { env } from "@/env";
import { getSettingNumber } from "@/lib/state";

export const SESSION_COOKIE = "bell_session";

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

/** Validates a raw cookie token; applies sliding renewal past half-life. */
export function validateSession(token: string): SessionUser | null {
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
  if (remaining < fullTtl / 2) patch.expiresAt = now + fullTtl;
  db.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).run();

  return row.user;
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

/** Server-side helper: current user from the request cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSession(token);
}
