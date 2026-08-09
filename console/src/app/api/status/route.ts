import { NextResponse } from "next/server";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getApiUser } from "@/lib/auth/guards";
import { getSystemState, isPaused } from "@/lib/state";
import { env } from "@/env";
import { readAlertState } from "@/lib/alerts";
import { readDrillState } from "@/lib/drills";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const state = getSystemState();
  const now = Date.now();
  const speakersTotal = db.select({ n: count() }).from(schema.speakers).get()?.n ?? 0;
  const speakersOnline =
    db
      .select({ n: count() })
      .from(schema.speakers)
      .where(eq(schema.speakers.state, "CONNECTED"))
      .get()?.n ?? 0;

  const keyDaysLeft =
    state.apiKeyExpiresAt === null ? null : Math.floor((state.apiKeyExpiresAt - now) / 86_400_000);

  const nextRuns = db
    .select({
      id: schema.scheduledRuns.id,
      cueName: schema.scheduledRuns.cueName,
      localDate: schema.scheduledRuns.localDate,
      localTime: schema.scheduledRuns.localTime,
      scheduledAtUtc: schema.scheduledRuns.scheduledAtUtc,
    })
    .from(schema.scheduledRuns)
    .where(and(eq(schema.scheduledRuns.status, "PENDING"), gt(schema.scheduledRuns.scheduledAtUtc, now)))
    .orderBy(asc(schema.scheduledRuns.scheduledAtUtc))
    .limit(8)
    .all();

  return NextResponse.json({
    // The school's timezone is what bells are scheduled in; a browser opened
    // elsewhere (or on a machine with a wrong clock) must still show it.
    schoolTz: env.schoolTz,
    alert: readAlertState(now),
    drill: readDrillState(now),
    nextRuns,
    now,
    paused: isPaused(state, now),
    pausedUntil: state.pausedUntil,
    pauseReason: state.pauseReason,
    health: {
      lastOkAt: state.lastHealthOkAt,
      lastError: state.lastHealthError,
      consecutiveFailures: state.consecutiveHealthFailures,
      degraded: state.consecutiveHealthFailures >= 3,
      usingCloudFallback: state.usingCloudFallback,
    },
    speakers: { online: speakersOnline, total: speakersTotal },
    tts: { revalidate: state.ttsRevalidateFlag, reason: state.ttsFlagReason },
    apiKey: { expiresAt: state.apiKeyExpiresAt, daysLeft: keyDaysLeft, warning: keyDaysLeft !== null && keyDaysLeft < 7 },
  });
}
