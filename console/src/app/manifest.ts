import type { MetadataRoute } from "next";

/**
 * Served at /manifest.webmanifest and linked from every page automatically.
 * `scope` is "/" rather than "/m" on purpose: the sign-in page lives outside
 * /m, and a navigation outside the scope opens in a browser sheet instead of
 * the app window. `start_url` is what the home-screen icon launches.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/m",
    name: "School Bell Console",
    short_name: "Bells",
    description: "Announcements and emergency alerts for the school PA speakers",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f7f9",
    theme_color: "#2f6fed",
    // "any" and "maskable" must be separate entries: Android rejects an icon
    // declaring both, and iOS ignores the manifest icons in favour of
    // apple-icon.png anyway.
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
