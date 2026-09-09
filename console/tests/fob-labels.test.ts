import { describe, expect, it } from "vitest";
import {
  FOB_BUTTON_KEYS,
  fobButtonLabel,
  fobFaceplateName,
  isNumberFaceplate,
} from "@/lib/fobs/labels";

describe("fob button labels follow the fitted faceplate", () => {
  it("numbers the four face buttons in reading order", () => {
    // Verified against Protect's own icon set: the positionHint glyphs are
    // 1/2/3/4 on arm/night/disarm/panic — top-left, top-right, bottom-left,
    // bottom-right, matching the printed faceplate.
    expect(FOB_BUTTON_KEYS.slice(0, 4).map((k) => fobButtonLabel(k, "positionHint"))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("uses the security wording on the other faceplate", () => {
    expect(FOB_BUTTON_KEYS.slice(0, 4).map((k) => fobButtonLabel(k, "securityActions"))).toEqual([
      "Arm",
      "Night Mode",
      "Disarm",
      "Panic",
    ]);
  });

  it("leaves the side buttons alone — they carry no digit", () => {
    for (const mode of ["securityActions", "positionHint"]) {
      expect(fobButtonLabel("left", mode)).toBe("Left");
      expect(fobButtonLabel("right", mode, { long: true })).toBe("Right");
    }
  });

  it("spells out 'Button 4' where a label must stand alone", () => {
    expect(fobButtonLabel("panic", "positionHint", { long: true })).toBe("Button 4");
    // The security names are already self-describing.
    expect(fobButtonLabel("panic", "securityActions", { long: true })).toBe("Panic");
  });

  it("falls back to the security names when the mode is unknown", () => {
    // Older Protect, or a fob not yet in the cache: never invent a number.
    expect(fobButtonLabel("panic", null)).toBe("Panic");
    expect(fobButtonLabel("panic", undefined)).toBe("Panic");
    expect(fobButtonLabel("panic", "somethingNew")).toBe("Panic");
    expect(isNumberFaceplate(null)).toBe(false);
  });

  it("names the faceplate for status lines", () => {
    expect(fobFaceplateName("positionHint")).toBe("Numbers");
    expect(fobFaceplateName("securityActions")).toBe("Security actions");
    expect(fobFaceplateName(null)).toBe("Security actions");
  });
});
