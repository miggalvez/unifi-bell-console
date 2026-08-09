import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, validateSession, destroySessionByToken } from "@/lib/auth/session";
import { db, schema } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { seedUser } from "./helpers";

describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("rejects tampered hashes without throwing", async () => {
    const hash = await hashPassword("secret");
    expect(await verifyPassword("secret", hash.slice(0, -4) + "AAAA")).toBe(false);
    expect(await verifyPassword("secret", "not-a-hash")).toBe(false);
  });
});

describe("sessions", () => {
  it("creates, validates, and destroys sessions", () => {
    const userId = seedUser();
    const { token } = createSession(userId);
    expect(validateSession(token)?.id).toBe(userId);
    destroySessionByToken(token);
    expect(validateSession(token)).toBeNull();
  });

  it("rejects expired sessions and disabled users", () => {
    const userId = db.select().from(schema.users).get()!.id;
    const { token } = createSession(userId);
    db.update(schema.sessions).set({ expiresAt: Date.now() - 1000 }).run();
    expect(validateSession(token)).toBeNull();

    const { token: token2 } = createSession(userId);
    db.update(schema.users).set({ isDisabled: true }).where(eq(schema.users.id, userId)).run();
    expect(validateSession(token2)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(validateSession("zz")).toBeNull();
    expect(validateSession("a".repeat(64))).toBeNull();
  });
});
