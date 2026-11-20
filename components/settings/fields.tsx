import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useEditor } from "./context";
import { useResetter } from "./reset-context";
import {
  getAt, isChanged, issuesUnder, listAdd, listMove, listRemove, listUpdate, pathToString,
  regexError, type Path, type PolicyIssue,
} from "./helpers";

/* ---- Small building blocks ---- */

export function IssueList({ issues, className }: { issues: readonly PolicyIssue[]; className?: string }) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-0.5 text-xs text-destructive", className)} role="alert">
      {issues.map((e, i) => (
        <li key={`${e.path}-${i}`}>{e.message}</li>
      ))}
    </ul>
  );
}

export function ChangedMark({ changed, onRevert, what }: { changed: boolean; onRevert: () => void; what: string }) {
  if (!changed) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline">changed</Badge>
      <button
        type="button"
        onClick={onRevert}
        aria-label={`Revert ${what} to default`}
        title="Revert to default"
        className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="Undo2" className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Label row + control + hint + inline errors for one field bound to a path in the draft. */
export function Field({
  label, hint, path, children, htmlFor, inline,
}: {
  label: string; hint?: ReactNode; path: Path; children: ReactNode; htmlFor?: string; inline?: boolean;
}) {
  const { draft, defaults, issues, revert } = useEditor();
  const changed = isChanged(defaults, draft, path);
  const errs = issuesUnder(issues, pathToString(draft, path));
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", inline && "sm:flex-row sm:items-center sm:justify-between sm:gap-4")}>
      <div className={cn("flex flex-col gap-0.5", inline && "sm:max-w-[55%]")}>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
          <ChangedMark changed={changed} onRevert={() => revert(path)} what={label} />
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className={cn("min-w-0", inline && "sm:w-56 sm:shrink-0")}>{children}</div>
      <IssueList issues={errs} className={inline ? "sm:basis-full" : undefined} />
    </div>
  );
}

/** Number input that keeps its own text while typing and only reports valid numbers. */
export function NumberInput({
  value, onChange, min, max, step, allowEmpty, placeholder, id, className, "aria-label": ariaLabel,
}: {
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number; max?: number; step?: number; allowEmpty?: boolean; placeholder?: string;
  id?: string; className?: string; "aria-label"?: string;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    const parsed = text.trim() === "" ? undefined : Number(text);
    if (parsed !== value) setText(value === undefined ? "" : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync only when the value changes from outside
  }, [value]);
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="number"
      inputMode="decimal"
      className={cn("h-8 text-sm", className)}
      min={min}
      max={max}
      step={step ?? "any"}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") {
          if (allowEmpty) onChange(undefined);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

/* ---- Fields bound to draft paths ---- */

export function NumField({
  label, hint, path, min, max, step, allowEmpty, placeholder, inline = true,
}: {
  label: string; hint?: ReactNode; path: Path; min?: number; max?: number; step?: number;
  allowEmpty?: boolean; placeholder?: string; inline?: boolean;
}) {
  const { draft, set } = useEditor();
  const id = useId();
  const value = getAt(draft, path);
  return (
    <Field label={label} hint={hint} path={path} htmlFor={id} inline={inline}>
      <NumberInput
        id={id}
        value={typeof value === "number" ? value : undefined}
        min={min} max={max} step={step} allowEmpty={allowEmpty} placeholder={placeholder}
        onChange={(n) => set(path, n)}
      />
    </Field>
  );
}

export function TextField({
  label, hint, path, mono, placeholder, inline = false, validateRegex,
}: {
  label: string; hint?: ReactNode; path: Path; mono?: boolean; placeholder?: string; inline?: boolean; validateRegex?: boolean;
}) {
  const { draft, set } = useEditor();
  const id = useId();
  const value = String(getAt(draft, path) ?? "");
  const bad = validateRegex ? regexError(value) : null;
  return (
    <Field label={label} hint={hint} path={path} htmlFor={id} inline={inline}>
      <Input
        id={id}
        className={cn("h-8 text-sm", mono && "font-mono text-xs")}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={bad !== null}
        onChange={(e) => set(path, e.target.value)}
      />
      {bad ? <p className="mt-1 text-xs text-destructive">{bad}</p> : null}
    </Field>
  );
}

export function SwitchField({ label, hint, path }: { label: string; hint?: ReactNode; path: Path }) {
  const { draft, set, defaults, issues, revert } = useEditor();
  const id = useId();
  const changed = isChanged(defaults, draft, path);
  const errs = issuesUnder(issues, pathToString(draft, path));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={id} className="text-sm font-medium">{label}</label>
            <ChangedMark changed={changed} onRevert={() => revert(path)} what={label} />
          </div>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <Switch id={id} checked={getAt(draft, path) === true} onCheckedChange={(v) => set(path, v)} />
      </div>
      <IssueList issues={errs} />
    </div>
  );
}

