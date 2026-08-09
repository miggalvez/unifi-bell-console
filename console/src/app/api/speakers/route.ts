import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getApiUser } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const speakers = db
    .select({
      id: schema.speakers.id,
      mac: schema.speakers.mac,
      name: schema.speakers.name,
      state: schema.speakers.state,
      status: schema.speakers.status,
      volume: schema.speakers.volume,
      firmwareVersion: schema.speakers.firmwareVersion,
      lastSeenOnlineAt: schema.speakers.lastSeenOnlineAt,
      lastPolledAt: schema.speakers.lastPolledAt,
    })
    .from(schema.speakers)
    .orderBy(asc(schema.speakers.name))
    .all();

  return NextResponse.json({ speakers });
}
