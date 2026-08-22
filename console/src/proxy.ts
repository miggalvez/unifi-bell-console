import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isPublicPath } from "@/lib/auth/routing";

// Cookie-presence redirect for page-navigation UX only. Real authorization
// happens in the server-side guards (src/lib/auth/guards.ts) — no DB here.
//
// That is also why this never sends a cookie-holder *away* from /login: only
// the database knows whether the cookie is still good, and a stale one
// bouncing between here and requireUser() is an infinite loop that an
// installed phone app has no address bar to escape from. The login page makes
// that check itself.
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || pathname === "/login") return NextResponse.next();

  if (!request.cookies.has(SESSION_COOKIE)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// Must be a static literal (Next reads it at build time), so it cannot be
// derived from PUBLIC_EXACT/PUBLIC_PREFIXES in routing.ts — tests/proxy.test.ts
// keeps the two in step. The install files are listed because the proxy runs
// before public/ is served.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|api/|manifest\\.webmanifest|sw\\.js|offline\\.html|icons/|icon\\.png|apple-icon\\.png).*)",
  ],
};
