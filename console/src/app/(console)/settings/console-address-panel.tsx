"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/fields";
import { setConsoleAddress } from "./actions";

/**
 * The reverse of PROTECT_HOST: where devices on the network reach this
 * console. Today the one consumer is keychain remotes — the NVR delivers
 * button presses to this address.
 */
export function ConsoleAddressPanel({ baseUrl }: { baseUrl: string | null }) {
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Console address</CardTitle>
        <CardDescription>
          Where devices on your network reach this console — keychain remotes deliver button
          presses here. Use this machine&apos;s LAN address; plain http is fine, every press
          carries its own secret token.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex max-w-xl items-end gap-2"
          action={(fd) =>
            startTransition(async () => {
              const r = await setConsoleAddress(fd);
              if (r.ok) toast.success("Saved — keychain-remote alarms re-applying");
              else toast.error(r.error ?? "Could not save.");
            })
          }
        >
          <Field label="Address" className="flex-1">
            <Input
              name="baseUrl"
              defaultValue={baseUrl ?? ""}
              key={baseUrl ?? ""}
              placeholder="http://192.168.1.50:3000"
              required
            />
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
