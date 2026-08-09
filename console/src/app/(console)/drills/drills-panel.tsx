"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  ArrowDown,
  ArrowUp,
  Clock,
  GraduationCap,
  Loader2,
  Megaphone,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, SelectField } from "@/components/fields";
import { FileField } from "@/components/fields";
import {
  createDrill,
  deleteDrill,
  runDrill,
  setDrillAnnouncement,
  updateDrill,
  type StepInput,
} from "./actions";

const HOLD_MS = 1500;
const ARM_WINDOW_MS = 5000;

interface DrillItem {
  id: number;
  name: string;
  description: string | null;
  isEnabled: boolean;
  stepCount: number;
}

interface StepRow {
  sequenceId: number;
  position: number;
  kind: "PLAY" | "WAIT";
  cueId: number | null;
  waitSeconds: number | null;
  repeatForSeconds: number | null;
}

interface CueOption {
  id: number;
  name: string;
  /** One sounding: the message plus the shared drill tag after it. */
  cycleSeconds: number;
  /** Set when the console is guessing this sound's length. */
  assumedSeconds: number | null;
}

interface Preamble {
  id: number;
  name: string;
  text: string | null;
  method: string;
  durationMs: number | null;
  isEnabled: boolean;
}

export function DrillsPanel({
  drills,
  steps,
  cues,
  preamble,
  announcementChoices,
  isAdmin,
}: {
  drills: DrillItem[];
  steps: StepRow[];
  cues: CueOption[];
  preamble: Preamble | null;
  announcementChoices: { id: number; name: string; method: string }[];
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const stepsFor = useMemo(() => {
    const m = new Map<number, StepInput[]>();
    for (const s of steps) {
      const list = m.get(s.sequenceId) ?? [];
      list.push({
        kind: s.kind,
        cueId: s.cueId,
        waitSeconds: s.waitSeconds,
        repeatForSeconds: s.repeatForSeconds,
      });
      m.set(s.sequenceId, list);
    }
    return m;
  }, [steps]);

  return (
    <div className="space-y-6">
      {/* Shown only when the editor is closed: the editor's own Steps note
          says the same thing, and twice on one screen is noise. */}
      {editing === null ? (
        <PreambleNotice preamble={preamble} choices={announcementChoices} isAdmin={isAdmin} />
      ) : null}

      {editing !== null ? (
        <DrillEditor
          key={String(editing)}
          drill={editing === "new" ? null : (drills.find((d) => d.id === editing) ?? null)}
          initialSteps={editing === "new" ? [] : (stepsFor.get(editing) ?? [])}
          cues={cues}
          preamble={preamble}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {drills.length === 0 && editing === null ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card">
          <p className="text-sm text-muted-foreground">No drills set up yet.</p>
          {isAdmin ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus className="size-4" /> Create a drill
            </Button>
          ) : null}
        </div>
      ) : null}

      {drills.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Saved drills</CardTitle>
            <CardDescription>
              Hold a drill&rsquo;s Start button to arm it, then confirm. It runs by itself and can be
              stopped at any point from the bar at the top of any page.
            </CardDescription>
            {isAdmin ? (
              <CardAction>
                <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
                  <Plus className="size-4" /> New drill
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {drills.map((d) => (
              <DrillRow
                key={d.id}
                drill={d}
                steps={stepsFor.get(d.id) ?? []}
                cues={cues}
                isAdmin={isAdmin}
                onEdit={() => setEditing(d.id)}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PreambleNotice({
  preamble,
  choices,
  isAdmin,
}: {
  preamble: Preamble | null;
  choices: { id: number; name: string; method: string }[];
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState(preamble ? String(preamble.id) : "");
  const formRef = useRef<HTMLFormElement>(null);

  const save = (formData: FormData) =>
    startTransition(async () => {
      const r = await setDrillAnnouncement(formData);
      if (r.ok) {
        toast.success("Drill announcement updated");
        setEditing(false);
      } else {
        toast.error(r.message ?? "Could not change it");
      }
    });

  if (!preamble) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <p className="font-medium text-destructive">No drill announcement is set.</p>
        <p className="mt-1 text-muted-foreground">
          Drills cannot start without one.{" "}
          {isAdmin ? "Choose or upload one below." : "Ask an administrator to set one."}
        </p>
        {isAdmin ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => setEditing(true)}>
              Set the announcement
            </Button>
          </div>
        ) : null}
        {editing ? (
          <AnnouncementForm choices={choices} chosen={chosen} setChosen={setChosen} onSave={save} pending={pending} onCancel={() => setEditing(false)} />
        ) : null}
      </div>
    );
  }

  const isRecording = preamble.method.startsWith("PROTECT_TALKBACK");
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
      <div className="flex items-start gap-2.5">
        <Megaphone className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="font-medium">Before and after every sound, the speakers play:</p>
            {isAdmin && !editing ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Change
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-muted-foreground">
            {preamble.text ? (
              <span className="italic">&ldquo;{preamble.text}&rdquo;</span>
            ) : (
              <span>{preamble.name}</span>
            )}
            <span className="ml-2 text-xs">
              ({isRecording ? "your recording" : "computer voice"}
              {preamble.durationMs ? `, ${(preamble.durationMs / 1000).toFixed(1)}s` : ""})
            </span>
          </p>
          {!preamble.isEnabled ? (
            <p className="mt-1 text-xs font-medium text-destructive">
              This sound is turned off, so no drill can start. Turn it on, or choose another.
            </p>
          ) : null}
          <p className="mt-1.5 text-xs text-muted-foreground">
            Always plays and can&rsquo;t be removed. If it ever fails, the drill stops.
          </p>
          {editing ? (
            <AnnouncementForm
              choices={choices}
              chosen={chosen}
              setChosen={setChosen}
              onSave={save}
              pending={pending}
              onCancel={() => setEditing(false)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AnnouncementForm({
  choices,
  chosen,
  setChosen,
  onSave,
  pending,
  onCancel,
}: {
  choices: { id: number; name: string; method: string }[];
  chosen: string;
  setChosen: (v: string) => void;
  onSave: (fd: FormData) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  return (
    <form
      action={onSave}
      className="mt-4 space-y-4 rounded-md border bg-background p-3"
      onSubmit={() => setChosen(chosen)}
    >
      <Field
        label="Upload a recording"
        hint="A real voice, identical every time. The console measures its exact length, so drill timing is precise rather than estimated. MP3 or WAV."
      >
        <div className="flex flex-wrap items-center gap-2">
          <FileField name="file" accept="audio/*,.mp3,.wav,.m4a,.ogg" onFileName={setFile} />
        </div>
      </Field>

      {file ? (
        <Field label="Name it">
          <Input name="name" placeholder="Drill announcement (recorded)" />
        </Field>
      ) : (
        <Field label="…or use a sound you already have">
          <SelectField
            value={chosen}
            onValueChange={setChosen}
            placeholder="Choose a sound"
            options={choices.map((c) => ({
              value: String(c.id),
              label: `${c.name}${c.method.startsWith("PROTECT_TALKBACK") ? " (recording)" : ""}`,
            }))}
          />
          <input type="hidden" name="cueId" value={chosen} />
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Use this
        </Button>
      </div>
    </form>
  );
}

function summarise(steps: StepInput[], cues: CueOption[]): string {
  const name = (id?: number | null) => cues.find((c) => c.id === id)?.name ?? "(missing sound)";
  const parts = steps.map((s) => {
    if (s.kind === "WAIT") return `wait ${formatWait(s.waitSeconds ?? 0)}`;
    if (s.repeatForSeconds) return `${name(s.cueId)} — sounding for ${formatWait(s.repeatForSeconds)}`;
    return name(s.cueId);
  });
  return parts.length > 0 ? parts.join(" → ") : "no steps yet";
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m} min` : `${m} min ${s}s`;
}

function DrillRow({
  drill,
  steps,
  cues,
  isAdmin,
  onEdit,
}: {
  drill: DrillItem;
  steps: StepInput[];
  cues: CueOption[];
  isAdmin: boolean;
  onEdit: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStart = useRef(0);

  const stopHold = () => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = null;
    setProgress(0);
  };

  const beginHold = () => {
    if (armed || pending || !drill.isEnabled) return;
    holdStart.current = Date.now();
    holdTimer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - holdStart.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        stopHold();
        setArmed(true);
        armTimer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      }
    }, 50);
  };

  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
  };

  const start = () => {
    disarm();
    startTransition(async () => {
      const r = await runDrill(drill.id);
      if (r.ok) toast.success(`Drill started: ${drill.name}`);
      else toast.error(r.message ?? "Could not start the drill");
      mutate("/api/status");
    });
  };

  const remove = () => {
    startTransition(async () => {
      const r = await deleteDrill(drill.id);
      if (!r.ok) toast.error(r.message ?? "Could not delete it");
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GraduationCap className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{drill.name}</span>
          {!drill.isEnabled ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Off</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{summarise(steps, cues)}</p>
      </div>

      {armed ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-warning">Start this drill?</span>
          <Button size="sm" onClick={start} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Yes, start
          </Button>
          <Button size="sm" variant="ghost" onClick={disarm}>
            Cancel
          </Button>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending || !drill.isEnabled || steps.length === 0}
          onPointerDown={beginHold}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          className="relative h-8 shrink-0 select-none overflow-hidden rounded-md border border-warning/50 px-3 text-sm font-medium disabled:opacity-50"
          title={steps.length === 0 ? "Add steps to this drill first" : "Hold to arm"}
        >
          <span
            className="absolute inset-y-0 left-0 bg-warning/25 transition-none"
            style={{ width: `${progress * 100}%` }}
          />
          <span className="relative">Hold to start</span>
        </button>
      )}

      {isAdmin ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${drill.name}`}>
            <Pencil className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={pending} aria-label={`Delete ${drill.name}`}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DrillEditor({
  drill,
  initialSteps,
  cues,
  preamble,
  onClose,
}: {
  drill: DrillItem | null;
  initialSteps: StepInput[];
  cues: CueOption[];
  preamble: Preamble | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(drill?.name ?? "");
  const [description, setDescription] = useState(drill?.description ?? "");
  const [steps, setSteps] = useState<StepInput[]>(initialSteps);
  const [pending, startTransition] = useTransition();

  const setStep = (i: number, patch: Partial<StepInput>) =>
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const cycleFor = (cueId?: number | null) => cues.find((c) => c.id === cueId)?.cycleSeconds ?? 10;
  const assumedFor = (cueId?: number | null) => cues.find((c) => c.id === cueId)?.assumedSeconds ?? null;

  const move = (i: number, delta: number) =>
    setSteps((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = () => {
    startTransition(async () => {
      const payload = { name, description, steps, isEnabled: drill?.isEnabled ?? true };
      const r = drill ? await updateDrill(drill.id, payload) : await createDrill(payload);
      if (r.ok) {
        toast.success(drill ? "Drill saved" : "Drill created");
        onClose();
      } else {
        toast.error(r.message ?? "Could not save it");
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{drill ? `Edit ${drill.name}` : "New drill"}</CardTitle>
        <CardDescription>
          Steps run top to bottom. A pause holds the speakers silent — use one wherever staff and
          students need time to do something. A sound can repeat, the way a real alert does.
        </CardDescription>
        <CardAction>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close editor">
            <X className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="What staff will see, e.g. “Lockdown drill”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lockdown drill" />
          </Field>
          <Field label="Notes" hint="Optional — when this drill is used.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Termly practice, whole building"
            />
          </Field>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Steps</p>
          <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            {preamble ? (
              <>
                {preamble.text ? (
                  <span className="italic text-foreground">&ldquo;{preamble.text}&rdquo;</span>
                ) : (
                  <span className="text-foreground">{preamble.name}</span>
                )}{" "}
                plays before and after every sound below. You don&rsquo;t add it.
              </>
            ) : (
              "No drill announcement is set yet — close this and set one before running a drill."
            )}
          </div>

          {steps.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No steps yet — add a sound or a pause below.
            </p>
          ) : null}

          {steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border bg-background p-2.5">
              <span className="w-6 shrink-0 pb-2 text-center text-xs text-muted-foreground">{i + 1}</span>

              <Field label="Step" className="w-32 shrink-0">
                <SelectField
                  value={s.kind}
                  onValueChange={(v) =>
                    setStep(i, { kind: v as "PLAY" | "WAIT", cueId: null, waitSeconds: null })
                  }
                  options={[
                    { value: "PLAY", label: "Play a sound" },
                    { value: "WAIT", label: "Pause" },
                  ]}
                />
              </Field>

              {s.kind === "PLAY" ? (
                <>
                  <Field label="Sound" className="min-w-40 flex-1">
                    <SelectField
                      value={s.cueId ? String(s.cueId) : ""}
                      onValueChange={(v) => setStep(i, { cueId: Number(v) })}
                      placeholder="Choose a sound"
                      options={cues.map((c) => ({ value: String(c.id), label: c.name }))}
                    />
                  </Field>
                  <Field label="Plays" className="w-36 shrink-0">
                    <SelectField
                      value={s.repeatForSeconds != null ? "REPEAT" : "ONCE"}
                      onValueChange={(v) =>
                        setStep(i, { repeatForSeconds: v === "REPEAT" ? 240 : null })
                      }
                      options={[
                        { value: "ONCE", label: "Once" },
                        { value: "REPEAT", label: "Keep sounding" },
                      ]}
                    />
                  </Field>
                  {s.repeatForSeconds != null ? (
                    <>
                      <Field label="For" className="w-24 shrink-0">
                        <Input
                          type="number"
                          min={1}
                          max={30}
                          value={s.repeatForSeconds ? Math.round(s.repeatForSeconds / 60) || "" : ""}
                          onChange={(e) => {
                            // A cleared or invalid entry is held as 0 — still
                            // "Keep sounding", still visible, rejected on save.
                            // Nulling it here would silently flip the step to
                            // "Once" and unmount this input mid-edit.
                            const mins = Number(e.target.value);
                            setStep(i, { repeatForSeconds: Number.isFinite(mins) && mins > 0 ? mins * 60 : 0 });
                          }}
                        />
                      </Field>
                      <span className="pb-2 text-sm text-muted-foreground">
                        min
                        {s.cueId && s.repeatForSeconds
                          ? ` — about ${Math.max(1, Math.round(s.repeatForSeconds / cycleFor(s.cueId)))}×`
                          : ""}
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                <div className="flex items-end gap-2">
                  <div className="w-28">
                    <Field label="Pause for">
                      <Input
                        type="number"
                        min={1}
                        max={60}
                        value={s.waitSeconds ? Math.round(s.waitSeconds / 60) || "" : ""}
                        onChange={(e) => {
                          const mins = Number(e.target.value);
                          setStep(i, { waitSeconds: Number.isFinite(mins) ? mins * 60 : null });
                        }}
                        placeholder="5"
                      />
                    </Field>
                  </div>
                  <span className="pb-2 text-sm text-muted-foreground">minutes</span>
                </div>
              )}

              {s.kind === "PLAY" && assumedFor(s.cueId) !== null ? (
                <p className="w-full text-xs text-muted-foreground">
                  Length not set — assumed {assumedFor(s.cueId)}s, so anything shorter leaves
                  silence after it. Set its real length on Sounds.
                </p>
              ) : null}

              <div className="flex shrink-0 items-center gap-1 pb-1">
                <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => move(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label="Move down"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove step"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}

          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSteps((prev) => [...prev, { kind: "PLAY", cueId: null }])}
            >
              <Megaphone className="size-3.5" /> Add a sound
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSteps((prev) => [...prev, { kind: "WAIT", waitSeconds: 300 }])}
            >
              <Clock className="size-3.5" /> Add a pause
            </Button>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {drill ? "Save drill" : "Create drill"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
