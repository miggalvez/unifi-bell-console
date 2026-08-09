import { readAlertState } from "@/lib/alerts";
import { readDrillState } from "@/lib/drills";

export interface BlockedByAlert {
  ok: false;
  status: "BLOCKED";
  message: string;
}

/**
 * Routine playback stands down while an emergency alert is sounding, and while
 * a drill is running. Someone announcing lunch over a lockdown would undercut
 * the alert, and the speakers cannot play both at once anyway. Mid-drill it is
 * just as bad in the other direction: an ordinary announcement arriving
 * between drill steps makes the drill ambiguous to everyone hearing it.
 *
 * Emergency playback deliberately does NOT call this. Drill steps do not
 * either — they run through the worker's own tick.
 */
export function blockedByActiveAlert(): BlockedByAlert | null {
  const alert = readAlertState();
  if (alert.active) {
    return {
      ok: false,
      status: "BLOCKED",
      message: `An emergency alert (${alert.cueName}) is sounding. Stop it first if this needs to go out.`,
    };
  }

  const drill = readDrillState();
  if (drill.active) {
    return {
      ok: false,
      status: "BLOCKED",
      message: `A drill (${drill.sequenceName}) is running. Stop it first if this needs to go out.`,
    };
  }

  return null;
}
