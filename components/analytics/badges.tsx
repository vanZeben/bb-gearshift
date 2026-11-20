import { cn } from "@/lib/utils";

type Action = "shift" | "keep" | "hold" | "manual" | "skip" | "off";

const ACTION_LABEL: Record<Action, string> = {
  shift: "Shifted",
  keep: "Kept",
  hold: "Held",
  manual: "Manual",
  skip: "Skipped",
  off: "Off",
};

const ACTION_STYLE: Record<Action, string> = {
  shift: "border-foreground bg-foreground text-background",
  keep: "border-border bg-secondary text-secondary-foreground",
  hold: "border-foreground/60 bg-transparent text-foreground",
  manual: "border-border bg-transparent text-foreground",
  skip: "border-dashed border-border bg-transparent text-muted-foreground",
  off: "border-dashed border-border bg-transparent text-muted-foreground",
};

/** Action badge: label plus fill/outline treatment, so it never relies on colour alone. */
export function ActionBadge({ action }: { action: Action }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        ACTION_STYLE[action],
      )}
    >
      {ACTION_LABEL[action]}
    </span>
  );
}

export function SectionCard({
  title,
  caption,
  actions,
  children,
}: {
  title: string;
  caption?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {caption ? <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p> : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-xs text-muted-foreground">{children}</p>;
}
