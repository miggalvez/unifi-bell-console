import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { seedUser } from "./helpers";
import { updateUser } from "@/app/(console)/settings/actions";

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
