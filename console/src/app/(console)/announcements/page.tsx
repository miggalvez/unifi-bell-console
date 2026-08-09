import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { Composer, PresetTiles } from "./composer";
import { EmergencyTiles } from "./emergency-tiles";
import { MicPage } from "./mic-page";
import { ffmpegAvailable } from "@/lib/audio";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const user = await requireUser();
  const presets = db
    .select()
    .from(schema.soundCues)
    .where(and(eq(schema.soundCues.isEnabled, true), eq(schema.soundCues.isEmergency, false)))
    .orderBy(asc(schema.soundCues.sortOrder), asc(schema.soundCues.name))
    .all();
  const emergencies = user.canEmergency
    ? db
        .select()
        .from(schema.soundCues)
        .where(and(eq(schema.soundCues.isEnabled, true), eq(schema.soundCues.isEmergency, true)))
        .orderBy(asc(schema.soundCues.sortOrder), asc(schema.soundCues.name))
        .all()
    : [];
  const zones = db.select({ id: schema.zones.id, name: schema.zones.name }).from(schema.zones).all();
  const ffmpegReady = await ffmpegAvailable();

  return (
    <>
      <PageHeader
        title="Announcements"
        description="Speak to the building — record your voice, type a message, or play a saved one."
      />
      <div className="space-y-6">
        {ffmpegReady ? <MicPage /> : null}
        <Composer zones={zones} />
        <div>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Saved announcements — tap to play
            </h2>
            {presets.length > 0 ? (
              <Link href="/sounds" className="text-xs text-primary hover:underline">
                Add, edit, or delete these
              </Link>
            ) : null}
          </div>
          <PresetTiles cues={presets} />
        </div>
        <EmergencyTiles cues={emergencies} />
      </div>
    </>
  );
}
