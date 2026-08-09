import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env, projectRoot } from "@/env";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

interface DbGlobal {
  __bellDb?: { sqlite: Database.Database; db: Db };
}

// Singleton via globalThis so Next dev HMR doesn't stack connections.
// Both processes (web + worker) run migrations at boot; drizzle's migrator is
// transactional and busy_timeout makes a simultaneous start safe.
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
  migrate(db, { migrationsFolder: resolve(projectRoot, "drizzle") });
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
