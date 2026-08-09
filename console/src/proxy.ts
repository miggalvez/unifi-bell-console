import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "bell_session";

// Cookie-presence redirect for page-navigation UX only. Real authorization
// happens in the server-side guards (src/lib/auth/guards.ts) — no DB here.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = request.cookies.has(SESSION_COOKIE);

  if (pathname === "/login") {
    if (hasCookie) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }
  if (!hasCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
