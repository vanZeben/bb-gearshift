---
name: gearshift
description: Gearshift routes each chat message to the right model and reasoning effort for its size. Use when the user asks which model a message ran on, wants to turn automatic routing on or off for a thread, wants to force a specific model, or asks how routing is configured.
---

# Gearshift

Gearshift picks the model and reasoning effort per message: small asks go to a small, fast model, big builds to the top model with more thinking. It never downshifts a thread with a large context, because that would re-read the context uncached.

- Naming a model in a message overrides routing for that message: "use opus", "with haiku".
- A model picked by hand in the composer wins for that message (setting "A model picked by hand wins").
- Configuration lives in Settings → Plugins → Gearshift, as plain settings plus the Routing policy editor (gears per provider, scoring signals, "Try a message"). Point the user there; there is no JSON to edit.

## Commands

| Command | Effect |
| --- | --- |
| `bb gearshift status [--thread <id>]` | Show whether routing is on and the last decision. |
| `bb gearshift on --thread <id>` | Turn routing on for a thread. |
| `bb gearshift off --thread <id>` | Turn routing off for a thread. |
| `bb gearshift explain <text...> [--provider <id>]` | Show the tier and gear a message would get. No side effects. |
| `bb gearshift policy` | Print the routing policy in effect (read-only). |
| `bb plugin config gearshift set <key> <value>` | Change a setting: `enabled`, `defaultOn`, `respectManualPicks`, `routeAgentMessages`, `holdAboveTokens`, `retentionDays`. |
