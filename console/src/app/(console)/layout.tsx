import { BellRing, LogOut } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { logout } from "@/app/login/actions";
import { Nav } from "@/components/nav";
import { AlertBanner } from "@/components/alert-banner";
import { DrillBanner } from "@/components/drill-banner";
import { SchoolClock } from "@/components/school-clock";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 flex w-52 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <BellRing className="size-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">
            School Bell Console
          </span>
        </div>
        <div className="mb-3 border-y border-sidebar-border bg-muted/40 px-4 py-2">
          <SchoolClock compact />
        </div>
        <Nav />
        <div className="mt-auto space-y-2 border-t border-sidebar-border p-3">
          <ThemeToggle />
          <div className="px-1">
            <p className="truncate text-sm font-medium text-sidebar-foreground">{user.displayName}</p>
            <p className="text-xs text-muted-foreground">
              {user.role === "ADMIN" ? "Administrator" : "Staff"}
            </p>
          </div>
          <form action={logout}>
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
              <LogOut className="size-4" /> Sign out
            </Button>
          </form>
        </div>
      </aside>
      <main className="ml-52 min-w-0 flex-1">
        {/* Alert above drill: if both were somehow showing, the real one reads
            first. In practice a real alert aborts a drill on the next tick. */}
        <AlertBanner />
        <DrillBanner />
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
