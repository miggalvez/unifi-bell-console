"use server";

import { count, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, schema, sqlite } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  SESSION_COOKIE,
  createSession,
  destroySessionByToken,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";

export interface AuthFormState {
  error?: string;
}

export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!username || !password) return { error: "Username and password are required." };

  const user = db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  const ok = user && !user.isDisabled && (await verifyPassword(password, user.passwordHash));
  if (!ok) {
    writeAudit({ action: "auth.login_failed", detail: { username } });
    return { error: "Invalid username or password." };
  }

  const { token, expiresAt } = createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
  writeAudit({ userId: user.id, action: "auth.login" });
  redirect("/");
}

export async function bootstrapAdmin(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const username = String(formData.get("username") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim() || username;
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return { error: "Username must be 3–32 characters (letters, digits, . _ -)." };
  }
  if (password.length < 8) return { error: "Password must be at least 8 characters." };
  if (password !== confirm) return { error: "Passwords do not match." };

  const passwordHash = await hashPassword(password);
  const now = Date.now();

  // Only valid while the users table is empty — checked inside the transaction.
  let created: { id: number } | undefined;
  const tx = sqlite.transaction(() => {
    const existing = db.select({ n: count() }).from(schema.users).get();
    if ((existing?.n ?? 0) > 0) throw new Error("exists");
    created = db
      .insert(schema.users)
      .values({
        username,
        displayName,
        passwordHash,
        role: "ADMIN",
        canEmergency: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.users.id })
      .get();
  });
  try {
    tx();
  } catch {
    return { error: "An administrator already exists. Sign in instead." };
  }

  writeAudit({ userId: created!.id, action: "user.bootstrap_admin", detail: { username } });
  const { token, expiresAt } = createSession(created!.id);
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
  redirect("/");
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) destroySessionByToken(token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
