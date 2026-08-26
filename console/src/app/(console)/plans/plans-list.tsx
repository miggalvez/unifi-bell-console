"use client";

import Link from "next/link";
import { useRef, useTransition } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { friendlyTime } from "@/lib/format";
import { createPlan, deletePlan, duplicatePlan, setPlanArchived } from "./actions";
import { RenamePlanDialog } from "./rename-plan-dialog";

export interface PlanListItem {
  id: number;
  name: string;
  description: string | null;
  isArchived: boolean;
  bellCount: number;
  offCount: number;
  firstTime: string | null;
  lastTime: string | null;
  /** Weekdays (0=Sun) this plan is assigned to on the Schedule page. */
  days: number[];
  /** Upcoming calendar dates that override to this plan. */
  upcomingDates: number;
}

/**
 * "Mon–Fri", "Mon, Wed, Fri", "every day" — school weeks start on Monday, and
 * runs of three or more compress to a range.
 */
function describeDays(days: number[]): string {
  if (days.length === 7) return "every day";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const idx = order.filter((d) => days.includes(d));
  const parts: string[] = [];
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && order.indexOf(idx[j + 1]) === order.indexOf(idx[j]) + 1) j++;
    parts.push(j - i >= 2 ? `${labels[idx[i]]}–${labels[idx[j]]}` : idx.slice(i, j + 1).map((d) => labels[d]).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

export function PlansList({ plans, isAdmin }: { plans: PlanListItem[]; isAdmin: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <form
          ref={formRef}
          action={(fd) =>
            startTransition(async () => {
              const r = await createPlan(String(fd.get("name") ?? ""));
              if (r.ok) {
                toast.success("Plan created");
                formRef.current?.reset();
              } else toast.error(r.error ?? "Failed");
            })
          }
          className="flex max-w-md gap-2"
        >
          <Input name="name" placeholder="New plan name (e.g. Normal School Day)" disabled={pending} />
          <Button type="submit" size="sm" disabled={pending}>
            <Plus className="size-4" /> Create
          </Button>
        </form>
      ) : null}

      {plans.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed bg-card">
          <p className="text-sm text-muted-foreground">No bell plans yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCard({ plan, isAdmin }: { plan: PlanListItem; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className={`rounded-lg border bg-card p-4 shadow-xs ${plan.isArchived ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <Link href={`/plans/${plan.id}`} className="min-w-0 hover:underline">
          <div className="truncate text-sm font-medium">{plan.name}</div>
          {plan.description ? (
            <div className="truncate text-xs text-muted-foreground">{plan.description}</div>
          ) : null}
        </Link>
        {plan.isArchived ? <Badge variant="outline">Archived</Badge> : null}
      </div>

      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <div>
          {plan.bellCount === 0
            ? "No bells yet"
            : `${plan.bellCount} bell${plan.bellCount === 1 ? "" : "s"}` +
              (plan.firstTime && plan.lastTime && plan.bellCount > 1
                ? ` · ${friendlyTime(plan.firstTime)} – ${friendlyTime(plan.lastTime)}`
                : plan.firstTime
                  ? ` · ${friendlyTime(plan.firstTime)}`
                  : "")}
          {plan.offCount > 0 ? ` · ${plan.offCount} turned off` : ""}
        </div>
        <div>
          {plan.days.length > 0
            ? `Rings ${describeDays(plan.days)}`
            : plan.upcomingDates === 0
              ? "Not on the schedule"
              : null}
          {plan.upcomingDates > 0
            ? `${plan.days.length > 0 ? " · " : "Used on "}${plan.upcomingDates} upcoming date${plan.upcomingDates === 1 ? "" : "s"}`
            : null}
        </div>
      </div>
      {isAdmin ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <RenamePlanDialog
            planId={plan.id}
            name={plan.name}
            trigger={
              <Button variant="ghost" size="sm" disabled={pending}>
                <Pencil className="size-3.5" /> Rename
              </Button>
            }
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await duplicatePlan(plan.id);
                if (r.ok) toast.success("Plan duplicated");
                else toast.error(r.error ?? "Failed");
              })
            }
          >
            <Copy className="size-3.5" /> Duplicate
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await setPlanArchived(plan.id, !plan.isArchived);
                if (!r.ok) toast.error(r.error ?? "Failed");
              })
            }
          >
            {plan.isArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
            {plan.isArchived ? "Restore" : "Archive"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (
                !confirm(
                  `Delete "${plan.name}"${plan.bellCount > 0 ? ` and its ${plan.bellCount} bell${plan.bellCount === 1 ? "" : "s"}` : ""}? ` +
                    "Bells that already rang stay in the activity record.",
                )
              )
                return;
              startTransition(async () => {
                const r = await deletePlan(plan.id);
                if (r.ok) toast.success("Plan deleted");
                else toast.error(r.error ?? "Could not delete it");
              });
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}
