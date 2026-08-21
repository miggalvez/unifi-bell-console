"use client";

import { useState, useSyncExternalStore } from "react";
import { Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const DISMISSED_KEY = "bells.installHintDismissed";

type Platform = "ios" | "other" | "hidden";

function subscribe() {
  // Nothing changes the answer after load; React only needs a subscriber.
  return () => {};
}

/** Client-only: "hidden" when already installed, or dismissed on this phone. */
function getSnapshot(): Platform {
  const nav = navigator as Navigator & { standalone?: boolean };
  const installed =
    window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
  if (installed || localStorage.getItem(DISMISSED_KEY)) return "hidden";
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch-point check tells them apart.
  // Android is ruled out first so a desktop browser emulating a phone on a
  // Mac does not read as an iPad.
  const ios =
    !/Android/.test(ua) &&
    (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  return ios ? "ios" : "other";
}

function getServerSnapshot(): Platform {
  return "hidden";
}

/**
 * A short "put this on your home screen" note, shown only in a plain browser
 * tab. There is deliberately no install button: the prompt API does not exist
 * on iOS, so the instructions are the one thing that works everywhere.
 */
export function InstallHint() {
  // The server renders nothing and the client swaps in the real answer — no
  // hydration mismatch, and no state set from inside an effect.
  const platform = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || platform === "hidden") return null;

  const steps =
    platform === "ios"
      ? "In Safari, tap Share, then “Add to Home Screen”."
      : "In Chrome, open the ⋮ menu and choose “Add to Home screen” or “Install app”.";

  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 text-sm">
      <Smartphone className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Put this on your home screen</p>
        <p className="text-muted-foreground">{steps} It then opens like an app, without the browser bar.</p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, "1");
          setDismissed(true);
        }}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
