---
name: gearshift
description: Gearshift keeps the lead thread on the capable model, sets its reasoning effort per message, and fans gathering and building out to cheaper sub-agents with gearshift_spawn. Use when a message carries a [gearshift] note, when the user asks which model or effort a message ran on, wants to turn routing on or off for a thread, wants to force a specific model, or asks how routing is configured.
---

# Gearshift

By default the lead (you, the main thread) stays on the capable model at every tier. Gearshift sets the reasoning effort per message (low for a "thanks", more for big builds) and the team of sub-agent roles you can start. The gear shift happens by fanning gathering and building out to cheaper sub-agents (explore and qa on Haiku, research and implement on Sonnet, review on Opus) with `gearshift_spawn`. You plan and synthesize. Keeping one model also avoids model switches, so a long thread re-reads its context from cache. A tiered ladder with a different model per tier is opt-in; on one, a thread with a large context does not switch model, because that would re-read the context uncached: a held message keeps the model but runs at the effort of its own size (`holdEffortFollowsMessage`).

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
| `bb gearshift calibrate [--days N] [--min-samples N] [--json] [--apply]` | Per tier, find the cheapest gear that kept good outcomes in past turns and propose it (with `--apply`, save it). Downshift only: never proposes a heavier model or effort. |
| `bb gearshift policy set\|unset\|add-pattern\|remove-pattern ...` | Edit one saved policy value; validated like the editor's Save. |
| `bb plugin config gearshift set <key> <value>` | Change a setting: `enabled`, `defaultOn`, `respectManualPicks`, `routeAgentMessages`, `holdAboveTokens`, `routeNotes`, `retentionDays`. |

## Review and tune routing

Use this when the user asks to improve, tune or audit their routing, or starts from the analytics page's "Improve my rules" button.

1. Run `bb gearshift review --days N` (default 30). Read the tier shares, holds, the overkill list (large or x-large turns with little output), the underkill list, signal precision and the hints. The report holds metadata only, plus thread ids.
2. Only with the user's OK, open a few listed threads (`bb thread show <id>`, or read their messages) to judge whether the gear fit. A task can look large while prior art or an existing skill makes it easy, so judge by the work the turn did, not just the wording.
3. Run `bb gearshift calibrate --days N` for outcome-backed downshifts per tier; its proposals come with the `replay --set` line to check them.
4. Check candidate changes with `bb gearshift explain "<text>"`, and test them against real history with `bb gearshift replay --set path=value` (repeat `--set` for several edits) before applying anything.
5. Propose a short numbered list of changes, each with its evidence and expected effect. Wait for approval.
6. Apply only the approved ones with `bb gearshift policy set <path> <value>`, `policy unset <path>`, `policy add-pattern <classId> <regex>` or `policy remove-pattern <classId> <regex>`, then run `bb gearshift policy` and show the result. Tell the user every change can be reverted in the editor (per-field revert, Reset all) or with `policy unset`.

## Sub-agents: `gearshift_spawn`

Medium and larger messages arrive with an agent-only note that starts with `[gearshift]`, for example:
`[gearshift] tier=large · score=10 · team: implementers; qa; review of the diff · roles: implement → Sonnet 5.5 · high (budget 700k), qa → Haiku 5.5 · low (budget 150k), review → ... · you are the lead: plan and synthesize on this gear, and fan the gathering and building out to these roles with the gearshift_spawn tool (independent pieces in parallel, one sub-agent per source or area); do small lookups yourself`.
A small message gets the note too when its signals added a fan-out role, for example breadth ("across all platform-* repos") adds `explore`.
It is the user's routing policy talking: the tier of this message, the team that size gets, and for each role the model, effort and token budget it runs on. The user does not see the note.

**When to spawn.** Fan-out is the default operating model. You are the lead: stay on your gear, plan, delegate the gathering and building, and synthesize what comes back.
- Delegate gathering per source or area: one `explore` or `research` sub-agent per repo, directory, service, document set or question. Spawn them in parallel in one turn.
- Delegate building to `implement` (disjoint files), checks to `qa` or `verify`, and a read of the diff to `review`.
- Do the planning, the synthesis and the decisions yourself. Don't hand the final answer to a cheaper model.
- Do small lookups inline: a single file read, one grep, a quick command. A sub-agent costs a prompt and a report, so skip it for tightly coupled work or anything you can answer in one or two calls.

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
