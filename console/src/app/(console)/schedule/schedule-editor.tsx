"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { CalendarOff, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, SelectField, StatusDot } from "@/components/fields";
import { DatePicker } from "@/components/pickers";
import { cn } from "@/lib/utils";
import { deleteException, setWeekDay, upsertException } from "./actions";

export interface PlanOption {
  id: number;
  name: string;
}

export interface ExceptionItem {
  id: number;
  date: string;
  type: "NO_SCHOOL" | "USE_PLAN";
  planName: string | null;
  note: string | null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function WeekEditor({
  assignments,
  plans,
  isAdmin,
}: {
  assignments: (number | null)[]; // index = dayOfWeek
  plans: PlanOption[];
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly schedule</CardTitle>
        <CardDescription>Which bell plan runs on each weekday. Exceptions below override single dates.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {DAY_NAMES.map((name, day) => (
            <DayCard
              key={day}
              day={day}
              name={name}
              planId={assignments[day]}
              plans={plans}
              isAdmin={isAdmin}
              pending={pending}
              onChange={(v) =>
                startTransition(async () => {
                  const r = await setWeekDay(day, v === "none" ? null : Number(v));
                  if (r.ok) toast.success(`${name} updated`);
                  else toast.error(r.error ?? "Failed");
                })
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Controlled so the value stays in step with the server after each save. */
function DayCard({
  day,
  name,
  planId,
  plans,
  isAdmin,
  pending,
  onChange,
}: {
  day: number;
  name: string;
  planId: number | null;
  plans: PlanOption[];
  isAdmin: boolean;
  pending: boolean;
  onChange: (value: string) => void;
}) {
  const toValue = (id: number | null) => (id != null ? String(id) : "none");
  const [value, setValue] = useState(toValue(planId));
  useEffect(() => setValue(toValue(planId)), [planId]);

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        value !== "none" ? "bg-card" : "bg-muted/40",
      )}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-xs font-semibold tracking-wide text-foreground uppercase">
          {name.slice(0, 3)}
        </span>
        {value !== "none" ? <StatusDot tone="muted" /> : null}
      </div>
      <SelectField
        size="sm"
        disabled={!isAdmin || pending}
        value={value}
        options={[
          { value: "none", label: "No bells" },
          ...plans.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    </div>
  );
}

export function ExceptionsEditor({
  exceptions,
  plans,
  isAdmin,
}: {
  exceptions: ExceptionItem[];
  plans: PlanOption[];
  isAdmin: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState("NO_SCHOOL");
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Calendar exceptions</CardTitle>
        <CardDescription>
          Override a single date — a day off, or a special plan like Mass Day or Early Dismissal.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdmin ? (
          <form
            ref={formRef}
            action={(fd) =>
              startTransition(async () => {
                const r = await upsertException(fd);
                if (r.ok) {
                  toast.success("Exception saved");
                  formRef.current?.reset();
                  setType("NO_SCHOOL");
                } else toast.error(r.error ?? "Failed");
              })
            }
            className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/40 p-4"
          >
            <Field label="Date" className="w-52">
              <DatePicker name="date" required />
            </Field>
            <Field label="Type" className="w-52">
              <SelectField
                name="type"
                value={type}
                onValueChange={setType}
                options={[
                  { value: "NO_SCHOOL", label: "No school (no bells)" },
                  { value: "USE_PLAN", label: "Use a different plan" },
                ]}
              />
            </Field>
            {type === "USE_PLAN" ? (
              <Field label="Plan" className="w-48">
                <SelectField
                  name="bellPlanId"
                  defaultValue={plans[0] ? String(plans[0].id) : undefined}
                  options={plans.map((p) => ({ value: String(p.id), label: p.name }))}
                />
              </Field>
            ) : null}
            <Field label="Note (optional)" className="min-w-40 flex-1">
              <Input name="note" placeholder="e.g. Parent-teacher conferences" />
            </Field>
            <Button type="submit" disabled={pending}>
              <Plus className="size-4" /> Save
            </Button>
          </form>
        ) : null}

        {exceptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming exceptions.</p>
        ) : (
          <div className="space-y-1.5">
            {exceptions.map((ex) => (
              <ExceptionRow key={ex.id} exception={ex} isAdmin={isAdmin} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExceptionRow({ exception, isAdmin }: { exception: ExceptionItem; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-3 rounded-md border px-3 py-2">
      <span className="w-28 text-sm font-medium tabular-nums">{exception.date}</span>
      {exception.type === "NO_SCHOOL" ? (
        <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
          <CalendarOff className="size-3" /> No school
        </Badge>
      ) : (
        <Badge variant="outline" className="border-transparent bg-accent text-accent-foreground">
          {exception.planName ?? "Special plan"}
        </Badge>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{exception.note}</span>
      {isAdmin ? (
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await deleteException(exception.id);
              if (!r.ok) toast.error(r.error ?? "Failed");
            })
          }
        >
          <Trash2 className="size-3.5 text-muted-foreground" />
        </Button>
      ) : null}
    </div>
  );
}
