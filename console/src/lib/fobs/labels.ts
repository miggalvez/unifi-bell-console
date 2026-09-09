/**
 * How a fob's buttons are named. Pure and dependency-free so the client
 * components and the server-only provisioning module share one source.
 *
 * A USL fob ships with two interchangeable faceplates and Protect records
 * which one is fitted in `buttonLabels`:
 *
 *   securityActions — padlock / moon / open padlock / bell
 *   positionHint    — 1 / 2 / 3 / 4, in reading order
 *
 * The button *keys* never change (arm, night, disarm, panic), only what is
 * printed on the plastic. We follow the plastic: whoever holds the fob sees
 * "4", so the console must not call it "Panic". The security words mean
 * nothing here anyway — this console plays announcements, it arms nothing.
 */

export type FobLabelMode = "securityActions" | "positionHint";

/** Reading order: top-left, top-right, bottom-left, bottom-right, then sides. */
export const FOB_BUTTON_KEYS = ["arm", "night", "disarm", "panic", "left", "right"] as const;
export type FobButtonKey = (typeof FOB_BUTTON_KEYS)[number];

export const FOB_PRESS_KEYS = ["press", "longPress", "doublePress"] as const;
export type FobPressKey = (typeof FOB_PRESS_KEYS)[number];

export const FOB_PRESS_LABELS: Record<FobPressKey, string> = {
  press: "single press",
  longPress: "long press",
  doublePress: "double press",
};

/** Menu wording — the 3s hold is worth stating where someone picks it. */
export const FOB_PRESS_MENU_LABELS: Record<FobPressKey, string> = {
  press: "Single press",
  longPress: "Long press (3s)",
  doublePress: "Double press",
};

const SECURITY_LABELS: Record<FobButtonKey, string> = {
  arm: "Arm",
  night: "Night Mode",
  disarm: "Disarm",
  panic: "Panic",
  left: "Left",
  right: "Right",
};

/** The four face buttons carry digits; the side buttons are unlabelled. */
const NUMBER_LABELS: Record<FobButtonKey, string> = {
  arm: "1",
  night: "2",
  disarm: "3",
  panic: "4",
  left: "Left",
  right: "Right",
};

export function isNumberFaceplate(mode: string | null | undefined): boolean {
  return mode === "positionHint";
}

/**
 * What to call one button. `long` spells out "Button 1" for places that need
 * to stand alone (an alarm title on the NVR); the short form suits a table
 * cell that already sits under a "Button" heading.
 */
export function fobButtonLabel(
  button: string,
  mode: string | null | undefined,
  opts: { long?: boolean } = {},
): string {
  const key = button as FobButtonKey;
  if (isNumberFaceplate(mode)) {
    const label = NUMBER_LABELS[key] ?? button;
    // "Left"/"Right" are already words; only the digits need the noun.
    return opts.long && /^\d$/.test(label) ? `Button ${label}` : label;
  }
  return SECURITY_LABELS[key] ?? button;
}

/** Human name for the fitted faceplate, for status lines. */
export function fobFaceplateName(mode: string | null | undefined): string {
  return isNumberFaceplate(mode) ? "Numbers" : "Security actions";
}
