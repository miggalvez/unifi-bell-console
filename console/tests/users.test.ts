import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { seedUser } from "./helpers";
import { createUser, updateUser } from "@/app/(console)/settings/actions";

let adminId: number;

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => ({ id: adminId, role: "ADMIN", displayName: "Tester" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

function seedStaff(): number {
  const now = Date.now();
  return db
    .insert(schema.users)
    .values({
      username: "jordan",
      displayName: "Jordan Lee",
      passwordHash: "x",
      role: "STAFF",
      canEmergency: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.users.id })
    .get().id;
}

const readUser = (id: number) =>
  db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;

let staffId: number;

beforeEach(() => {
  db.delete(schema.auditLog).run();
  db.delete(schema.users).run();
  adminId = seedUser();
  staffId = seedStaff();
});

describe("editing a person", () => {
  it("saves a new name and emergency permission together", async () => {
    const result = await updateUser(staffId, {
      displayName: "Jordan Lee-Nakamura",
      canEmergency: false,
    });

    expect(result.ok).toBe(true);
    const user = readUser(staffId);
    expect(user.displayName).toBe("Jordan Lee-Nakamura");
    expect(user.canEmergency).toBe(false);
  });

  it("trims surrounding whitespace from the name", async () => {
    await updateUser(staffId, { displayName: "  Jordan Lee  " });

    expect(readUser(staffId).displayName).toBe("Jordan Lee");
  });

  it("rejects a blank name without touching the row", async () => {
    const result = await updateUser(staffId, { displayName: "   ", canEmergency: false });

    expect(result.ok).toBe(false);
    const user = readUser(staffId);
    expect(user.displayName).toBe("Jordan Lee");
    // The whole patch is refused, not just the bad field.
    expect(user.canEmergency).toBe(true);
  });

  it("rejects a name longer than 64 characters", async () => {
    const result = await updateUser(staffId, { displayName: "x".repeat(65) });

    expect(result.ok).toBe(false);
    expect(readUser(staffId).displayName).toBe("Jordan Lee");
  });

  it("records the change in the audit log", async () => {
    await updateUser(staffId, { displayName: "  Jordan Lee-Nakamura  ", canEmergency: false });

    const entry = db.select().from(schema.auditLog).all().at(-1)!;
    expect(entry.action).toBe("user.update");
    expect(entry.targetId).toBe(String(staffId));
    // The normalized value is logged, so the trail matches what was stored.
    expect(JSON.parse(entry.detail!)).toEqual({
      displayName: "Jordan Lee-Nakamura",
      canEmergency: false,
    });
  });

  it("still refuses to let an admin demote themselves", async () => {
    const result = await updateUser(adminId, { role: "STAFF" });

    expect(result.ok).toBe(false);
    expect(readUser(adminId).role).toBe("ADMIN");
  });
});

// A server action is a public POST endpoint and its parameter type is erased at
// runtime, so these go through the same door a crafted request would.
describe("editing a person: untrusted input", () => {
  const asPatch = (o: unknown) => o as Parameters<typeof updateUser>[1];

  it("ignores columns that are not editable", async () => {
    const before = readUser(staffId);

    const result = await updateUser(
      staffId,
      asPatch({ username: "root", passwordHash: "pwned", createdAt: 0, id: 999 }),
    );

    expect(result.ok).toBe(true);
    const after = readUser(staffId);
    expect(after.username).toBe(before.username);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.id).toBe(before.id);
  });

  it("does not write or audit when a patch carries nothing editable", async () => {
    await updateUser(staffId, asPatch({ passwordHash: "pwned" }));

    expect(db.select().from(schema.auditLog).all()).toHaveLength(0);
  });

  it("still applies the editable fields alongside ignored ones", async () => {
    const result = await updateUser(
      staffId,
      asPatch({ displayName: "Jordan Lee-Nakamura", passwordHash: "pwned" }),
    );

    expect(result.ok).toBe(true);
    const after = readUser(staffId);
    expect(after.displayName).toBe("Jordan Lee-Nakamura");
    expect(after.passwordHash).toBe("x");
  });

  it("rejects a non-string name instead of throwing", async () => {
    const result = await updateUser(staffId, asPatch({ displayName: null }));

    expect(result.ok).toBe(false);
    expect(readUser(staffId).displayName).toBe("Jordan Lee");
  });

  it("rejects a non-boolean emergency flag rather than coercing it", async () => {
    const result = await updateUser(staffId, asPatch({ canEmergency: "yes" }));

    expect(result.ok).toBe(false);
    expect(readUser(staffId).canEmergency).toBe(true);
  });

  it("rejects an unknown role", async () => {
    const result = await updateUser(staffId, asPatch({ role: "SUPERUSER" }));

    expect(result.ok).toBe(false);
    expect(readUser(staffId).role).toBe("STAFF");
  });
});

describe("creating a person", () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it("holds the same name bound as editing does", async () => {
    const result = await createUser(
      { ok: false },
      form({ username: "newbie", displayName: "x".repeat(65), password: "longenough" }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/1–64/);
  });

  it("trims the name it stores", async () => {
    const result = await createUser(
      { ok: false },
      form({ username: "newbie", displayName: "  Sam Vale  ", password: "longenough" }),
    );

    expect(result.ok).toBe(true);
    const created = db.select().from(schema.users).all().find((u) => u.username === "newbie")!;
    expect(created.displayName).toBe("Sam Vale");
  });
});
