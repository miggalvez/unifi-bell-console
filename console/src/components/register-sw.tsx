"use client";

import { useEffect } from "react";

/**
 * Registers the offline-fallback worker for the phone app. Its scope is /m
 * only: the desktop console and /api never pass through it, so there is no
 * way for a cached page to stand in for live alert state.
 */
export function RegisterSw() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/m", updateViaCache: "none" })
      .catch(() => {
        // Insecure origin or a blocked worker: the app still works, it just
        // shows the browser's own error page when the console is unreachable.
      });
  }, []);
  return null;
}
