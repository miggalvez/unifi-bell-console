export type DeliveryMethod =
  | "PROTECT_WEBHOOK"
  | "PROTECT_NATIVE_TTS"
  | "PROTECT_TALKBACK_AUDIO"
  | "PROTECT_TALKBACK_COMPOSITE";

export interface CueRow {
  id: number;
  name: string;
  description: string | null;
  deliveryMethod: DeliveryMethod;
  webhookId: string | null;
  ttsText: string | null;
  ttsTone: string;
  audioFileId: number | null;
  estimatedDurationMs: number | null;
  /** Ordered recordings for a combined announcement. */
  partIds?: number[];
  zoneId: number | null;
  isEmergency: boolean;
  isEnabled: boolean;
}

export interface ZoneOption {
  id: number;
  name: string;
}

export interface AudioOption {
  id: number;
  name: string;
}

/** What staff see. The underlying names are Protect's, not theirs. */
export const METHOD_LABEL: Record<DeliveryMethod, string> = {
  PROTECT_WEBHOOK: "Protect sound",
  PROTECT_NATIVE_TTS: "Spoken",
  PROTECT_TALKBACK_AUDIO: "Recording",
  PROTECT_TALKBACK_COMPOSITE: "Combined",
};

export const METHOD_CHOICES: { value: DeliveryMethod; label: string; help: string }[] = [
  {
    value: "PROTECT_WEBHOOK",
    label: "Sound from UniFi Protect",
    help: "Most reliable — use this for class bells.",
  },
  {
    value: "PROTECT_NATIVE_TTS",
    label: "Spoken message",
    help: "Type the words; a computer voice reads them out.",
  },
  {
    value: "PROTECT_TALKBACK_AUDIO",
    label: "Uploaded recording",
    help: "An MP3 or WAV — a real chime, or someone's recorded voice.",
  },
  {
    value: "PROTECT_TALKBACK_COMPOSITE",
    label: "Combined announcement",
    help: "Recordings chained into one seamless announcement — an attention chime, then a spoken message.",
  },
];
