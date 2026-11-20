# Security policy

## Supported versions

Security fixes go into the latest release. bb users who installed Gearshift from the
marketplace receive them through bb's plugin updates.

| Version | Supported |
|---|---|
| Latest 0.x release | ✅ |
| Older releases | ❌ (please update) |

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
[Security → Report a vulnerability](https://github.com/vanZeben/bb-gearshift/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get
a first response within a week. Once a fix is released, the advisory is published with credit
to you, unless you'd rather stay anonymous.

## What Gearshift can and can't do

bb plugins run with full trust inside the bb server, so it's worth knowing Gearshift's
footprint when you assess a report:

- It reads message text in memory to score it, and stores only decision metadata (tier,
  signals, models, token counts, message length) in its own SQLite database. It never stores
  message text. A new-thread draft's text is held in memory for up to 15 minutes, and only
  while you have Gearshift switched off in that composer.
- It makes no network requests.
- It changes only the `model`, `reasoningLevel` and `serviceTier` of queued messages, through
  bb's plugin SDK.
- User-supplied policy patterns are regular expressions that run on every message. Validation
  rejects patterns that could backtrack catastrophically, and scanning is capped, but a report
  of a pattern that slips through is in scope.

Issues in bb itself, or in a provider, belong with those projects.
