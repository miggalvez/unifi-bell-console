/**
 * Delivery methods, shared by server and client code (pure, no dependencies).
 *
 * Both talkback variants stream over the speaker's talkback WebSocket; a
 * COMPOSITE cue is several recordings spliced into ONE stream at play time.
 * Run rows never carry COMPOSITE — the snapshot flattens it to
 * PROTECT_TALKBACK_AUDIO plus the ordered file list — so everything downstream
 * of a run (executor, speaker lock, streaming) only ever sees one method.
 */
export type DeliveryMethod =
  | "PROTECT_WEBHOOK"
  | "PROTECT_NATIVE_TTS"
  | "PROTECT_TALKBACK_AUDIO"
  | "PROTECT_TALKBACK_COMPOSITE";

export function isTalkback(method: string | null | undefined): boolean {
  return method?.startsWith("PROTECT_TALKBACK") ?? false;
}
