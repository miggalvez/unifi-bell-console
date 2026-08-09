export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function Placeholder({ milestone }: { milestone: string }) {
  return (
    <div className="flex h-48 items-center justify-center rounded-lg border border-dashed bg-card">
      <p className="text-sm text-muted-foreground">Coming in {milestone}</p>
    </div>
  );
}
