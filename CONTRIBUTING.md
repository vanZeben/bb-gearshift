# Contributing to Gearshift

Thanks for helping. Gearshift is small enough to understand in an afternoon, and most changes
touch one pure module and its tests. This guide covers the setup, the layout, the rules every
change has to keep, and how a pull request gets merged.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). Report security issues
privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Ways to help

- **Report a routing decision that looks wrong.** Open a "Routing decision" issue with the
  message (or a paraphrase), the provider, and what `bb gearshift explain "<text>"` printed.
  These reports are how the default policy improves.
- **Report a bug** with the bug template: bb version, provider, what you did, what happened.
- **Suggest a feature** with the feature template, starting from the problem rather than the
  solution.
- **Pick up an issue** labelled `good first issue` or `help wanted`, and say so in the issue
  so nobody duplicates the work.
- **Improve the docs.** If something here or in [docs/](docs/) confused you, it will confuse
  the next person too. The diagrams are generated: edit `scripts/render-diagrams.mjs` and run
  `npm run diagrams`.

## Development setup

You need:

- Node.js 22.19 or later, and npm.
- bb 0.50 or later, with at least one provider set up (Claude Code is the best-tested).

```sh
git clone https://github.com/vanZeben/bb-gearshift.git
cd bb-gearshift
npm ci
npm test            # vitest: unit tests and hook integration tests
npm run typecheck   # tsc --noEmit
npm run build       # bb plugin build: dist/server.js and dist/app.js
```

### Running it in your bb

```sh
bb plugin install .     # register this checkout (once)
bb plugin dev           # rebuild and reload on every save
bb plugin logs gearshift -f
```

Before you start editing, switch off **Start new threads with Gearshift on**
(`bb plugin config gearshift set defaultOn false`) and turn routing on only for a test thread
(`bb gearshift on --thread <id>`). That way a half-finished change can't move your real
threads to a different model.

Useful while working:

```sh
bb gearshift explain "the login is flaky" --provider claude-code   # score breakdown
bb gearshift status --thread <id>                                  # last decision
curl -s -X POST -H 'content-type: application/json' -d '{"days":7}' \
  http://127.0.0.1:38886/api/v1/plugins/gearshift/rpc/overview     # analytics data
```

## Project layout

```text
server.ts                 Server entry: hook, events, RPC handlers, settings, CLI
app.tsx                   App entry: composer pill/popup/banner, settings editor, analytics page
lib/                      Pure logic and storage (most of the tests live here)
  classify.ts             Message text → score, tier, signals
  policy.ts               Default policy, merge, validate, compile
  gears.ts                Gear spec → concrete model; effort clamping; size classes
  router.ts               The decision rules
  team.ts                 Teams, roles, route note, budget guard rules
  labels.ts               Display labels for tiers, efforts and gears
  store.ts                SQLite schema (append-only migrations) and queries
  analytics.ts            Decisions → analytics overview
  pricing.ts              List prices and cost estimates
  contract.ts             RPC schemas (the app imports types only)
  channels.ts             Runtime constants shared with the app (no SDK imports)
  bounded.ts              Time-boxed lookups for the hook
components/               UI: pill, popup, banner, settings editor, analytics page
hooks/                    React hooks shared by the UI
skills/gearshift/         The skill bb gives agents
assets/icon.svg           Plugin icon
docs/                     Design contract, guides, release process
marketplace/              Store listing text and screenshots
```

## Rules every change keeps

These are the promises users rely on. A pull request that breaks one won't be merged, however
useful the rest of it is.

1. **Fail open.** Gearshift may change which model a message runs on; it must never lose,
   duplicate, refuse or noticeably delay one. Anything that awaits inside the hook goes through
   `lib/bounded.ts`; any error answers `proceed`.
2. **No message text at rest.** Store lengths, signals and ids, never what the user wrote.
   Gearshift makes no network requests.
3. **Re-attempts never re-decide.** A queued row that Gearshift already decided about is
   released as decided.
4. **Pure first.** Put logic in `lib/` as plain functions with tests; keep `server.ts` to wiring
   and I/O.
5. **The app never imports the SDK at runtime.** Import only types from `lib/contract.ts`. A
   runtime import of `@get-bb/plugin-sdk` breaks marketplace installs, which have no dev
   dependencies. CI checks this with a production-only build.
6. **Append-only migrations.** Never edit or reorder a statement in `lib/store.ts`'s migration
   list; add a new one.
7. **Host styling.** UI uses bb's token classes (`bg-card`, `text-muted-foreground`,
   `border-border`, …), never hard-coded colours, so every bb theme works.
8. **Plain settings.** Users configure Gearshift with switches, numbers and dropdowns. Don't
   add a free-form JSON field.
9. **Safe patterns.** Default policy patterns must pass `validatePolicy` and stay linear-time.

## Changing the default policy

The default policy is a product decision that every user inherits, so it gets the most care:

- Add the message that motivated the change to the worked-examples tests in
  `lib/classify.test.ts`, with its expected score and tier.
- Check that every existing worked example still lands in the same tier, or explain in the pull
  request why it should move.
- Update the tables in [docs/routing-policy.md](docs/routing-policy.md) and the default policy
  in [docs/DESIGN.md](docs/DESIGN.md).

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each pull request to one change. Large changes start as an issue, so we can agree on the
   approach first.
3. Add or update tests. Bug fixes come with a test that failed before the fix.
4. Run `npm test`, `npm run typecheck` and `npm run build` locally; CI runs the same, plus a
   production-only build.
5. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would
   notice.
6. Fill in the pull request template, including how you checked the change in a real bb for UI
   or routing changes.

The `main` branch only takes rebase merges, so the history stays linear. Write commit messages
in the imperative ("Hold the gear on continuation messages"), with a body explaining why when
it isn't obvious.

## Releases

Maintainers release by running **Prepare release** in GitHub Actions, merging the version-bump
pull request, and publishing the draft release it creates. Publishing ships the version to
bb Community marketplace users. [docs/RELEASING.md](docs/RELEASING.md) has the details.

## Questions

Ask in [GitHub Discussions](https://github.com/vanZeben/bb-gearshift/discussions) or open an
issue. [SUPPORT.md](SUPPORT.md) lists where to go for what.
