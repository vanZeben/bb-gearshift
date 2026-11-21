import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatTier } from "../format";
import { useEditor } from "./context";
import {
  ChangedMark, ConfirmButton, IconButton, IssueList, NumField, NumberInput, PatternsField, Section,
  SectionReset, SwitchField, TextField,
} from "./fields";
import {
  getAt, isChanged, issuesUnder, pathToString, renameKey, setBandMax, TIER_ORDER, uniqueKey, type Bands,
} from "./helpers";

function TierBands() {
  const { draft, defaults, update, issues, revert } = useEditor();
  const bands = draft.tiers as Bands;
  const errs = issuesUnder(issues, "tiers");
  return (
    <Section
      title="Tier bands"
      description="A message's score lands in one band, and the band decides its tier. Bands are contiguous: moving a tier's top moves the next tier's start."
      actions={<SectionReset label="tier bands" paths={["tiers"]} />}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
        {TIER_ORDER.map((tier) => (
          <div key={tier} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <span className="text-sm font-medium">{formatTier(tier)}</span>
              <ChangedMark changed={isChanged(defaults, draft, ["tiers", tier])} onRevert={() => revert(["tiers", tier])} what={`${tier} band`} />
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="w-6 text-right tabular-nums">{bands[tier].min}</span>
              <span>to</span>
              <NumberInput
                aria-label={`${formatTier(tier)} top score`}
                className="w-20"
                min={0}
                step={1}
                value={bands[tier].max}
                onChange={(v) => v !== undefined && update((p) => ({ ...p, tiers: setBandMax(p.tiers as Bands, tier, v) }) as typeof p)}
              />
            </div>
          </div>
        ))}
      </div>
      <IssueList issues={errs} />
    </Section>
  );
}

function ClassCard({ index }: { index: number }) {
  const { draft, defaults, update, revert, issues, set } = useEditor();
  const cls = draft.scoring.classes[index]!;
  const base = ["scoring", "classes", index] as const;
  const isDefault = defaults.scoring.classes.some((c) => c.id === cls.id);
  const changed = isChanged(defaults, draft, base);
  const errs = issuesUnder(issues, pathToString(draft, base));
  const enabled = cls.enabled !== false;
  const summary = [cls.floor !== undefined ? `floor ${cls.floor}` : null, cls.add !== undefined ? `add ${cls.add}` : null]
    .filter(Boolean).join(" · ");
  return (
    <details className={cn("group rounded-md border border-border", errs.length > 0 && "border-destructive")} open={errs.length > 0 ? true : undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="ChevronRight" className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className={cn("text-sm font-medium", !enabled && "text-muted-foreground line-through")}>{cls.label || cls.id}</span>
        <span className="text-xs text-muted-foreground">{summary}</span>
        {!enabled ? <Badge variant="outline">off</Badge> : null}
        {!isDefault ? <Badge variant="outline">custom</Badge> : null}
        {changed && isDefault ? <Badge variant="outline">changed</Badge> : null}
        {errs.length > 0 ? <Badge variant="destructive">{errs.length} problem{errs.length === 1 ? "" : "s"}</Badge> : null}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-medium" htmlFor={`cls-${cls.id}-enabled`}>Enabled</label>
          <Switch id={`cls-${cls.id}-enabled`} checked={enabled} onCheckedChange={(v) => set([...base, "enabled"], v)} />
        </div>
        <TextField label="Label" hint="Shown as the signal, e.g. “large build”." path={[...base, "label"]} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumField label="Floor" inline={false} min={0} max={100} allowEmpty path={[...base, "floor"]} hint="Score starts at least here when matched." placeholder="none" />
          <NumField label="Add" inline={false} min={0} max={100} allowEmpty path={[...base, "add"]} hint="Added to the score when matched." placeholder="none" />
        </div>
        <PatternsField label="Patterns" path={[...base, "patterns"]} hint="JavaScript regular expressions, matched case-insensitively. Any match counts." />
        <IssueList issues={errs.filter((e) => e.path === pathToString(draft, base))} />
        <div className="flex flex-wrap gap-2">
          {isDefault && changed ? (
            <Button type="button" variant="outline" size="sm" onClick={() => revert(base)}>Revert class to default</Button>
          ) : null}
          {!isDefault ? (
            <ConfirmButton
              label="Delete class" prompt="Delete this class?" confirmLabel="Yes, delete" variant="outline"
              onConfirm={() => update((p) => ({ ...p, scoring: { ...p.scoring, classes: p.scoring.classes.filter((_, i) => i !== index) } }))}
            />
          ) : null}
        </div>
      </div>
    </details>
  );
}

function ClassesSection() {
  const { draft, update } = useEditor();
  const classes = draft.scoring.classes;
  return (
    <Section
      title="Classes"
      count={<span className="font-normal text-muted-foreground">({classes.length})</span>}
      description="A class looks for patterns in the message. A match raises the score floor, adds points, or both. Default classes can be turned off but not deleted."
      actions={<SectionReset label="classes" paths={["scoring.classes"]} />}
    >
      {classes.map((c, i) => <ClassCard key={c.id} index={i} />)}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => update((p) => {
          const id = uniqueKey(Object.fromEntries(p.scoring.classes.map((c) => [c.id, 1])), "custom");
          return { ...p, scoring: { ...p.scoring, classes: [...p.scoring.classes, { id, label: "New class", patterns: [], add: 1 }] } };
        })}>
          <Icon name="Plus" className="size-3.5" aria-hidden="true" />
          Add class
        </Button>
      </div>
    </Section>
  );
}

