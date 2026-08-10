import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env, projectRoot } from "@/env";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

interface DbGlobal {
  __bellDb?: { sqlite: Database.Database; db: Db };
}

/**
 * Drizzle's synchronous SQLite migrator reads the latest migration before its
 * deferred BEGIN acquires a write lock. Parallel Next build workers can both
 * observe the same old row and then run the same CREATE TABLE. BEGIN IMMEDIATE
 * serializes that read-and-apply sequence across processes.
 */
function migrateSerialized(sqlite: Database.Database, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    // "SERIAL" means nothing to SQLite (the column gets no autoincrement and
    // its PK even admits NULLs) — kept verbatim because it is exactly the
    // table drizzle's own migrator creates, and every deployed database
    // already has it in this shape.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const latest = sqlite
      .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: number | string } | undefined;
    const latestAt = latest ? Number(latest.created_at) : null;

    for (const migration of migrations) {
      if (latestAt !== null && latestAt >= migration.folderMillis) continue;
      for (const statement of migration.sql) sqlite.exec(statement);
      sqlite
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(migration.hash, migration.folderMillis);
    }
    sqlite.exec("COMMIT");
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

// Singleton via globalThis so Next dev HMR doesn't stack connections.
// Both processes (and parallel Next build workers) may open the database at
// once; migrateSerialized + busy_timeout make that startup safe.
function init(): { sqlite: Database.Database; db: Db } {
  const g = globalThis as DbGlobal;
  if (g.__bellDb) return g.__bellDb;

  mkdirSync(dirname(env.dbPath), { recursive: true });
  const sqlite = new Database(env.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });
  // Migrations run with FK enforcement OFF, per SQLite's table-rebuild recipe.
  // The migrator wraps each migration in a transaction, where an in-file
  // "PRAGMA foreign_keys=OFF" is a silent no-op — with enforcement on, a
  // rebuild's DROP TABLE performs an implicit DELETE FROM, which fails against
  // RESTRICT references and, far worse, silently fires SET NULL/CASCADE
  // actions on referencing rows. Discovered live when migration 0011 hit a
  // RESTRICT; the connection-level default set here is what actually governs.
  sqlite.pragma("foreign_keys = OFF");
  migrateSerialized(sqlite, resolve(projectRoot, "drizzle"));
  const orphans = sqlite.pragma("foreign_key_check") as unknown[];
  if (orphans.length > 0) {
    throw new Error(`migrations left ${orphans.length} broken reference(s): ${JSON.stringify(orphans[0])}`);
  }
  sqlite.pragma("foreign_keys = ON");

  // Ensure the system_state singleton exists
  sqlite
    .prepare("INSERT OR IGNORE INTO system_state (id) VALUES (1)")
    .run();

  g.__bellDb = { sqlite, db };
  return g.__bellDb;
}

const instance = init();
export const sqlite = instance.sqlite;
export const db = instance.db;
export { schema };
