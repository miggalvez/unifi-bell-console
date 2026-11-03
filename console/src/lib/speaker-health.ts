/**
 * One verdict on the speakers, shared by every part of the Overview that
 * mentions them (pure, no dependencies — client and server both use it).
 *
 * The dashboard says each problem once in full (the banner) and shows compact
 * state everywhere else; deciding the state in one place is what keeps the
 * banner, the Speakers card and the Today tag from disagreeing.
 */
export type SpeakerHealthState = "working" | "degraded" | "offline" | "none" | "unreachable";

export interface SpeakerHealth {
  state: SpeakerHealthState;
  /** One or two words for the Speakers card. */
  label: string;
  /** warning = some rooms unheard; critical = no room hears anything. */
  tone: "ok" | "warning" | "critical";
}

export function speakerHealth(s: { reachable: boolean; online: number; total: number }): SpeakerHealth {
  // Speaker states are only as fresh as the last successful poll, so an
  // unreachable system outranks whatever they last said.
  if (!s.reachable) return { state: "unreachable", label: "Not responding", tone: "critical" };
  if (s.total === 0) return { state: "none", label: "None found", tone: "warning" };
  if (s.online === 0) return { state: "offline", label: "Offline", tone: "critical" };
  if (s.online < s.total) return { state: "degraded", label: "Degraded", tone: "warning" };
  return { state: "working", label: "Working", tone: "ok" };
}