function ComponentsSection() {
  const { draft, update, set, revert, defaults, issues } = useEditor();
  const groups = Object.keys(draft.scoring.components.groups);
  return (
    <Section
      title="Areas touched"
      defaultOpen={false}
      description="Messages that touch several areas of a codebase tend to be bigger. Each extra area that matches adds points, up to a cap."
      actions={<SectionReset label="areas" paths={["scoring.components"]} />}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumField label="Points per extra area" inline={false} min={0} path={["scoring", "components", "addPerExtraGroup"]} />
        <NumField label="Cap" inline={false} min={0} path={["scoring", "components", "cap"]} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Areas ({groups.length})</span>
        {groups.map((name) => {
          const path = ["scoring", "components", "groups", name] as const;
          return (
            <div key={name} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1">
                <Input
                  aria-label="Area name"
                  className="h-8 w-28 shrink-0 text-xs sm:w-32"
                  defaultValue={name}
                  key={name}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next === name) return;
                    if (next === "" || next in draft.scoring.components.groups) { e.target.value = name; return; }
                    update((p) => ({ ...p, scoring: { ...p.scoring, components: { ...p.scoring.components, groups: renameKey(p.scoring.components.groups, name, next) } } }));
                  }}
                />
                <Input
                  aria-label={`${name} pattern`}
                  className="h-8 min-w-0 flex-1 font-mono text-xs"
                  value={String(getAt(draft, path) ?? "")}
                  spellCheck={false}
                  onChange={(e) => set(path, e.target.value)}
                />
                <ChangedMark changed={isChanged(defaults, draft, path)} onRevert={() => revert(path)} what={`${name} area`} />
                <IconButton name="Trash2" label={`Remove area ${name}`} onClick={() => update((p) => {
                  const g = { ...p.scoring.components.groups };
                  delete g[name];
                  return { ...p, scoring: { ...p.scoring, components: { ...p.scoring.components, groups: g } } };
                })} />
              </div>
              <IssueList issues={issuesUnder(issues, `scoring.components.groups.${name}`)} />
            </div>
          );
        })}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => update((p) => ({
            ...p,
            scoring: { ...p.scoring, components: { ...p.scoring.components, groups: { ...p.scoring.components.groups, [uniqueKey(p.scoring.components.groups, "area")]: "\\bkeyword\\b" } } },
          }))}>
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
            Add area
          </Button>
        </div>
      </div>
    </Section>
  );
}

