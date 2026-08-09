import { db, schema } from "@/lib/db/client";

export function writeAudit(entry: {
  userId?: number | null;
  action: string;
  targetType?: string;
  targetId?: string | number;
  isEmergency?: boolean;
  detail?: unknown;
}): void {
  db.insert(schema.auditLog)
    .values({
      at: Date.now(),
      userId: entry.userId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId === undefined ? undefined : String(entry.targetId),
      isEmergency: entry.isEmergency ?? false,
      detail: entry.detail === undefined ? undefined : JSON.stringify(entry.detail),
    })
    .run();
}
