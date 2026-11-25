Stop paying top-model prices to gather context and build, and stop reasoning over context a cheap model gathered. Gearshift keeps your thread on the capable model, sets the reasoning effort that fits each message, and for bigger jobs tells the agent which sub-agents to start, on which models, within which budgets. The lead plans and synthesizes; the gathering and building go to cheaper sub-agents.

## What you get

- **A capable lead, effort that fits.** The main thread stays on the capable model at every size. A quick question runs at low effort; a multi-file build at high effort. It works on Claude Code, Codex, Pi, ACP agents and any other provider, using that provider's own model list. A tiered ladder with a different model per tier is opt-in.
- **Sub-agent orchestration.** This is where the gear shifts. Medium and larger messages (and small ones that call for fan-out) carry a short note, seen only by the agent, naming the team for that size: for example explore on a small model, an implementer on a mid model, a review on the top one. The note tells the lead to plan and synthesize, and to fan the gathering and building out in parallel. The agent starts them with the `gearshift_spawn` tool. Each sub-agent has a token budget: Gearshift nudges it at 80%, stops it at 100% and reports back to the parent thread. Teams, roles and budgets are in the Teams tab of the policy editor.
- **A gear pill in the composer.** It shows where your draft will run before you send it (`Auto · Opus · High`). Click it to see why, or to turn Gearshift off for that thread. It is on by default.
- **Cache-friendly.** One model on the thread means no model switches, so a long thread re-reads its context from cache. On a tiered ladder, a long thread is never dropped to a cheaper model for a small reply.
- **You stay in charge.** Pick a model by hand and that message keeps it. Write "use opus" or "with haiku" in a message and it runs there.
- **A policy you can tune, with good defaults.** In Settings → Plugins → Gearshift, plain settings and a routing policy editor set which model, effort and service tier each tier uses for each provider, the routing switches, and the scoring signals. A "Try a message" box shows how a draft would route before you save. Your changes sit on top of the defaults, so you keep getting improved defaults for everything you didn't change.
- **An analytics page.** Messages routed, shift rate, estimated savings against always using the top gear, tier and model mix, daily cost, every recent decision with its reason, and a Sub-agents card with each role's runs and budget use.

## How it works

Gearshift scores each message from 0 to 14 with fast local rules and no extra model call. The score reflects what kind of ask it is (a question, a change, research, a large build), what makes it harder (investigation, breadth, risk), and how much of a codebase it touches. The score picks one of five tiers, and each tier maps to a gear for the thread's provider. You can change every signal, band and gear in the policy.

When a message needs a different gear, bb holds it for a moment, Gearshift sets the effort (and the model, on a tiered ladder), and bb sends it on. Messages already on the right gear go straight through.

## Agents

Agents start sub-agents on a role's model and budget with the `gearshift_spawn` tool, and can inspect and toggle routing with `bb gearshift status`, `bb gearshift on`, `bb gearshift off` and `bb gearshift explain`.

## Requirements

Nothing beyond bb. Routing runs on your bb server; no message text is written to disk or sent anywhere. Cost figures are estimates at public API list prices, so on a subscription they show relative cost, not your bill.
