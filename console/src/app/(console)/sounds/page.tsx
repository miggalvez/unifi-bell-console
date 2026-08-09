import { asc, desc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { ffmpegAvailable, formatDuration } from "@/lib/audio";
import { preambleCue } from "@/lib/drills";
import { PageHeader } from "@/components/page-header";
import { CuesTable } from "./cues-table";
import { asc as ascOrder } from "drizzle-orm";
import { AudioLibrary, type AudioItem } from "./audio-library";

export const dynamic = "force-dynamic";

export default async function SoundsPage() {
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";

  const cues = db
    .select()
    .from(schema.soundCues)
    .orderBy(asc(schema.soundCues.sortOrder), asc(schema.soundCues.name))
    .all();
  const zones = db.select({ id: schema.zones.id, name: schema.zones.name }).from(schema.zones).all();
  const audio = db.select().from(schema.audioFiles).orderBy(desc(schema.audioFiles.createdAt)).all();
  const ffmpegReady = await ffmpegAvailable();

  const audioItems: AudioItem[] = audio.map((a) => ({
    id: a.id,
    name: a.name,
    originalName: a.originalName,
    sizeBytes: a.sizeBytes,
    durationMs: a.durationMs,
    durationLabel: formatDuration(a.durationMs),
  }));

  const parts = db
    .select({
      cueId: schema.soundCueParts.cueId,
      audioFileId: schema.soundCueParts.audioFileId,
      position: schema.soundCueParts.position,
    })
    .from(schema.soundCueParts)
    .orderBy(ascOrder(schema.soundCueParts.cueId), ascOrder(schema.soundCueParts.position))
    .all();
  const cuesWithParts = cues.map((c) => ({
    ...c,
    partIds: parts.filter((p) => p.cueId === c.id).map((p) => p.audioFileId),
  }));

  return (
    <>
      <PageHeader
        title="Sounds"
        description="Sounds, spoken messages, and recordings the school can play."
      />
      <div className="space-y-6">
        <CuesTable
          cues={cuesWithParts}
          zones={zones}
          audioFiles={audio.map((a) => ({ id: a.id, name: a.name }))}
          isAdmin={isAdmin}
          drillTagCueId={preambleCue()?.id ?? null}
        />
        <AudioLibrary files={audioItems} isAdmin={isAdmin} ffmpegReady={ffmpegReady} />
      </div>
    </>
  );
}
