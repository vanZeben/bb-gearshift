# Changelog

All notable changes to Gearshift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The noun "migration" no longer triggers the large-build floor: only the verb forms (migrate, migrates, migrated, migrating) do, so "delete the old migration files" scores small instead of large. "migration(s)" counts toward the data area.
- A short message that leads with a thank-you or approval and asks for nothing ("thanks for the help, that works") now scores trivial instead of small; messages that also match a signal class or a question, such as "ok, fix the login", are scored as before. New policy list `scoring.trivial.leading`.
- The reason shown for a shift uses the same labels as the rest of the UI ("X-large task … → Opus 5.5 · XHigh", not "Xlarge task … · xhigh").
- The Routing policy tabs no longer show a stray vertical scrollbar.

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

[Unreleased]: https://github.com/vanZeben/bb-gearshift/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/vanZeben/bb-gearshift/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/vanZeben/bb-gearshift/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vanZeben/bb-gearshift/releases/tag/v0.1.0