function LengthSection() {
  const { draft, update } = useEditor();
  const rules = draft.scoring.length;
  return (
    <Section
      title="File mentions, length and fallback"
      defaultOpen={false}
      description="Extra points for messages that name many files or run long, and the starting score when nothing else matched."
      actions={<SectionReset label="these rules" paths={["scoring.files", "scoring.length", "scoring.unmatchedScore"]} />}
    >
      <TextField label="File-path pattern" mono validateRegex path={["scoring", "files", "pattern"]} hint="Regular expression that finds file paths and file names." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumField label="Files needed" inline={false} min={1} path={["scoring", "files", "atLeast"]} hint="Distinct matches required." />
        <NumField label="Points added" inline={false} min={0} path={["scoring", "files", "add"]} />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Length bonuses</span>
        <p className="text-xs text-muted-foreground">The largest rule whose threshold the message exceeds applies.</p>
        {rules.map((_, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              Longer than (chars)
              <NumberInput aria-label={`Rule ${i + 1} threshold`} className="w-28" min={0} value={rules[i]!.overChars}
                onChange={(v) => v !== undefined && update((p) => ({ ...p, scoring: { ...p.scoring, length: p.scoring.length.map((r, j) => (j === i ? { ...r, overChars: v } : r)) } }))} />
            </label>
            <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              Points
              <NumberInput aria-label={`Rule ${i + 1} points`} className="w-20" min={0} value={rules[i]!.add}
                onChange={(v) => v !== undefined && update((p) => ({ ...p, scoring: { ...p.scoring, length: p.scoring.length.map((r, j) => (j === i ? { ...r, add: v } : r)) } }))} />
            </label>
            <IconButton name="Trash2" label={`Remove length rule ${i + 1}`} onClick={() => update((p) => ({ ...p, scoring: { ...p.scoring, length: p.scoring.length.filter((_, j) => j !== i) } }))} />
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => update((p) => ({ ...p, scoring: { ...p.scoring, length: [...p.scoring.length, { overChars: 3000, add: 1 }] } }))}>
            <Icon name="Plus" className="size-3.5" aria-hidden="true" />
            Add length rule
          </Button>
        </div>
      </div>
      <NumField label="Score when nothing matches" min={0} max={100} path={["scoring", "unmatchedScore"]} hint="Starting score for a message no class or question pattern recognises. Confidence is low." />
    </Section>
  );
}

export function ScoringTab() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Every message gets a score from its wording. The score picks the tier. Use “Try a message” to see how a sentence scores.
      </p>
      <TierBands />
      <ClassesSection />
      <Section
        title="Questions, short replies and continuations"
        defaultOpen={false}
        description="Cheap cases handled before the classes. Short thanks score 0; “continue” keeps the thread's current gear; questions start from a small base score."
        actions={<SectionReset label="these rules" paths={["scoring.question", "scoring.trivial", "scoring.continuation"]} />}
      >
        <NumField label="Question base score" min={0} max={100} path={["scoring", "question", "score"]} hint="Used when a question pattern matches and no class set a floor." />
        <PatternsField label="Question patterns" path={["scoring", "question", "patterns"]} />
        <NumField label="Short reply: max characters" min={0} path={["scoring", "trivial", "maxChars"]} hint="Longer messages are never treated as a short reply." />
        <PatternsField label="Short reply patterns" path={["scoring", "trivial", "patterns"]} hint="Matches here score 0." />
        <PatternsField label="Leading acknowledgement patterns" path={["scoring", "trivial", "leading"]} hint="A short message that matches one of these scores 0, but only when no class or question pattern matches it too." />
        <NumField label="Continuation: max characters" min={0} path={["scoring", "continuation", "maxChars"]} />
        <PatternsField label="Continuation patterns" path={["scoring", "continuation", "patterns"]} hint="Matches keep whatever gear the thread is already on." />
      </Section>
      <ComponentsSection />
      <LengthSection />
      <Section
        title="Explicit model requests"
        defaultOpen={false}
        description="“use opus” in a message is honoured as a model request instead of being scored."
        actions={<SectionReset label="explicit models" paths={["explicitModel"]} />}
      >
        <SwitchField label="Honour model requests in the text" path={["explicitModel", "enabled"]} />
        <TextField label="Pattern" mono validateRegex path={["explicitModel", "pattern"]} hint="Capture group 1 must be the model family." />
      </Section>
      <Section
        title="Never route"
        defaultOpen={false}
        description="Messages matching any of these (checked on the raw text) are left alone. Meant for system and tool-generated messages."
        actions={<SectionReset label="skip patterns" paths={["skipPatterns"]} />}
      >
        <PatternsField label="Skip patterns" path={["skipPatterns"]} />
      </Section>
    </div>
  );
}
