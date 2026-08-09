import { NextResponse } from "next/server";
import { desc, eq, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getApiUser } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const runs = db
    .select({
      id: schema.scheduledRuns.id,
      at: schema.scheduledRuns.scheduledAtUtc,
      source: schema.scheduledRuns.source,
      cueName: schema.scheduledRuns.cueName,
      deliveryMethod: schema.scheduledRuns.deliveryMethod,
      ttsText: schema.scheduledRuns.ttsText,
      status: schema.scheduledRuns.status,
      httpStatus: schema.scheduledRuns.httpStatus,
      latencyMs: schema.scheduledRuns.latencyMs,
      resultMessage: schema.scheduledRuns.resultMessage,
      localTime: schema.scheduledRuns.localTime,
      localDate: schema.scheduledRuns.localDate,
      requestedByName: schema.users.displayName,
    })
    .from(schema.scheduledRuns)
    .leftJoin(schema.users, eq(schema.scheduledRuns.requestedBy, schema.users.id))
    // Activity is a record of what happened. Bells still waiting to ring are
    // scheduled up to a month ahead, and sorting by time would otherwise put
    // that whole future queue above today's history.
    .where(ne(schema.scheduledRuns.status, "PENDING"))
    .orderBy(desc(schema.scheduledRuns.scheduledAtUtc))
    .limit(limit)
    .all();

  const audits = db
    .select({
      id: schema.auditLog.id,
      at: schema.auditLog.at,
      action: schema.auditLog.action,
      targetType: schema.auditLog.targetType,
      targetId: schema.auditLog.targetId,
      isEmergency: schema.auditLog.isEmergency,
      detail: schema.auditLog.detail,
      userName: schema.users.displayName,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, eq(schema.auditLog.userId, schema.users.id))
    .orderBy(desc(schema.auditLog.at))
    .limit(limit)
    .all();

  return NextResponse.json({ runs, audits });
}
