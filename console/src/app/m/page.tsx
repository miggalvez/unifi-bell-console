import { requireUser } from "@/lib/auth/guards";
import { loadAnnouncementCues } from "@/lib/announcement-cues";
import { Composer, PresetTiles } from "@/app/(console)/announcements/composer";
import { EmergencyTiles } from "@/app/(console)/announcements/emergency-tiles";
import { InstallHint } from "@/components/install-hint";

export const dynamic = "force-dynamic";

export default async function PhonePage() {
  const user = await requireUser("/m");
  const { presets, emergencies, zones } = loadAnnouncementCues(user);

  // Order is for a thumb, not a mouse: the one-tap tiles first, the emergency
  // tiles still on the first screen, and the keyboard-driven composer last so
  // typing never pushes the red tiles around.
  return (
    <>
      <InstallHint />
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          Saved announcements — tap to play
        </h2>
        <PresetTiles cues={presets} />
      </section>
      <EmergencyTiles cues={emergencies} />
      <Composer zones={zones} />
    </>
  );
}
