/**
 * Voices Protect accepts for PLAY_TEXT_ON_SPEAKER. Determined empirically on
 * Protect 7.1.87 by probing 32 plausible values — everything else returns
 * HTTP 400. There is no API that enumerates these, so if a future Protect
 * release adds voices, re-probe (phase0 has the harness).
 */
export const TTS_TONES = [
  { value: "welcome", label: "Welcome" },
  { value: "neutral", label: "Neutral" },
] as const;

export const DEFAULT_TONE = "welcome";

/**
 * Protect's TTS endpoint rejects longer text with a ZOD_PARSE_ERROR
 * (actions[0].metadata.text, "at most 120 character(s)") — observed live on
 * Protect 7.1.87, 2026-08-08. Enforced here so staff hit a plain-English
 * limit while typing, not an HTTP 400 after pressing Announce.
 */
export const TTS_MAX_CHARS = 120;

export function isValidTone(tone: string): boolean {
  return TTS_TONES.some((t) => t.value === tone);
}

/** Falls back to the default rather than letting Protect reject the request. */
export function coerceTone(tone: string | null | undefined): string {
  return tone && isValidTone(tone) ? tone : DEFAULT_TONE;
}
