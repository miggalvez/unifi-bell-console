"use client";

import * as React from "react";
import { CalendarDays, Clock } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Date and time pickers drawn by the app, not the operating system. Native
 * <input type="date"|"time"> open OS chrome that looks nothing like the rest
 * of the console; these keep a hidden input so server actions still receive a
 * plain "YYYY-MM-DD" / "HH:MM" value.
 */

function toIsoDate(d: Date): string {
  // Local date parts — never toISOString(), which shifts across the UTC boundary.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromIsoDate(s: string | undefined): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDisplay(s: string | undefined): string {
  const d = fromIsoDate(s);
  if (!d) return "Pick a date";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function DatePicker({
  name,
  defaultValue,
  value: controlled,
  onChange,
  required,
  disabled,
  className,
  id,
}: {
  name?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const value = controlled ?? internal;
  const [open, setOpen] = React.useState(false);

  // When uncontrolled, follow a changed default — the server revalidates after
  // a save and the field would otherwise keep showing the old value.
  React.useEffect(() => {
    if (controlled === undefined && defaultValue !== undefined) setInternal(defaultValue);
  }, [defaultValue, controlled]);

  const set = (v: string) => {
    setInternal(v);
    onChange?.(v);
  };

  return (
    <>
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn(
                "h-9 w-full justify-start gap-2 px-3 font-normal",
                !value && "text-muted-foreground",
                className,
              )}
            >
              <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{formatDisplay(value)}</span>
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            autoFocus
            selected={fromIsoDate(value)}
            onSelect={(d: Date | undefined) => {
              if (d) set(toIsoDate(d));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** School bells land on 5-minute boundaries; the list beats a spinner. */
function timeOptions(step = 5): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += step) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out;
}

export function TimePicker({
  name,
  defaultValue,
  value: controlled,
  onChange,
  required,
  disabled,
  className,
  id,
}: {
  name?: string;
  defaultValue?: string;
  /** Pass to control the value (keeps it in step with server state). */
  value?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? "");
  const value = controlled ?? internal;
  const [open, setOpen] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (controlled === undefined && defaultValue !== undefined) setInternal(defaultValue);
  }, [defaultValue, controlled]);
  const options = React.useMemo(() => timeOptions(), []);

  const set = (v: string) => {
    setInternal(v);
    onChange?.(v);
  };

  // Open at the current value, or at the start of the school day — nobody
  // schedules a bell at midnight, which is where an unscrolled list lands.
  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el =
      listRef.current.querySelector<HTMLElement>('[data-selected="true"]') ??
      listRef.current.querySelector<HTMLElement>('[data-time="07:00"]');
    el?.scrollIntoView({ block: el?.dataset.selected === "true" ? "center" : "start" });
  }, [open]);

  return (
    <>
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn(
                "h-9 w-full justify-start gap-2 px-3 font-normal tabular-nums",
                !value && "text-muted-foreground",
                className,
              )}
            >
              <Clock className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{value ? to12h(value) : "Pick a time"}</span>
            </Button>
          }
        />
        <PopoverContent className="w-40 p-0" align="start">
          <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
            {options.map((t) => (
              <button
                key={t}
                type="button"
                data-time={t}
                data-selected={t === value}
                onClick={() => {
                  set(t);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm tabular-nums",
                  "hover:bg-accent hover:text-accent-foreground",
                  t === value && "bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                {to12h(t)}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
