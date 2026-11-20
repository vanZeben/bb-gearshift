# Changelog

All notable changes to Gearshift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project documentation: routing policy guide, internals guide, contributing guide, security
  and support policies, code of conduct, issue and pull request templates.
- GitHub Sponsors link.
- Release automation: CI on every pull request, a **Prepare release** workflow that opens the
  version bump and a draft release, and a **Release** workflow that verifies the tag and keeps
  the bb Community marketplace listing in sync.

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

[Unreleased]: https://github.com/vanZeben/bb-gearshift/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vanZeben/bb-gearshift/releases/tag/v0.1.0
