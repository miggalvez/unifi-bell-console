/*
 * Offline fallback for the phone app (/m). Deliberately minimal: nothing from
 * the app itself is cached, because a stale page standing in for live alert
 * state is worse than an honest "can't reach the console". The only cached
 * thing is the offline page. Bump CACHE when offline.html changes.
 */
const CACHE = "bells-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(OFFLINE_URL, { cache: "reload" });
      // If the proxy ever starts redirecting this file to /login, refuse to
      // install rather than keep the sign-in page as the "offline" page.
      if (!response.ok || response.redirected) throw new Error("offline page unavailable");
      const cache = await caches.open(CACHE);
      await cache.put(OFFLINE_URL, response);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only our own caches. The Cache store is origin-wide, not scoped to
      // this worker, so deleting every non-matching key would clobber a cache
      // some other feature on the origin might own.
      await Promise.all(
        keys.filter((key) => key.startsWith("bells-") && key !== CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // Only page loads. Passing the request straight through keeps the server's
  // own redirects (e.g. to /login?next=/m) intact.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()),
  );
});
