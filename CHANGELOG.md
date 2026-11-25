# Changelog

All notable changes to Gearshift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **The lead stays capable; the gear shift happens in sub-agents.** The default policy no longer moves the main thread to Haiku or Sonnet by message size. On Claude Code every tier runs on Opus, at low, medium, high, high and xhigh effort from trivial to xlarge; every other provider runs every tier on its largest model (Codex on its default model) at low, medium, medium, high and xhigh. A demoted lead gives cheap reasoning over expensively gathered context, and one model on the thread stops model switches, so long threads re-read their context from cache. The tier still sets the lead's effort and its team of sub-agent roles, with the same teams, roles and budgets. The lead now fans gathering and building out to cheaper roles (explore and qa on Haiku, research and implement on Sonnet, review on Opus) with `gearshift_spawn`.
  - The route note ends with: "you are the lead: plan and synthesize on this gear, and fan the gathering and building out to these roles with the gearshift_spawn tool (independent pieces in parallel, one sub-agent per source or area); do small lookups yourself". The skill's guidance matches: delegate gathering per source, synthesize, do small lookups inline.
  - The investigation signal also matches "look into", "dig into", "survey" and "find out", and the research signal also matches "synthesize" and "high-leverage". "Look into what's slowing the team down and synthesize it" and "Investigate a high-leverage area for me to work on" now score 9 and route to medium (Opus · high) with the explore and research roles, where they used to run on trivial Haiku · low and small Sonnet · medium.
  - Breadth now adds the explore role, and the route note also goes on a small message when its signals added a fan-out role. "Find the default terraform tags across all platform-* repos" scores 6, routes to small (Opus · medium) with the implement and explore roles, and the lead is told to fan out one explore sub-agent per repo.
  - Measured by replaying one user's 30 days of history: main-thread cost about +7% with the lead on Opus, held turns 164 → 54 (fewer model switches). Sub-agent savings are not in that figure.
  - If you customised `gears`, your overrides are kept: only the values you never changed follow the new defaults. To get the old tiered ladder back, set the gears in Settings → Plugins → Gearshift → Routing policy → Gears (Claude Code: trivial haiku · low, small sonnet · medium, medium sonnet · high, large opus · high, xlarge opus · xhigh; other providers: `@small`, `@small`, `@medium`, `@large`, `@large`; Codex: `@small`, `@small`, then `@default`), or run `bb gearshift policy set gears.claude-code.trivial.model haiku` for each tier you want to change. Holds, the cheaper-model downshift under a hold, and the review's lower-gear suggestions still apply to a tiered ladder; under the default gears they mostly act on effort.
- **Every held message is evaluated on its own.** On a long thread Gearshift still keeps the model (a switch re-reads the context uncached), but the effort now follows the message's own tier when that is lower: a "thanks" on an Opus · XHigh thread runs on Opus · Low. A hold never raises the effort, and large and x-large messages never drop below medium. Claude Code sends effort per turn inside the conversation, so this keeps the prompt cache on current models. New setting **Lower the effort of held messages to their own size** (`holdEffortFollowsMessage`, on by default) turns it off.
- A trivial or small message on a long thread moves to the cheaper model when one turn there costs less than holding, re-read included (for example Opus to Haiku up to 100k tokens of context).
- Haiku 5.5's long-context rates (above 100k tokens) are priced in cost estimates.
- **Borderline messages lean lower.** A message whose score is the bottom of its band, or that matched no signal, routes one tier lower (never up, at most one tier). New setting **Lean to the lower tier on borderline messages** (`downshiftBias`, on by default). A message with no signal now runs on the trivial gear.

### Added

