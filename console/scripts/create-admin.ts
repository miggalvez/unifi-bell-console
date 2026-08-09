/**
 * Lockout recovery: create (or reset) an ADMIN user from the command line.
 * Usage: npx tsx scripts/create-admin.ts <username> <password> [displayName]
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { writeAudit } from "@/lib/audit";

async function main(): Promise<void> {
  const [username, password, displayName] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: npx tsx scripts/create-admin.ts <username> <password> [displayName]");
    process.exit(1);
  }

  const now = Date.now();
  const passwordHash = await hashPassword(password);
  const existing = db.select().from(schema.users).where(eq(schema.users.username, username)).get();

  if (existing) {
    db.update(schema.users)
      .set({ passwordHash, role: "ADMIN", isDisabled: false, updatedAt: now })
      .where(eq(schema.users.id, existing.id))
      .run();
    writeAudit({ action: "user.reset_via_cli", targetType: "user", targetId: existing.id });
    console.log(`Updated existing user "${username}" — password reset, role ADMIN, enabled.`);
  } else {
    const created = db
      .insert(schema.users)
      .values({
        username,
        displayName: displayName ?? username,
        passwordHash,
        role: "ADMIN",
        canEmergency: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.users.id })
      .get();
    writeAudit({ action: "user.create_via_cli", targetType: "user", targetId: created.id });
    console.log(`Created ADMIN user "${username}".`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
