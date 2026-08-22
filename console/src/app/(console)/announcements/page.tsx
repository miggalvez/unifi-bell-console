import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { loadAnnouncementCues } from "@/lib/announcement-cues";
import { PageHeader } from "@/components/page-header";
import { Composer, PresetTiles } from "./composer";
import { EmergencyTiles } from "./emergency-tiles";
import { MicPage } from "./mic-page";
import { ffmpegAvailable } from "@/lib/audio";

export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const user = await requireUser();
  const { presets, emergencies, zones } = loadAnnouncementCues(user);
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