/** A collapsible, editable list of regex sources. Collapsed by default, with a count. */
export function PatternsField({
  label, hint, path, startOpen,
}: {
  label: string; hint?: ReactNode; path: Path; startOpen?: boolean;
}) {
  const { draft, set, defaults, issues, revert } = useEditor();
  const list = (getAt(draft, path) as string[] | undefined) ?? [];
  const errPath = pathToString(draft, path);
  const errs = issuesUnder(issues, errPath);
  const [open, setOpen] = useState(startOpen === true);
  const panelId = useId();
  const changed = isChanged(defaults, draft, path);
  const shown = open || errs.length > 0;
  const write = (next: string[]) => set(path, next);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className="inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={shown ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden="true" />
          {label}
          <span className="font-normal text-muted-foreground">({list.length})</span>
        </button>
        <ChangedMark changed={changed} onRevert={() => revert(path)} what={label} />
      </div>
      {hint && shown ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {shown ? (
        <div id={panelId} className="flex flex-col gap-1.5 pl-1 sm:pl-5">
          {list.length === 0 ? <p className="text-xs text-muted-foreground">No patterns.</p> : null}
          {list.map((pattern, i) => {
            const own = errs.filter((e) => e.path === `${errPath}[${i}]` || e.path.startsWith(`${errPath}[${i}].`));
            const local = regexError(pattern);
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1">
                  <Input
                    aria-label={`${label} pattern ${i + 1}`}
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    value={pattern}
                    spellCheck={false}
                    aria-invalid={local !== null || own.length > 0}
                    onChange={(e) => write(listUpdate(list, i, e.target.value))}
                  />
                  <IconButton name="ArrowUp" label={`Move pattern ${i + 1} up`} disabled={i === 0} onClick={() => write(listMove(list, i, -1))} />
                  <IconButton name="ArrowDown" label={`Move pattern ${i + 1} down`} disabled={i === list.length - 1} onClick={() => write(listMove(list, i, 1))} />
                  <IconButton name="X" label={`Remove pattern ${i + 1}`} onClick={() => write(listRemove(list, i))} />
                </div>
                {local ? <p className="text-xs text-destructive">{local}</p> : null}
                <IssueList issues={own.filter((e) => e.message !== local)} />
              </div>
            );
          })}
          <IssueList issues={errs.filter((e) => e.path === errPath)} />
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => write(listAdd(list))}>
              <Icon name="Plus" className="size-3.5" aria-hidden="true" />
              Add pattern
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function IconButton({
  name, label, onClick, disabled, className,
}: { name: string; label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <Icon name={name} className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/** A button that asks "Are you sure?" inline before running. */
export function ConfirmButton({
  label, confirmLabel = "Yes, reset", onConfirm, disabled, variant = "ghost", prompt,
}: {
  label: string; confirmLabel?: string; onConfirm: () => void; disabled?: boolean;
  variant?: "ghost" | "outline"; prompt: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" role="group" aria-label={prompt}>
      <span className="text-xs text-muted-foreground">{prompt}</span>
      <Button
        type="button" variant="destructive" size="sm" autoFocus
        onClick={() => { setAsking(false); onConfirm(); }}
      >
        {confirmLabel}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
    </span>
  );
}

/** Collapsible card section. */
export function Section({
  title, description, actions, children, defaultOpen = true, count,
}: {
  title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean; count?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0" aria-hidden="true" />
          {title}
          {count}
        </button>
        {actions}
      </div>
      {open ? (
        <div id={id} className="flex flex-col gap-3 border-t border-border px-3 py-3">
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** "Reset to defaults" for a section, confirming first. */
export function SectionReset({ label, paths }: { label: string; paths: readonly string[] }) {
  const { reset, busy } = useResetter();
  return (
    <ConfirmButton
      label="Reset to defaults"
      prompt={`Reset ${label} to defaults?`}
      disabled={busy}
      onConfirm={() => reset(paths)}
    />
  );
}
