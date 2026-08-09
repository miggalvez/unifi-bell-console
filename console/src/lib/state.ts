import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export type SystemState = typeof schema.systemState.$inferSelect;

export function getSystemState(): SystemState {
  const row = db.select().from(schema.systemState).where(eq(schema.systemState.id, 1)).get();
  if (!row) throw new Error("system_state singleton missing — migrations not applied?");
  return row;
}

export function updateSystemState(patch: Partial<Omit<SystemState, "id">>): void {
  db.update(schema.systemState).set(patch).where(eq(schema.systemState.id, 1)).run();
}

export function isPaused(state: SystemState, now = Date.now()): boolean {
  return state.pausedUntil !== null && state.pausedUntil > now;
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function getSettingNumber(key: string, fallback: number): number {
  const v = getSetting<unknown>(key, fallback);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function setSetting(key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } })
    .run();
}
