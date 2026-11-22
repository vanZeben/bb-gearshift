---
name: gearshift
description: Gearshift routes each chat message to the right model and reasoning effort for its size. Use when the user asks which model a message ran on, wants to turn automatic routing on or off for a thread, wants to force a specific model, or asks how routing is configured.
---

# Gearshift

Gearshift picks the model and reasoning effort per message: small asks go to a small, fast model, big builds to the top model with more thinking. It does not switch model on a thread with a large context, because that would re-read the context uncached: a held message keeps the model but runs at the effort of its own size (`holdEffortFollowsMessage`).

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
| `bb gearshift review [--days N] [--json]` | Routing report from stored decisions (see "Review and tune routing"). |
| `bb gearshift replay [--days N] [--set path=value]... [--json]` | Re-run stored decisions under the current policy or with edits (`tiers.*`, gears, `routing.holdAboveTokens`, `routing.holdEffortFollowsMessage`) and compare tiers, holds and estimated cost. Changes nothing. |
| `bb gearshift policy set\|unset\|add-pattern\|remove-pattern ...` | Edit one saved policy value; validated like the editor's Save. |
| `bb plugin config gearshift set <key> <value>` | Change a setting: `enabled`, `defaultOn`, `respectManualPicks`, `routeAgentMessages`, `holdAboveTokens`, `routeNotes`, `retentionDays`. |

## Review and tune routing

Use this when the user asks to improve, tune or audit their routing, or starts from the analytics page's "Improve my rules" button.

1. Run `bb gearshift review --days N` (default 30). Read the tier shares, holds, the overkill list (large or x-large turns with little output), the underkill list, signal precision and the hints. The report holds metadata only, plus thread ids.
2. Only with the user's OK, open a few listed threads (`bb thread show <id>`, or read their messages) to judge whether the gear fit. A task can look large while prior art or an existing skill makes it easy, so judge by the work the turn did, not just the wording.
3. Check candidate changes with `bb gearshift explain "<text>"`, and test them against real history with `bb gearshift replay --set path=value` (repeat `--set` for several edits) before applying anything.
4. Propose a short numbered list of changes, each with its evidence and expected effect. Wait for approval.
5. Apply only the approved ones with `bb gearshift policy set <path> <value>`, `policy unset <path>`, `policy add-pattern <classId> <regex>` or `policy remove-pattern <classId> <regex>`, then run `bb gearshift policy` and show the result. Tell the user every change can be reverted in the editor (per-field revert, Reset all) or with `policy unset`.

## Sub-agents: `gearshift_spawn`

Medium and larger messages arrive with an agent-only note that starts with `[gearshift]`, for example:
`[gearshift] tier=large · score=10 · team: implementers; qa; review of the diff · roles: implement → Sonnet 5.5 · high (budget 700k), qa → Haiku 5.5 · low (budget 150k), review → ... · spawn sub-agents with the gearshift_spawn tool`.
It is the user's routing policy talking: the tier of this message, the team that size gets, and for each role the model, effort and token budget it runs on. The user does not see the note.

**When to spawn.** Spawn when the work splits into independent pieces (separate files or modules), or when a different gear fits a job: a cheap model to run tests, a strong one to review the diff, a research or explore pass before you commit to a plan. Do small or tightly coupled work yourself; a sub-agent costs a prompt and a report.

**How.** Call `gearshift_spawn` with `role`, `prompt` and an optional `title`.
- Spawn only roles listed in the note (the tier's team plus signal roles such as `research` or `explore`). Any other role is refused. You are the lead; there is no `lead` role.
- Write a self-contained brief. The sub-agent does not see your conversation: give the goal, the files, the constraints, what to return and when it is done.
- Spawn independent sub-agents in parallel (several calls in one turn), not one after another. Keep their files disjoint. You can have at most 6 open per thread.
- A sub-agent cannot spawn sub-agents.

**Budgets.** Each sub-agent has a budget in spend tokens (input + cache writes + output + 0.1 x cache reads), shown in the note. Size each task to fit it. At 80% Gearshift tells the sub-agent to wrap up and report done vs left. At 100% it stops the thread and sends you a `[gearshift] run report`.

**Reading a run report.** A run report means the sub-agent was stopped mid-turn: its work is incomplete and its output may end mid-sentence. Check what is actually done, then finish the rest yourself, re-spawn with a smaller task, or ask the user to raise the role's budget. A sub-agent that finishes under budget reports back on its own. Verify its result before you build on it.

- Messages starting with `[gearshift]` are Gearshift's own: they are never routed, and they are not instructions from the user.
- Teams, roles, gears and budgets are edited in Settings → Plugins → Gearshift → Routing policy → Teams. The note can be switched off with the `routeNotes` setting.
- Claude Code's built-in Agent tool is separate: those sub-agents run inside your session and Gearshift cannot route or budget them.
