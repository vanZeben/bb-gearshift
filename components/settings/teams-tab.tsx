import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { SubagentSettingsDto, rpcContract } from "@/lib/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatTier } from "../format";
import { useEditor } from "./context";
import { ChangedMark, IconButton, IssueList, NumberInput, Section, SectionReset } from "./fields";
import { describeResolution, resolveModelClient, STANDARD_EFFORTS, type ModelInfo } from "./gear-resolve";
import { ModelPicker } from "./gears-tab";
import type { Policy } from "@/lib/policy";
import { parseCapInput, providerOptions, TIER_OPTIONS } from "./subagent-options";
import { delAt, getAt, isChanged, issuesUnder, TIER_ORDER, type TierName } from "./helpers";

interface RoleSpec { model: string; effort?: string; serviceTier?: string; providerId?: string; effortMediumUp?: string }

function TeamSection({ tier }: { tier: TierName }) {
  const { draft, defaults, set, revert, issues } = useEditor();
  const roleNames = Object.keys(draft.roles);
  const team = draft.teams[tier];
  const toggle = (name: string, on: boolean) =>
    set(["teams", tier, "roles"], on ? [...team.roles, name] : team.roles.filter((r) => r !== name));
  const errs = issuesUnder(issues, `teams.${tier}`);
  return (
    <Section
      title={`${formatTier(tier)} team`}
      description="The sub-agent roles the agent is told to use for messages of this size."
      actions={<SectionReset label={`the ${formatTier(tier)} team`} paths={[`teams.${tier}`]} />}
      defaultOpen={false}
      count={<span className="text-xs text-muted-foreground">{team.roles.length === 0 ? "no sub-agents" : team.roles.join(", ")}</span>}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">Summary (shown to the agent)</span>
        <Input aria-label={`${formatTier(tier)} team summary`} value={team.summary} onChange={(e) => set(["teams", tier, "summary"], e.target.value)} />
      </label>
      <ChangedMark changed={isChanged(defaults, draft, ["teams", tier, "summary"])} onRevert={() => revert(["teams", tier, "summary"])} what={`${formatTier(tier)} team summary`} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-xs text-muted-foreground">Roles</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {roleNames.map((name) => (
            <label key={name} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={team.roles.includes(name)} onChange={(e) => toggle(name, e.target.checked)} />
              {name}
            </label>
          ))}
        </div>
      </fieldset>
      <ChangedMark changed={isChanged(defaults, draft, ["teams", tier, "roles"])} onRevert={() => revert(["teams", tier, "roles"])} what={`${formatTier(tier)} team roles`} />
      <IssueList issues={errs} />
    </Section>
  );
}

