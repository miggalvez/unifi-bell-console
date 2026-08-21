import { requireUser } from "@/lib/auth/guards";
import { loadAnnouncementCues } from "@/lib/announcement-cues";
import { Composer, PresetTiles } from "@/app/(console)/announcements/composer";
import { EmergencyTiles } from "@/app/(console)/announcements/emergency-tiles";
import { InstallHint } from "@/components/install-hint";

export const dynamic = "force-dynamic";

export default async function PhonePage() {
  const user = await requireUser("/m");
  const { presets, emergencies, zones } = loadAnnouncementCues(user);

  // Order is for a thumb: the everyday one-tap tiles first, then the
  // hold-to-arm emergency tiles, then the keyboard-driven composer last so
  // typing never shifts the tiles above it. On a phone the emergency tiles
  // sit below the preset list rather than on the first screen — deliberately,
  // so routine use does not scroll past red "lockdown" tiles every time. The
  // time-critical control is Stop, which is the always-visible red bar in the
  // layout, not anything down here.
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
