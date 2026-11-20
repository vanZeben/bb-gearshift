## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How I checked it

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass locally
- [ ] Tests added or updated (bug fixes include a test that failed before the fix)
- [ ] For routing or UI changes: tried it in a real bb (describe how below)
- [ ] For default-policy changes: worked examples updated, docs tables updated

<!-- How you tried it in bb, with screenshots for UI changes. -->

## Rules kept

- [ ] Fails open: no new unbounded await in the hook, errors still proceed
- [ ] No message text stored or sent anywhere
- [ ] The app imports only types from `lib/contract.ts`
- [ ] Migrations appended, not edited

## Changelog

- [ ] Added a line under **Unreleased** in `CHANGELOG.md` (or this change isn't user-visible)
