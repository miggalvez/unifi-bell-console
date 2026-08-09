"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface Option {
  value: string;
  label: string;
}

/** Field shell: consistent label, spacing, and hint treatment everywhere. */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label?: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  // flex+gap rather than space-y: absolutely-positioned children (Base UI
  // renders a hidden form input inside Select) are not flex items, so they
  // cannot add phantom spacing and knock fields out of alignment.
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      ) : null}
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Styled select that still posts a value with the form — Base UI renders a
 * hidden input when `name` is set, so server actions read it unchanged.
 */
export function SelectField({
  name,
  options,
  defaultValue,
  value,
  onValueChange,
  placeholder = "Choose…",
  disabled,
  size = "default",
  className,
  id,
}: {
  name?: string;
  options: Option[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  id?: string;
}) {
  // A truncated label still has to be readable somewhere: the native title
  // shows the full text on hover, and the open list is never truncated.
  const selected = options.find((o) => o.value === (value ?? defaultValue));

  // A select is either controlled or uncontrolled — passing both `value` and
  // `defaultValue` leaves Base UI unable to tell which, and warns when the
  // "default" later changes.
  const modeProps = value !== undefined ? { value } : { defaultValue };

  // An uncontrolled Select cannot adopt a new default in place; Base UI warns
  // if the prop changes after mount. That happens legitimately — a server
  // action revalidates and pushes fresh row data down while a dialog is still
  // open — so treat a changed default as what it actually is, a different
  // field, and remount. Controlled selects pass `value` and are unaffected.
  const remountKey = value === undefined ? `default:${defaultValue ?? ""}` : undefined;

  return (
    <Select
      key={remountKey}
      name={name}
      {...modeProps}
      onValueChange={(v) => onValueChange?.(String(v))}
      disabled={disabled}
      items={options}
    >
      <SelectTrigger id={id} size={size} title={selected?.label} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Checkbox with its label, aligned and clickable as one target. */
export function CheckboxField({
  name,
  label,
  description,
  defaultChecked,
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  name?: string;
  label: string;
  description?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  const generated = React.useId();
  const inputId = id ?? generated;
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={inputId}
        name={name}
        defaultChecked={defaultChecked}
        checked={checked}
        onCheckedChange={(c) => onCheckedChange?.(c === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="grid gap-0.5 leading-tight">
        <Label htmlFor={inputId} className="text-sm font-normal">
          {label}
        </Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

/** File picker that looks like the rest of the app rather than an OS button. */
export function FileField({
  name,
  accept,
  disabled,
  onFileName,
}: {
  name: string;
  accept?: string;
  disabled?: boolean;
  onFileName?: (name: string | null) => void;
}) {
  const [fileName, setFileName] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const n = e.target.files?.[0]?.name ?? null;
          setFileName(n);
          onFileName?.(n);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => ref.current?.click()}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs",
          "transition-colors hover:bg-accent hover:text-accent-foreground",
          "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Upload className="size-3.5" />
        Choose file
      </button>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {fileName ?? "No file selected"}
      </span>
    </div>
  );
}

/** Small colored dot for status — quieter than a badge in dense tables. */
export function StatusDot({ tone }: { tone: "success" | "danger" | "warning" | "muted" }) {
  const color = {
    success: "bg-success",
    danger: "bg-destructive",
    warning: "bg-warning",
    muted: "bg-muted-foreground/40",
  }[tone];
  return (
    <span className="relative flex size-2" aria-hidden>
      {tone === "success" ? (
        <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", color)} />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}
