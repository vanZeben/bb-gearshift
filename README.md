# Gearshift

**Automatic model routing for [bb](https://getbb.app).** Every message runs on the right model and reasoning effort for its size, on any provider.

A "thanks" doesn't need the top model at maximum effort, and a multi-file refactor shouldn't run on the smallest one. Gearshift reads each message as you send it, scores how much work it asks for, and shifts the thread to the gear that fits: small and fast for quick asks, the top model with more thinking for big builds.

- **Provider-agnostic.** Built-in ladders for Claude Code and Codex, and a size-class ladder that works with Pi, ACP agents and any third-party provider. Gears resolve against the provider's live model list, so new model releases are picked up automatically.
- **Per-thread toggle, on by default.** A gear pill in the composer shows where your draft will run before you send it. Click it to see why, or to turn Gearshift off for that thread.
- **Cache-aware.** Gearshift never downshifts a long thread for a small reply. Re-reading a large context uncached on a cheaper model costs more than the answer saves. Upshifts always happen.
- **You stay in charge.** A model you pick by hand wins for that message. "use opus" or "with haiku" in a message routes it there.
- **Analytics.** A Gearshift page shows messages routed, shift rate, estimated savings against always using the top gear, tier and model mix, daily cost against always using the top gear, model transitions, and every recent decision with its reason.
- **Fast and private.** Pure local rules, no extra model call, well under a millisecond per message. No message text is written to disk or sent anywhere.

## Install

```sh
bb plugin install https://github.com/vanZeben/bb-gearshift
```

Or install it from the plugin marketplace in bb (Settings → Plugins).

## How it decides

Each message gets a score from 0 to 14, built from simple signals with fast local rules and no extra model call:

- **What kind of ask it is.** A change ("fix", "add", "rename") starts at 3, research at 6, a large build ("build", "refactor", "migrate", "port … into …") at 9. A plain question starts at 1, and "thanks" or "ok" scores 0.
- **What makes it harder.** Investigation ("flaky", "debug", "why is…") adds 3, breadth ("every", "across", "entire") adds 3, risk ("production", "auth", "delete", "payments") adds 2.
- **How much it touches.** Each extra area of a codebase (backend, frontend, data, tests, infra, docs…) adds 2 (up to 6), three or more file paths add 2, and a long brief adds 1–2.

The score picks a tier, and the tier picks a gear for the thread's provider:

| Score | Tier | Claude Code | Codex | Any other provider |
|---|---|---|---|---|
| 0–2 | trivial | Haiku · low | small model · low | small model · low |
| 3–5 | small | Sonnet · medium | small model · medium | small model · medium |
| 6–8 | medium | Sonnet · high | default model · medium | mid model · medium |
| 9–11 | large | Opus · high | default model · high | large model · high |
| 12–14 | xlarge | Opus · xhigh | default model · xhigh | large model · xhigh |

"Small", "mid" and "large" are read from model names (`haiku`, `mini`, `flash`, `lite` are small; `opus`, `pro`, `ultra`, `max` are large). The provider's default model is the mid gear.

Before shifting, Gearshift checks, in order:

1. Is it on for this thread? (The pill, `bb gearshift off`, or the global switch.)
2. Is the message a steer into a running turn, a retry, or a system message? Those keep their model.
3. Does the message name a model ("use opus")? Then it runs there.
4. Did you pick a model by hand in the composer? Then that wins.
5. Is it a continuation ("go ahead", "continue")? Then the thread keeps its gear.
6. Would this be a downshift on a thread whose context is over 60k tokens? Then it holds the current gear.

Every number, pattern and gear above is part of the policy, and you can change any of them. The full rules are in [docs/DESIGN.md](docs/DESIGN.md).

## Settings

Everything is in **Settings → Plugins → Gearshift**, as ordinary settings. There is nothing to write by hand.

| Setting | Default | What it does |
|---|---|---|
| Enable Gearshift | on | Master switch. |
| Start new threads with Gearshift on | on | Turn this off to route only threads you switch on yourself. |
| A model picked by hand wins | on | If you change the model picker before sending, that message keeps your choice. |
| Route messages from other agents | on | Also route messages that other agents send into a thread. |
| Don't downshift above this many context tokens | 60,000 | Keeps long threads on their current model so their cache isn't wasted. 0 turns this off. |
| Days of history kept | 90 | Routing history used by the analytics page. |

From a terminal: `bb plugin config gearshift set defaultOn false` (keys: `enabled`, `defaultOn`, `respectManualPicks`, `routeAgentMessages`, `holdAboveTokens`, `retentionDays`).

### Routing policy

Below the settings, the **Routing policy** editor sets what Gearshift does at each tier, with dropdowns and switches and Gearshift's defaults filled in:

- **Gears.** For each provider, which model, reasoning effort and service tier (for example fast mode) each tier runs on. A model can be a specific version, or "smallest / mid / largest model" and "provider default", which follow new model releases automatically. "All other providers" covers any provider without its own row.
- **Scoring.** The score bands for each tier, and the signals that build a score: what counts as a change, research, a large build, investigation, breadth or risk, and how much each adds. Each signal can be switched off or edited.
- **Try a message.** Type a message to see its score, the signals that matched, and where it would run on each provider, before you save.

Every change is marked and can be reverted on its own, and each section has a reset to defaults. Your changes sit on top of Gearshift's defaults, so you keep getting improved defaults for everything you didn't change.

Cost figures on the analytics page are estimates: each turn's token usage priced at public API list prices. Models without a known price show tokens only.

## Commands

```sh
bb gearshift status [--thread <id>]       # is it on, and the last decision
bb gearshift on --thread <id>             # turn it on for a thread
bb gearshift off --thread <id>            # turn it off for a thread
bb gearshift explain "<text>" [--provider <id>]   # how a message would be routed, no side effects
bb gearshift policy                        # the routing policy in effect (read-only)
```

## How it works

bb asks each plugin about every message before it reaches a provider (the `message.dispatch` hook). A hook can only let a message through, hold it, or refuse it; it can't edit it. When a message needs a different gear, Gearshift holds it, sets the held message's model and effort, and asks bb to send it on. bb sends a held message with its own model settings. All of this takes tens of milliseconds. Messages already on the right gear go straight through.

If anything goes wrong, or a lookup takes longer than 1.5 seconds, Gearshift lets the message through unchanged. It never refuses a message.

Known limits:

- A thread's provider is fixed when the thread starts, so Gearshift shifts between that provider's models. It does not move a thread to another provider.
- A steer into a turn that is already running can't change that turn's model.
- Token and cost analytics need the provider to report token usage (Claude Code does).

## Development

```sh
npm install
npm test            # vitest
npm run typecheck
bb plugin install . # register this checkout in your bb
bb plugin dev       # rebuild and reload on save
```

`docs/DESIGN.md` is the contract between the backend (`server.ts`, `lib/`) and the UI (`app.tsx`, `components/`).

## License

[MIT](LICENSE.md)
