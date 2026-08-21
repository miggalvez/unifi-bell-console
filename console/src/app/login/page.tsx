import { count } from "drizzle-orm";
import { BellRing } from "lucide-react";
import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/routing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm, BootstrapForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const next = safeNextPath((await searchParams).next);
  // The real "already signed in" check. The proxy only sees that a cookie
  // exists; a stale one must land here and get the form, not a redirect.
  if (await getSessionUser()) redirect(next);

  const users = db.select({ n: count() }).from(schema.users).get();
  const firstRun = (users?.n ?? 0) === 0;

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2 text-foreground">
          <BellRing className="size-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">School Bell Console</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{firstRun ? "Welcome" : "Sign in"}</CardTitle>
            <CardDescription>
              {firstRun
                ? "No accounts exist yet. Create the initial administrator account."
                : "Sign in with your staff account."}
            </CardDescription>
          </CardHeader>
          <CardContent>{firstRun ? <BootstrapForm next={next} /> : <LoginForm next={next} />}</CardContent>
        </Card>
      </div>
    </main>
  );
}
