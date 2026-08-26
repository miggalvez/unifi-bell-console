"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renamePlan } from "./actions";

export function RenamePlanDialog({
  planId,
  name,
  trigger,
}: {
  planId: number;
  name: string;
  trigger?: React.ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Each opening starts from whatever the server now holds, not from an
  // abandoned edit or a name someone else changed in the meantime.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setValue(name);
      setError(null);
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button variant="outline" size="sm">
              <Pencil className="size-3.5" /> Rename
            </Button>
          )
        }
      />
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename plan</DialogTitle>
          <DialogDescription>
            The new name shows everywhere this plan is used — the Schedule page and today&apos;s card.
            The bells themselves are untouched.
          </DialogDescription>
        </DialogHeader>
        <form
          action={(fd) =>
            startTransition(async () => {
              const r = await renamePlan(planId, String(fd.get("name") ?? ""));
              if (r.ok) {
                toast.success("Plan renamed");
                setOpen(false);
              } else setError(r.error ?? "Failed");
            })
          }
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor={`plan-name-${planId}`}>Name</Label>
            <Input
              id={`plan-name-${planId}`}
              name="name"
              value={value}
              autoFocus
              disabled={pending}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !value.trim() || value.trim() === name}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
