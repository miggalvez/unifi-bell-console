"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field, SelectField } from "@/components/fields";
import { TimePicker } from "@/components/pickers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { addEvent, deleteEvent, updateEvent } from "../actions";

export interface EventItem {
  id: number;
  time: string;
  label: string | null;
  cueId: number;
  isEnabled: boolean;
}

export interface CueOption {
  id: number;
  name: string;
}

export function EventEditor({
  planId,
  events,
  cues,
  isAdmin,
}: {
  planId: number;
  events: EventItem[];
  cues: CueOption[];
  isAdmin: boolean;
}) {
  const addRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Time</TableHead>
              <TableHead className="w-56">What plays</TableHead>
              <TableHead>Name (optional)</TableHead>
              <TableHead className="w-24 text-center">On</TableHead>
              <TableHead className="w-14" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  No bells in this plan yet — add the first one below.
                </TableCell>
              </TableRow>
            ) : (
              events.map((ev) => <EventRow key={ev.id} event={ev} cues={cues} isAdmin={isAdmin} />)
            )}
          </TableBody>
        </Table>
      </div>

      {isAdmin ? (
        <form
          ref={addRef}
          action={(fd) =>
            startTransition(async () => {
              const r = await addEvent(planId, fd);
              if (r.ok) {
                toast.success("Event added");
                addRef.current?.reset();
              } else toast.error(r.error ?? "Failed");
            })
          }
          className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4 shadow-xs"
        >
          <Field label="Time" className="w-36">
            <TimePicker name="time" required />
          </Field>
          <Field label="What plays" className="w-52">
            <SelectField
              name="cueId"
              placeholder="Choose a sound…"
              options={cues.map((c) => ({ value: String(c.id), label: c.name }))}
            />
          </Field>
          <Field label="Name (optional)" className="min-w-40 flex-1">
            <Input name="label" placeholder="e.g. End of Period 2" />
          </Field>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" /> Add bell
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function EventRow({ event, cues, isAdmin }: { event: EventItem; cues: CueOption[]; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();

  // Controlled, seeded from the server row. Editing updates the field
  // immediately; when the save round-trips, the effects re-sync to whatever
  // the server actually stored. Uncontrolled inputs here would keep stale
  // values and make Base UI warn about a changing default.
  const [time, setTime] = useState(event.time);
  const [cueId, setCueId] = useState(String(event.cueId));
  const [label, setLabel] = useState(event.label ?? "");
  const [enabled, setEnabled] = useState(event.isEnabled);
  useEffect(() => setTime(event.time), [event.time]);
  useEffect(() => setCueId(String(event.cueId)), [event.cueId]);
  useEffect(() => setLabel(event.label ?? ""), [event.label]);
  useEffect(() => setEnabled(event.isEnabled), [event.isEnabled]);

  const commit = (patch: Parameters<typeof updateEvent>[1]) =>
    startTransition(async () => {
      const r = await updateEvent(event.id, patch);
      if (!r.ok) toast.error(r.error ?? "Failed");
    });

  return (
    <TableRow className={enabled ? "" : "opacity-50"}>
      <TableCell>
        <TimePicker
          value={time}
          disabled={!isAdmin || pending}
          onChange={(v) => {
            if (!v || v === time) return;
            setTime(v);
            commit({ time: v });
          }}
        />
      </TableCell>
      <TableCell>
        <SelectField
          size="sm"
          className="w-44"
          value={cueId}
          disabled={!isAdmin || pending}
          options={cues.map((c) => ({ value: String(c.id), label: c.name }))}
          onValueChange={(v) => {
            setCueId(v);
            commit({ cueId: Number(v) });
          }}
        />
      </TableCell>
      <TableCell>
        <Input
          value={label}
          disabled={!isAdmin || pending}
          className="h-8"
          onChange={(e) => setLabel(e.target.value)}
          onBlur={(e) => {
            if (e.target.value !== (event.label ?? "")) commit({ label: e.target.value || null });
          }}
        />
      </TableCell>
      <TableCell className="text-center">
        <Switch
          checked={enabled}
          disabled={!isAdmin || pending}
          onCheckedChange={(c) => {
            setEnabled(c === true);
            commit({ isEnabled: c === true });
          }}
        />
      </TableCell>
      <TableCell>
        {isAdmin ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            onClick={() => {
              if (!confirm("Delete this event?")) return;
              startTransition(async () => {
                const r = await deleteEvent(event.id);
                if (!r.ok) toast.error(r.error ?? "Failed");
              });
            }}
          >
            <Trash2 className="size-3.5 text-muted-foreground" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
