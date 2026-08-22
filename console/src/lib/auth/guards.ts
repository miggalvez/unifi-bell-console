import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  getSessionUser,
  getSessionUserDetailed,
  sessionCookieOptions,
  type SessionUser,
} from "./session";

// These guards are the real security boundary — call one at the top of every
// server action and route handler. The proxy cookie check is only UX.

/** `next`: where to come back to after signing in (the phone app passes "/m"). */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Administrator access required");
  return user;
}

export async function requireEmergency(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.canEmergency) throw new Error("Emergency permission required");
  return user;
}

/**
 * Route-handler variant: returns null instead of redirecting (caller sends 401).
 *
 * Also the one place the sliding session reaches the browser. Route handlers
 * may set cookies where Server Components cannot, and every page polls
 * /api/status, so re-issuing the cookie here whenever the row was renewed
 * keeps a long-lived login alive without touching each page.
 */
export async function getApiUser(): Promise<SessionUser | null> {
  const session = await getSessionUserDetailed();
  if (!session) return null;
  if (session.renewedExpiresAt !== undefined) {
    (await cookies()).set(SESSION_COOKIE, session.token, sessionCookieOptions(session.renewedExpiresAt));
  }
  return session.user;
}
