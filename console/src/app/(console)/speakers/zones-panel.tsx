"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/fields";
import { createZone, deleteZone, setZoneMembership } from "./actions";

export interface ZonePanelZone {
  id: number;
  name: string;
  memberMacs: string[];
}

export interface ZonePanelSpeaker {
  mac: string;
  name: string | null;
}

export function ZonesPanel({
  zones,
  speakers,
  isAdmin,
}: {
  zones: ZonePanelZone[];
  speakers: ZonePanelSpeaker[];
  isAdmin: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Speaker groups</CardTitle>
        <CardDescription>
          Group speakers so an announcement can go to just part of the building — Hallway, Gym,
          Front Office. Sounds set up in UniFi Protect choose their own speakers there instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isAdmin ? (
          <form
            ref={formRef}
            action={(fd) =>
              startTransition(async () => {
                const r = await createZone(String(fd.get("name") ?? ""));
                if (r.ok) {
                  toast.success("Zone created");
                  formRef.current?.reset();
                } else toast.error(r.message ?? "Failed");
              })
            }
            className="flex max-w-sm gap-2"
          >
            <Input name="name" placeholder="New group name — e.g. Gym" disabled={pending} />
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              <Plus className="size-4" /> Add
            </Button>
          </form>
        ) : null}

        {zones.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No groups yet — announcements play on every speaker.
          </p>
        ) : (
          <div className="space-y-3">
            {zones.map((zone) => (
              <ZoneRow key={zone.id} zone={zone} speakers={speakers} isAdmin={isAdmin} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Controlled: membership re-renders from the server after every toggle. */
function MemberCheckbox({
  zoneId,
  speaker,
  member,
  disabled,
}: {
  zoneId: number;
  speaker: ZonePanelSpeaker;
  member: boolean;
  disabled: boolean;
}) {
  const [checked, setChecked] = useState(member);
  const [pending, startTransition] = useTransition();
  useEffect(() => setChecked(member), [member]);

  return (
    <CheckboxField
      label={speaker.name ?? speaker.mac}
      disabled={disabled || pending}
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next);
        startTransition(async () => {
          const r = await setZoneMembership(zoneId, speaker.mac, next);
          if (!r.ok) {
            setChecked(!next); // put it back — the change didn't stick
            toast.error(r.message ?? "Failed");
          }
        });
      }}
    />
  );
}

function ZoneRow({
  zone,
  speakers,
  isAdmin,
}: {
  zone: ZonePanelZone;
  speakers: ZonePanelSpeaker[];
  isAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{zone.name}</span>
        {isAdmin ? (
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={pending}
            onClick={() => {
              if (!confirm(`Delete the "${zone.name}" speaker group?`)) return;
              startTransition(async () => {
                const r = await deleteZone(zone.id);
                if (!r.ok) toast.error(r.message ?? "Failed");
              });
            }}
          >
            <Trash2 className="size-3.5 text-muted-foreground" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2.5">
        {speakers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No speakers discovered yet.</p>
        ) : (
          speakers.map((s) => (
            <MemberCheckbox
              key={s.mac}
              zoneId={zone.id}
              speaker={s}
              member={zone.memberMacs.includes(s.mac)}
              disabled={!isAdmin || pending}
            />
          ))
        )}
      </div>
    </div>
  );
}
