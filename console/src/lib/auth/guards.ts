import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "./session";

// These guards are the real security boundary — call one at the top of every
// server action and route handler. The proxy cookie check is only UX.

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
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

/** Route-handler variant: returns null instead of redirecting (caller sends 401). */
export async function getApiUser(): Promise<SessionUser | null> {
  return getSessionUser();
}
