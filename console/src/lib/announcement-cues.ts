import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

/**
 * What the Announcements page and the phone app both show: every enabled cue,
 * split into ordinary tiles and emergency tiles, in tile order.
 */
export function loadAnnouncementCues(user: { canEmergency: boolean }) {
  const enabled = (isEmergency: boolean) =>
    db
      .select()
      .from(schema.soundCues)
      .where(and(eq(schema.soundCues.isEnabled, true), eq(schema.soundCues.isEmergency, isEmergency)))
      .orderBy(asc(schema.soundCues.sortOrder), asc(schema.soundCues.name))
      .all();

  return {
    presets: enabled(false),
    // Hidden, not merely disabled, for people without the permission. The
    // server actions check it again regardless — this is presentation.
    emergencies: user.canEmergency ? enabled(true) : [],
    zones: db.select({ id: schema.zones.id, name: schema.zones.name }).from(schema.zones).all(),
  };
}
