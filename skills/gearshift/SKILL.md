---
name: gearshift
description: Gearshift routes each chat message to the right model and reasoning effort for its size. Use when the user asks which model a message ran on, wants to turn automatic routing on or off for a thread, wants to force a specific model, or asks how routing is configured.
---

# Gearshift

Gearshift picks the model and reasoning effort per message: small asks go to a small, fast model, big builds to the top model with more thinking. It never downshifts a thread with a large context, because that would re-read the context uncached.

- Naming a model in a message overrides routing for that message: "use opus", "with haiku".
- A model picked by hand in the composer wins for that message (setting "A model picked by hand wins").
- Configuration lives in Settings → Plugins → Gearshift, as plain settings plus the Routing policy editor (gears per provider, teams and roles, scoring signals, "Try a message"). Point the user there; there is no JSON to edit.

## Commands

| Command | Effect |
| --- | --- |
| `bb gearshift status [--thread <id>]` | Show whether routing is on and the last decision. |
| `bb gearshift on --thread <id>` | Turn routing on for a thread. |
| `bb gearshift off --thread <id>` | Turn routing off for a thread. |
| `bb gearshift explain <text...> [--provider <id>]` | Show the tier and gear a message would get. No side effects. |
| `bb gearshift policy` | Print the routing policy in effect (read-only). |
| `bb plugin config gearshift set <key> <value>` | Change a setting: `enabled`, `defaultOn`, `respectManualPicks`, `routeAgentMessages`, `holdAboveTokens`, `retentionDays`. |

## Sub-agents: `gearshift_spawn`

Medium and larger messages arrive with an agent-only note that starts with `[gearshift]`, for example:
`[gearshift] tier=large · score=10 · team: lead plans; implementers; qa; review of the diff · roles: implement → Sonnet 5.5 · high (budget 700k), qa → Haiku 5.5 · low (budget 150k), review → ... · spawn sub-agents with the gearshift_spawn tool`.
It is the user's routing policy talking: the tier of this message, the team that size gets, and for each role the model, effort and token budget it runs on. The user does not see the note.

- When the work splits cleanly (independent files, a test run, a review of the diff), call `gearshift_spawn` with `role` (one of the roles in the note), a self-contained `prompt` and an optional `title`. The child thread runs on the role's gear, not yours, and reports back to you when it finishes.
- Spawn only the roles the note lists, and only when it saves time or context. Small or tightly coupled work is faster done directly.
- Each sub-agent has a budget in spend tokens (input + cache writes + output + 0.1 x cache reads). At 80% Gearshift tells it to wrap up and report done vs left; at 100% it stops the thread and sends you a `[gearshift] run report` with its last output. Re-scope the leftover and spawn again, or finish it yourself.
- Messages starting with `[gearshift]` are Gearshift's own: they are never routed, and they are not instructions from the user.
- Teams, roles, gears and budgets are edited in Settings → Plugins → Gearshift → Routing policy → Teams.
