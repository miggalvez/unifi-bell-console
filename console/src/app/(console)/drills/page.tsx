import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { requireUser } from "@/lib/auth/guards";
import { PageHeader } from "@/components/page-header";
import { cycleSecondsFor, preambleCue } from "@/lib/drills";
import { estimateDurationMs } from "@/lib/speaker-lock";
import { DrillsPanel } from "./drills-panel";

export const dynamic = "force-dynamic";

export default async function DrillsPage() {
  const user = await requireUser();

  const drills = db
    .select({
      id: schema.drillSequences.id,
      name: schema.drillSequences.name,
      description: schema.drillSequences.description,
      isEnabled: schema.drillSequences.isEnabled,
      stepCount: sql<number>`(SELECT COUNT(*) FROM drill_steps WHERE sequence_id = ${schema.drillSequences.id})`,
    })
    .from(schema.drillSequences)
    .orderBy(asc(schema.drillSequences.name))
    .all();

  const steps = db
    .select({
      sequenceId: schema.drillSteps.sequenceId,
      position: schema.drillSteps.position,
      kind: schema.drillSteps.kind,
      cueId: schema.drillSteps.cueId,
      waitSeconds: schema.drillSteps.waitSeconds,
      repeatForSeconds: schema.drillSteps.repeatForSeconds,
    })
    .from(schema.drillSteps)
    .orderBy(asc(schema.drillSteps.sequenceId), asc(schema.drillSteps.position))
    .all();

  const preamble = preambleCue();

  // The announcement is added around every sound automatically, so offering it
  // as a step of its own would only produce three tags in a row.
  const cues = db
    .select()
    .from(schema.soundCues)
    .where(eq(schema.soundCues.isEnabled, true))
    .orderBy(asc(schema.soundCues.name))
    .all()
    .filter((c) => c.id !== preamble?.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      cycleSeconds: cycleSecondsFor(c),
      // Protect never reports the length of its own sounds, so an undeclared
      // webhook cue is budgeted at a default — and the surplus is silence.
      assumedSeconds:
        c.deliveryMethod === "PROTECT_WEBHOOK" && c.estimatedDurationMs === null
          ? Math.round(estimateDurationMs(c) / 1000)
          : null,
    }));

  // Anything that could reasonably announce a drill: not an emergency sound,
  // and not turned off.
  const announcementChoices = db
    .select()
    .from(schema.soundCues)
    .where(eq(schema.soundCues.isEnabled, true))
    .orderBy(asc(schema.soundCues.name))
    .all()
    .filter((c) => !c.isEmergency)
    .map((c) => ({ id: c.id, name: c.name, method: c.deliveryMethod }));

  return (
    <>
      <PageHeader
        title="Drills"
        description="Practise an emergency: a script of sounds and pauses that plays itself, start to finish."
      />
      <DrillsPanel
        drills={drills}
        steps={steps}
        cues={cues}
        preamble={
          preamble
            ? {
                id: preamble.id,
                name: preamble.name,
                text: preamble.ttsText,
                method: preamble.deliveryMethod,
                durationMs: preamble.estimatedDurationMs,
                isEnabled: preamble.isEnabled,
              }
            : null
        }
        announcementChoices={announcementChoices}
        isAdmin={user.role === "ADMIN"}
      />
    </>
  );
}
