import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatTier } from "../format";
import { useEditor } from "./context";
import { ChangedMark, ConfirmButton, IssueList, Section } from "./fields";
import { describeResolution, resolveModelClient, STANDARD_EFFORTS, type ModelInfo } from "./gear-resolve";
import { useResetter } from "./reset-context";
import { getAt, isChanged, issuesUnder, TIER_ORDER, type TierName } from "./helpers";

interface Spec { model: string; effort?: string; serviceTier?: string }

const CLASS_CHOICES: Array<{ value: string; label: string }> = [
  { value: "@small", label: "Smallest class (@small)" },
  { value: "@medium", label: "Mid class (@medium)" },
  { value: "@large", label: "Largest class (@large)" },
  { value: "@default", label: "Provider default (@default)" },
];
const CUSTOM = "__custom__";

function ModelPicker({ value, models, onChange, label }: {
  value: string; models: readonly ModelInfo[] | null; onChange: (v: string) => void; label: string;
}) {
  const known = CLASS_CHOICES.some((c) => c.value === value) || (models ?? []).some((m) => m.id === value);
  const [forceCustom, setForceCustom] = useState(false);
  const custom = forceCustom || !known;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        aria-label={label}
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setForceCustom(true);
            return;
          }
          setForceCustom(false);
          onChange(e.target.value);
        }}
      >
        <optgroup label="Size classes">
          {CLASS_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </optgroup>
        {models && models.length > 0 ? (
          <optgroup label="Models">
            {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </optgroup>
        ) : null}
        <option value={CUSTOM}>Custom family or id…</option>
      </Select>
      {custom ? (
        <Input
          aria-label={`${label}: family word or exact id`}
          className="h-8 font-mono text-xs"
          placeholder="e.g. sonnet, mini, gpt-5"
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
    </div>
  );
}

function GearTable({ providerId, name, models, note }: {
  providerId: string; name: string; models: readonly ModelInfo[] | null; note?: string;
}) {
  const { draft, defaults, set, revert, issues } = useEditor();
  const star = providerId === "*";
  const writeSpec = (tier: TierName, spec: Spec) => {
    const clean: Spec = { model: spec.model };
    if (spec.effort) clean.effort = spec.effort;
    if (spec.serviceTier) clean.serviceTier = spec.serviceTier;
    set(["gears", providerId, tier], clean);
  };
  return (
    <Section
      title={name}
      description={note}
      actions={<ProviderReset providerId={providerId} />}
    >
      <div className="hidden grid-cols-[5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-2 text-xs text-muted-foreground md:grid">
        <span>Tier</span><span>Model</span><span>Effort</span><span>Service tier</span><span>Resolves to</span>
      </div>
      {TIER_ORDER.map((tier) => {
        const path = ["gears", providerId, tier] as const;
        const own = getAt(draft, path) as Spec | undefined;
        const inherited = star ? undefined : (getAt(draft, ["gears", "*", tier]) as Spec | undefined);
        const spec: Spec = own ?? inherited ?? { model: "@default" };
        const changed = isChanged(defaults, draft, path);
        const resolved = models ? resolveModelClient(spec.model, models) : null;
        const efforts = resolved?.efforts.length ? resolved.efforts : models === null || !resolved ? STANDARD_EFFORTS : [];
        const tiers = resolved?.serviceTiers ?? [];
        const errs = issuesUnder(issues, `gears.${providerId}.${tier}`);
        const idBase = `${providerId}-${tier}`;
        return (
          <div key={tier} className="flex flex-col gap-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0 md:border-t-0 md:pt-0">
            <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-[5rem_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5 text-sm font-medium">
                {formatTier(tier)}
                {!star && own === undefined ? <Badge variant="outline">inherited</Badge> : null}
              </div>
              <div>
                <span className="mb-0.5 block text-xs text-muted-foreground md:hidden">Model</span>
                <ModelPicker
                  label={`${name}, ${formatTier(tier)} model`}
                  value={spec.model}
                  models={models}
                  onChange={(model) => writeSpec(tier, { ...spec, model })}
                />
              </div>
              <div>
                <span className="mb-0.5 block text-xs text-muted-foreground md:hidden">Effort</span>
                <Select
                  id={`${idBase}-effort`}
                  aria-label={`${name}, ${formatTier(tier)} effort`}
                  value={spec.effort ?? ""}
                  onChange={(e) => writeSpec(tier, { ...spec, effort: e.target.value || undefined })}
                >
                  <option value="">Keep composer's</option>
                  {[...new Set([...(spec.effort ? [spec.effort] : []), ...efforts])].map((e) => <option key={e} value={e}>{e}</option>)}
                </Select>
              </div>
              <div>
                <span className="mb-0.5 block text-xs text-muted-foreground md:hidden">Service tier</span>
                {tiers.length > 0 || spec.serviceTier ? (
                  <Select
                    aria-label={`${name}, ${formatTier(tier)} service tier`}
                    value={spec.serviceTier ?? ""}
                    onChange={(e) => writeSpec(tier, { ...spec, serviceTier: e.target.value || undefined })}
                  >
                    <option value="">Keep composer's</option>
                    {[...new Set([...(spec.serviceTier ? [spec.serviceTier] : []), ...tiers])].map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                ) : (
                  <span className="block pt-1.5 text-xs text-muted-foreground">Not offered</span>
                )}
              </div>
              <div className="min-w-0">
                <span className="mb-0.5 block text-xs text-muted-foreground md:hidden">Resolves to</span>
                <p className="break-words pt-1.5 text-sm">{describeResolution(spec, models)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ChangedMark changed={changed} onRevert={() => revert(path)} what={`${name} ${formatTier(tier)} gear`} />
            </div>
            <IssueList issues={errs} />
          </div>
        );
      })}
    </Section>
  );
}

function ProviderReset({ providerId }: { providerId: string }) {
  const { reset } = useResetter();
  return (
    <ConfirmButton
      label="Reset to defaults"
      prompt="Reset this provider's gears?"
      onConfirm={() => reset([`gears.${providerId}`])}
    />
  );
}

export function GearsTab() {
  const { providers, draft } = useEditor();
  const listed = providers ?? [];
  const known = new Set(listed.map((p) => p.id));
  const extra = Object.keys(draft.gears).filter((id) => id !== "*" && !known.has(id));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Pick what each message size runs on. A provider's own row wins; tiers it leaves alone follow
        "All other providers". Model families and size classes keep working when new models ship.
      </p>
      {listed.map((p) => (
        <div key={p.id} className="flex flex-col gap-1">
          <GearTable providerId={p.id} name={p.displayName || p.id} models={p.error ? null : p.models} />
          {p.error ? <p className="text-xs text-destructive">Could not list models for this provider: {p.error}</p> : null}
        </div>
      ))}
      {extra.map((id) => <GearTable key={id} providerId={id} name={id} models={null} note="This provider is not enabled right now." />)}
      <GearTable
        providerId="*"
        name="All other providers"
        models={null}
        note="Used for any provider without its own row. Size classes (@small, @medium, @large) are resolved against each provider's models."
      />
    </div>
  );
}