- `bb gearshift replay [--days N] [--set path=value]... [--json]` (also `review --replay`): re-runs your stored decisions under the current policy and hold rule, or under hypothetical edits, and prints before/after tier shares, holds and estimated cost, saying what is estimated.
- The review flags turns where a lower gear would likely have fit (small output for the tier, held above the message's own tier, or a borderline score) with the gear to try, and the replay lists the turns that would run on a lower gear.
- The review marks held overkill and underkill rows with the gear they inherited, lists hold kinds and the origin turns whose gear cost the most, notes when the policy last changed and how many decisions predate it, and shows thread titles next to ids.
- `bb gearshift policy set` edits `scoring.length.<index>.overChars|add`, `scoring.files.pattern` and `explicitModel.enabled|pattern`; `add-pattern`/`remove-pattern` also take the trivial, continuation, question and skip pattern lists.

## [0.3.0] - 2026-11-22

### Added

- **Improve my rules** button on the analytics page: opens a new-thread draft that asks an agent to review your routing and propose rule changes you approve.
- `bb gearshift review [--days N] [--json]` reports tiers, holds, likely over- and under-sized gears and signal precision from stored metadata, and `bb gearshift policy set|unset|add-pattern|remove-pattern` edits one policy value at a time. The skill documents the workflow.

## [0.2.2] - 2026-11-20

### Fixed

- The noun "migration" no longer triggers the large-build floor: only the verb forms (migrate, migrates, migrated, migrating) do, so "delete the old migration files" scores small instead of large. "migration(s)" counts toward the data area.
- A short message that leads with a thank-you or approval and asks for nothing ("thanks for the help, that works") now scores trivial instead of small; messages that also match a signal class or a question, such as "ok, fix the login", are scored as before. New policy list `scoring.trivial.leading`.
- The reason shown for a shift uses the same labels as the rest of the UI ("X-large task … → Opus 5.5 · XHigh", not "Xlarge task … · xhigh").
- The Routing policy tabs no longer show a stray vertical scrollbar.

### Changed

- The agent skill and the docs now treat sub-agent orchestration as a core feature: a Sub-agents section and diagram in the README and "How it works", tuning recipes for teams, roles and budgets, and guidance for agents on when to spawn, how to brief a sub-agent and how to read a run report.

## [0.2.1] - 2026-11-20

### Changed

- Research and explore roles now join a team when the message shows a research or investigation signal (the `signalRoles` policy), so every default role is reachable.
- Removed the `lead` role (the lead is the thread itself, on the tier's gear) and the `triage`, `digest` and `writing` roles from the defaults.
- The Teams tab can add and remove roles and edit which signals add which roles.

## [0.2.0] - 2026-11-20

### Added

- Sub-agent routing: policy `teams` (roles per tier) and `roles` (gear per provider, budget per tier), an agent-only route note on medium and larger messages, and the `gearshift_spawn` tool that starts a child thread on a role's gear, including on another provider.
- Budget guard: a sub-agent is nudged once at 80% of its budget and stopped at 100%, with a run report sent to the parent thread.
- Teams tab in the Routing policy editor and a Sub-agents card on the analytics page.
- Setting "Add a team note to medium and larger messages".
- Project documentation: routing policy guide, internals guide, contributing guide, security
  and support policies, code of conduct, issue and pull request templates.
- GitHub Sponsors link.
- Release automation: CI on every pull request, a **Prepare release** workflow that opens the
  version bump and a draft release, and a **Release** workflow that verifies the tag and keeps
  the bb Community marketplace listing in sync.

### Fixed

- Model lists fall back to per-host queries when the plain call fails ("Local host daemon is not initialized").
- Analytics show one label per model id, grouped by id.

## [0.1.0] - 2026-11-20

First release.

### Added

- Automatic routing of every message to a model, reasoning effort and service tier for its
  size, through bb's `message.dispatch` hook, on any provider.
- Rules-only scoring from 0 to 14 with five tiers, explicit model requests ("use opus"), and
  continuation handling. No extra model call.
- Default gears for Claude Code and Codex, and size-class gears for every other provider,
  resolved against the provider's live model list.
- Cache-aware holding: no downshift on threads above a context-size threshold.
- Composer pill and popup with a per-thread switch, a plus-menu row, and a new-thread banner.
- Settings: master switch, new-thread default, manual-pick priority, agent-message routing,
  hold threshold and history retention, plus a Routing policy editor for gears and scoring
  with a "Try a message" preview.
- Analytics page: messages routed, shift rate, estimated savings against the top gear, tier
  and model mix, daily cost, model transitions and recent decisions.
- `bb gearshift` command (`status`, `on`, `off`, `explain`, `policy`) and an agent skill.

[Unreleased]: https://github.com/vanZeben/bb-gearshift/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/vanZeben/bb-gearshift/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/vanZeben/bb-gearshift/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/vanZeben/bb-gearshift/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vanZeben/bb-gearshift/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vanZeben/bb-gearshift/releases/tag/v0.1.0
