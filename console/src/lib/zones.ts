import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export interface ZoneWithMembers {
  id: number;
  name: string;
  description: string | null;
  memberMacs: string[];
}

export function listZonesWithMembers(): ZoneWithMembers[] {
  const zones = db.select().from(schema.zones).orderBy(asc(schema.zones.name)).all();
  const members = db.select().from(schema.zoneMembers).all();
  return zones.map((z) => ({
    id: z.id,
    name: z.name,
    description: z.description,
    memberMacs: members.filter((m) => m.zoneId === z.id).map((m) => m.speakerMac),
  }));
}

/**
 * Resolve playback targets for TTS. A zone id resolves to its member MACs;
 * null/undefined (or an empty zone) means every known speaker — the safe
 * default for a PA system is "everyone hears it", not silence.
 */
export function resolveTargetMacs(zoneId: number | null | undefined): string[] {
  if (zoneId != null) {
    const members = db
      .select({ mac: schema.zoneMembers.speakerMac })
      .from(schema.zoneMembers)
      .where(eq(schema.zoneMembers.zoneId, zoneId))
      .all();
    if (members.length > 0) return members.map((m) => m.mac);
  }
  return db.select({ mac: schema.speakers.mac }).from(schema.speakers).all().map((s) => s.mac);
}
