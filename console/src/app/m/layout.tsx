import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { BellRing } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { logout } from "@/app/login/actions";
import { AlertBanner } from "@/components/alert-banner";
import { DrillBanner } from "@/components/drill-banner";
import { RegisterSw } from "@/components/register-sw";

export const dynamic = "force-dynamic";

/**
 * The phone app. A single screen for the two things someone away from the
 * office needs — announcements and emergency alerts — with none of the
 * desktop chrome. Installed to a home screen it launches here (manifest
 * start_url), and an unauthenticated launch comes back here after sign-in.
 */
export const metadata: Metadata = {
  applicationName: "School Bell Console",
  appleWebApp: { capable: true, title: "Bells", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the page extend under the home indicator; the bottom padding below
  // keeps the last tile above it. Zoom is deliberately left enabled.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#101722" },
  ],
};

export default async function PhoneLayout({ children }: LayoutProps<"/m">) {
  const user = await requireUser("/m");

  return (
    <div className="flex min-h-svh flex-col bg-background pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <BellRing className="size-5 shrink-0 text-primary" />
        <span className="text-sm font-semibold tracking-tight">Bells</span>
        <span className="ml-auto truncate text-xs text-muted-foreground">{user.displayName}</span>
      </header>
      {/* Same bars as the desktop: the Stop button must be reachable from the
          phone too, and above everything else. */}
      <AlertBanner />
      <DrillBanner />
      <main className="flex-1 space-y-6 px-4 py-4">{children}</main>
      <footer className="flex items-center justify-between gap-4 px-4 py-4 text-xs text-muted-foreground">
        <Link href="/" prefetch={false} className="text-primary hover:underline">
          Open full console
        </Link>
        <form action={logout}>
          <input type="hidden" name="next" value="/m" />
          <button type="submit" className="min-h-11 px-2 hover:text-foreground">
            Sign out
          </button>
        </form>
      </footer>
      <RegisterSw />
    </div>
  );
}
