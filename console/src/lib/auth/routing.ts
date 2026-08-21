// Pure helpers shared by the proxy and the login flow. The proxy bundle must
// stay free of database imports, so nothing in this file may import from the
// rest of the app.

export const SESSION_COOKIE = "bell_session";

/**
 * Paths the proxy lets through without a session cookie. A browser fetches a
 * web-app manifest without credentials, a service worker has to be installable
 * before anyone signs in, and the icons are requested by the operating system
 * — redirecting any of them to /login makes "Add to Home Screen" fail with no
 * message at all.
 *
 * Keep this in step with the literal matcher in src/proxy.ts (it cannot be
 * derived: Next needs a static value). tests/proxy.test.ts checks they agree.
 */
export const PUBLIC_EXACT = [
  "/manifest.webmanifest",
  "/sw.js",
  "/offline.html",
  "/favicon.ico",
  "/icon.png",
  "/apple-icon.png",
] as const;

export const PUBLIC_PREFIXES = ["/icons/", "/api/", "/_next/"] as const;

export function isPublicPath(pathname: string): boolean {
  if ((PUBLIC_EXACT as readonly string[]).includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

const MAX_NEXT_LENGTH = 512;

/**
 * Where to send someone once they have signed in. Only a same-origin path is
 * ever accepted: the value arrives in a query string or a hidden form field,
 * so anyone can craft it, and an open redirect on a login page is the classic
 * phishing primitive. Anything doubtful becomes "/".
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return "/";
  if (!raw.startsWith("/")) return "/";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }

  let url: URL;
  try {
    url = new URL(raw, "http://local");
  } catch {
    return "/";
  }
  // "//evil.com" and "/\evil.com" both resolve to a different host.
  if (url.origin !== "http://local") return "/";
  // Never bounce straight back to the login page.
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return "/";
  return url.pathname + url.search;
}