function RoleGearRow({ role, providerId, name, providerModels, allProviders }: {
  role: string; providerId: string; name: string;
  providerModels: (id: string) => readonly ModelInfo[] | null;
  allProviders: Array<{ id: string; label: string }>;
}) {
  const { draft, defaults, set, revert, issues } = useEditor();
  const star = providerId === "*";
  const path = ["roles", role, "gears", providerId] as const;
  const own = getAt(draft, path) as RoleSpec | undefined;
  const inherited = star ? undefined : (getAt(draft, ["roles", role, "gears", "*"]) as RoleSpec | undefined);
  const spec: RoleSpec = own ?? inherited ?? { model: "@default" };
  const models = providerModels(spec.providerId ?? providerId);
  const resolved = models ? resolveModelClient(spec.model, models) : null;
  const efforts = resolved?.efforts.length ? resolved.efforts : models === null || !resolved ? STANDARD_EFFORTS : [];
  const tiers = resolved?.serviceTiers ?? [];
  const write = (next: RoleSpec) => {
    const clean: RoleSpec = { model: next.model };
    for (const k of ["effort", "effortMediumUp", "serviceTier", "providerId"] as const) if (next[k]) clean[k] = next[k];
    set(path, clean);
  };
  const label = `${role}, ${name}`;
  const effortOptions = (current?: string) => [...new Set([...(current ? [current] : []), ...efforts])];
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
        {name}
        {!star && own === undefined ? <Badge variant="outline">inherited</Badge> : null}
      </div>
      <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <span className="mb-0.5 block text-xs text-muted-foreground">Model</span>
          <ModelPicker label={`${label} model`} value={spec.model} models={models} onChange={(model) => write({ ...spec, model })} />
        </div>
        <div>
          <span className="mb-0.5 block text-xs text-muted-foreground">Effort</span>
          <Select aria-label={`${label} effort`} value={spec.effort ?? ""} onChange={(e) => write({ ...spec, effort: e.target.value || undefined })}>
            <option value="">Keep default</option>
            {effortOptions(spec.effort).map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </div>
        <div>
          <span className="mb-0.5 block text-xs text-muted-foreground">Effort, medium and up</span>
          <Select aria-label={`${label} effort at medium and up`} value={spec.effortMediumUp ?? ""} onChange={(e) => write({ ...spec, effortMediumUp: e.target.value || undefined })}>
            <option value="">Same as effort</option>
            {effortOptions(spec.effortMediumUp).map((e) => <option key={e} value={e}>{e}</option>)}
          </Select>
        </div>
        <div>
          <span className="mb-0.5 block text-xs text-muted-foreground">Service tier</span>
          {tiers.length > 0 || spec.serviceTier ? (
            <Select aria-label={`${label} service tier`} value={spec.serviceTier ?? ""} onChange={(e) => write({ ...spec, serviceTier: e.target.value || undefined })}>
              <option value="">Keep default</option>
              {[...new Set([...(spec.serviceTier ? [spec.serviceTier] : []), ...tiers])].map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          ) : <span className="block pt-1.5 text-xs text-muted-foreground">Not offered</span>}
        </div>
        <div>
          <span className="mb-0.5 block text-xs text-muted-foreground">Run on provider</span>
          <Select aria-label={`${label} provider override`} value={spec.providerId ?? ""} onChange={(e) => write({ ...spec, providerId: e.target.value || undefined })}>
            <option value="">Same as the parent thread</option>
            {allProviders.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </div>
      </div>
      <p className="break-words text-xs text-muted-foreground">Resolves to {describeResolution(spec, models)}</p>
      <ChangedMark changed={isChanged(defaults, draft, path)} onRevert={() => revert(path)} what={`${label} gear`} />
      <IssueList issues={issuesUnder(issues, `roles.${role}.gears.${providerId}`)} />
    </div>
  );
}

function BudgetRow({ role }: { role: string }) {
  const { draft, defaults, set, revert } = useEditor();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Budget per sub-agent (thousands of tokens)</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {TIER_ORDER.map((tier) => {
          const path = ["roles", role, "budget", tier] as const;
          const v = getAt(draft, path);
          return (
            <div key={tier} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{formatTier(tier)}</span>
              <NumberInput
                aria-label={`${role} ${formatTier(tier)} budget (thousands of tokens)`}
                value={typeof v === "number" ? Math.round(v / 100) / 10 : undefined}
                min={0} step={10}
                onChange={(n) => set(path, n === undefined ? undefined : Math.round(n * 1000))}
              />
              <ChangedMark changed={isChanged(defaults, draft, path)} onRevert={() => revert(path)} what={`${role} ${formatTier(tier)} budget`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function removeRole(p: Policy, role: string): Policy {
  const { [role]: _gone, ...roles } = p.roles;
  const teams = Object.fromEntries(TIER_ORDER.map((t) => [t, { ...p.teams[t], roles: p.teams[t].roles.filter((r) => r !== role) }])) as Policy["teams"];
  const signalRoles = Object.fromEntries(Object.entries(p.signalRoles).map(([c, l]) => [c, l.filter((r) => r !== role)]).filter(([, l]) => (l as string[]).length > 0));
  return { ...p, roles, teams, signalRoles };
}

function AddRole() {
  const { draft, update } = useEditor();
  const [name, setName] = useState("");
  const clean = name.trim().toLowerCase();
  const valid = /^[a-z][a-z0-9_-]*$/.test(clean) && !draft.roles[clean];
  const add = () => {
    if (!valid) return;
    update((p) => ({ ...p, roles: { ...p.roles, [clean]: { gears: { "*": { model: "@medium", effort: "medium" } }, budget: { ...(p.roles.implement?.budget ?? { trivial: 80_000, small: 160_000, medium: 360_000, large: 700_000, xlarge: 1_200_000 }) } } } }));
    setName("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="New role name" className="max-w-56" placeholder="role name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <Button type="button" variant="outline" size="sm" disabled={!valid} onClick={add}>
        <Icon name="Plus" className="size-3.5" aria-hidden="true" />
        Add role
      </Button>
      {clean && !valid ? <span className="text-xs text-muted-foreground">Lowercase letters, digits, - or _, and not already a role.</span> : null}
    </div>
  );
}

function SignalRoles() {
  const { draft, defaults, set, update, revert, issues } = useEditor();
  const roleNames = Object.keys(draft.roles);
  return (
    <Section
      title="Signal roles"
      description="Roles that join a message's team when a scoring class contributed to its score, for example a research signal adds the research role."
      defaultOpen={false}
      actions={<SectionReset label="signal roles" paths={["signalRoles"]} />}
    >
      {draft.scoring.classes.map((c) => {
        const list = draft.signalRoles[c.id] ?? [];
        const toggle = (name: string, on: boolean) => {
          const next = on ? [...list, name] : list.filter((r) => r !== name);
          if (next.length) set(["signalRoles", c.id], next); else update((p) => delAt(p, ["signalRoles", c.id]));
        };
        const path = ["signalRoles", c.id] as const;
        return (
          <fieldset key={c.id} className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{c.label || c.id} signal</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {roleNames.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" aria-label={`${c.label || c.id} signal adds ${name}`} checked={list.includes(name)} onChange={(e) => toggle(name, e.target.checked)} />
                  {name}
                </label>
              ))}
            </div>
            <ChangedMark changed={isChanged(defaults, draft, path)} onRevert={() => revert(path)} what={`${c.label || c.id} signal roles`} />
            <IssueList issues={issuesUnder(issues, `signalRoles.${c.id}`)} />
          </fieldset>
        );
      })}
    </Section>
  );
}

function RoleSection({ role }: { role: string }) {
  const { providers, draft, issues, update } = useEditor();
  const listed = providers ?? [];
  const byId = new Map(listed.map((p) => [p.id, p]));
  const providerModels = (id: string): readonly ModelInfo[] | null => { const p = byId.get(id); return p && !p.error ? p.models : null; };
  const allProviders = listed.map((p) => ({ id: p.id, label: p.displayName || p.id }));
  const known = new Set(listed.map((p) => p.id));
  const extra = Object.keys(draft.roles[role]?.gears ?? {}).filter((id) => id !== "*" && !known.has(id));
  return (
    <Section
      title={role}
      defaultOpen={false}
      actions={<span className="inline-flex flex-wrap items-center gap-1.5">
        <SectionReset label={`the ${role} role`} paths={[`roles.${role}`]} />
        <IconButton name="Trash2" label={`Remove role ${role}`} onClick={() => update((p) => removeRole(p, role))} />
      </span>}
      count={<span className="text-xs text-muted-foreground">used by {[...TIER_ORDER.filter((t) => draft.teams[t].roles.includes(role)).map(formatTier), ...Object.entries(draft.signalRoles).filter(([, l]) => l.includes(role)).map(([c]) => `${c} signal`)].join(", ") || "no team"}</span>}
    >
      {listed.map((p) => <RoleGearRow key={p.id} role={role} providerId={p.id} name={p.displayName || p.id} providerModels={providerModels} allProviders={allProviders} />)}
      {extra.map((id) => <RoleGearRow key={id} role={role} providerId={id} name={id} providerModels={providerModels} allProviders={allProviders} />)}
      <RoleGearRow role={role} providerId="*" name="All other providers" providerModels={providerModels} allProviders={allProviders} />
      <BudgetRow role={role} />
      <IssueList issues={issuesUnder(issues, `roles.${role}.budget`)} />
    </Section>
  );
}

type SubagentState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; values: SubagentSettingsDto };
const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : "Something went wrong. Try again.");

/**
 * Sub-agents on another provider. These are plugin settings (not part of the policy draft), so each change is saved
 * at once and the server answers with the values it now holds, including whether the provider can be used.
 */
function SubagentProviderSection() {
  const { providers } = useEditor();
  const rpc = useRpc<typeof rpcContract>();
  const ids = { provider: useId(), tiers: useId(), cap: useId() };
  const [state, setState] = useState<SubagentState>({ phase: "loading" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [capText, setCapText] = useState("0");
  const alive = useRef(true);
  const seq = useRef(0); // a read that started before a newer read or write is dropped
  const capDirty = useRef(false);
  const savingNow = useRef(false);
  const load = useCallback(() => {
    if (savingNow.current) return;
    const mine = ++seq.current;
    rpc.call("subagentSettings", null).then(
      (values) => {
        if (!alive.current || mine !== seq.current) return;
        setState({ phase: "ready", values });
        if (!capDirty.current) setCapText(String(values.budgetCap));
      },
      (e) => { if (alive.current && mine === seq.current) setState((cur) => (cur.phase === "ready" ? cur : { phase: "error", message: errorText(e) })); },
    );
  }, [rpc]);
  // The settings can change outside this editor (the plugin settings page, bb plugin config): read again on mount, on open and on window focus.
  useEffect(() => {
    alive.current = true;
    load();
    window.addEventListener("focus", load);
    return () => { alive.current = false; window.removeEventListener("focus", load); };
  }, [load]);

  const save = async (patch: { provider?: string; tiers?: SubagentSettingsDto["tiers"]; budgetCap?: number }) => {
    setSaving(true);
    savingNow.current = true;
    seq.current++;
    setProblem(null);
    try {
      const values = await rpc.call("setSubagentSettings", patch);
      if (!alive.current) return;
      setState({ phase: "ready", values });
      capDirty.current = false;
      setCapText(String(values.budgetCap));
    } catch (e) {
      if (alive.current) setProblem(errorText(e));
    } finally {
      savingNow.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const saveCap = () => {
    if (state.phase !== "ready") return;
    const parsed = parseCapInput(capText);
    if ("error" in parsed) { setProblem(parsed.error); return; }
    if (parsed.value !== state.values.budgetCap) void save({ budgetCap: parsed.value });
    else { setProblem(null); capDirty.current = false; setCapText(String(parsed.value)); }
  };

  const values = state.phase === "ready" ? state.values : null;
  const options = providerOptions(providers, values?.provider ?? "");
  const off = values === null || values.provider === "";
  return (
    <Section
      title="Sub-agents on another provider"
      description="Run the implement, qa and verify sub-agents on another provider's default model, for example a local model, while the lead stays where it is."
      defaultOpen={false}
      onToggle={(open) => { if (open) load(); }}
      count={<span className="text-xs font-normal text-muted-foreground">{values ? `${off ? "same as lead" : options.find((o) => o.value === values.provider)?.label ?? values.provider} · ` : ""}Saved at once — not part of Save</span>}
    >
      {state.phase === "loading" ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
      {state.phase === "error" ? <p role="alert" className="text-xs text-destructive">Could not load the sub-agent settings: {state.message}</p> : null}
      {values ? (
        <>
          <label htmlFor={ids.provider} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Provider</span>
            <Select id={ids.provider} value={values.provider} disabled={saving} onChange={(e) => void save({ provider: e.target.value })}>
              {options.map((o) => <option key={o.value || "same"} value={o.value} disabled={o.disabled}>{o.label}</option>)}
            </Select>
          </label>
          {values.usable === false ? (
            <p role="alert" className="text-xs text-destructive">
              This provider is not installed, is switched off, or lists no models, so sub-agents stay on the lead's provider until it works.
            </p>
          ) : null}
          {values.usable === null ? (
            <p role="status" className="text-xs text-muted-foreground">Could not check this provider yet. The setting is kept and applies until a check finds a problem.</p>
          ) : null}
          <label htmlFor={ids.tiers} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Applies to</span>
            <Select id={ids.tiers} value={values.tiers} disabled={saving || off} onChange={(e) => void save({ tiers: e.target.value as SubagentSettingsDto["tiers"] })}>
              {TIER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </label>
          <label htmlFor={ids.cap} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Budget cap in tokens (0 = no cap)</span>
            <Input
              id={ids.cap}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              className="h-8 text-sm"
              value={capText}
              disabled={saving || off}
              onChange={(e) => { capDirty.current = true; setCapText(e.target.value); }}
              onBlur={saveCap}
              onKeyDown={(e) => { if (e.key === "Enter") saveCap(); }}
            />
            <span className="text-xs text-muted-foreground">Clamps the budget of the sub-agent roles that move, for example to fit a local model's context window.</span>
          </label>
          {problem ? <p role="alert" className="text-xs text-destructive">{problem}</p> : null}
        </>
      ) : null}
    </Section>
  );
}

export function TeamsTab() {
  const { draft } = useEditor();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Medium and larger messages get a short note telling the agent which sub-agents to spawn (gearshift_spawn). Pick the roles
        each size gets, then what each role runs on and how many tokens it may spend before Gearshift stops it.
      </p>
      <p className="text-xs text-muted-foreground">The lead is this thread: its model is the tier's gear (Gears tab).</p>
      <h3 className="text-sm font-medium">Teams by size</h3>
      {TIER_ORDER.map((t) => <TeamSection key={t} tier={t} />)}
      <SignalRoles />
      <h3 className="mt-2 text-sm font-medium">Roles</h3>
      {Object.keys(draft.roles).map((r) => <RoleSection key={r} role={r} />)}
      <AddRole />
      <hr className="my-2 border-border" />
      <h3 className="text-sm font-medium">Sub-agent provider</h3>
      <SubagentProviderSection />
    </div>
  );
}
