# Releasing Gearshift

A release is a GitHub Release whose tag is `vX.Y.Z`. Publishing one ships that version to
everyone who installed Gearshift from the bb Community marketplace: bb reads the release tags
of this repository through the marketplace entry's version range, so users get the update
from `bb plugin update` (or the app's update prompt).

## The short version

1. **Actions → Prepare release → Run workflow**, pick `patch`, `minor` or `major`.
   It opens a pull request that bumps the version (without the release token it pushes the branch and links the pull request for you to open) and creates a **draft release** with
   generated notes.
2. Merge the pull request.
3. Open the draft release, edit the notes if you like, and **Publish release**.

Publishing runs **Release**, which checks and builds the tagged commit and, when the
marketplace entry needs to change, opens a pull request on `get-bb/marketplace`. Without the
release token, see [Without the release token](#without-the-release-token).

## When the marketplace needs a pull request

Users receive every release inside the entry's range without any marketplace change:

| Version line | Entry range | A new release in this line |
|---|---|---|
| `0.x` | `>=0.1.0 <1.0.0` | reaches users directly |
| `1.x` and later | `^MAJOR.0.0` | patches and minors reach users directly |

The Release workflow opens a marketplace pull request (and says why in its summary) only when:

- the entry does not exist yet (the first release),
- the release starts a new major version, so the range must move (`^2.0.0`),
- the listing changed: display name, store description, tags, category, author, icon
  (`assets/icon.svg`), long description (`PLUGIN_OVERVIEW.md`) or screenshots
  (`marketplace/screenshots/`).

A marketplace maintainer reviews that pull request. Changes to the fields the v1 catalog
carries (name, description, icon, tags, author, source) also need their `v1-change` label.

Pre-releases (`v1.2.0-beta.1`, or a release marked as a pre-release) are built and checked
but never change the marketplace entry.

## Where the listing comes from

The marketplace entry is generated from this repository, so it never drifts:

| Entry field | Source |
|---|---|
| `id` | the plugin id derived from `package.json` `name` (`gearshift`) |
| `displayName` | `package.json` `bb.name` |
| `description` | `marketplace/listing.json` `description` (store text: a one-sentence hook, then up to four sentences) |
| `tags`, `category`, `secondaryCategories`, `author` | `marketplace/listing.json` |
| `icon` | `assets/icon.svg`, copied as `icons/gearshift-<first 8 sha256 chars>.svg` |
| `overview` | `PLUGIN_OVERVIEW.md`, copied to `overview/gearshift.md` |
| `screenshots` | every PNG, JPEG or WebP in `marketplace/screenshots/` (sorted by name, at most six, each at least 1200 px wide and at most 2 MiB) |
| `source` | `{ "git": { "url": "https://github.com/vanZeben/bb-gearshift.git", "range": … } }` |

## Checks a release must pass

- The tag is `vX.Y.Z` (optionally with a pre-release suffix) and equals `"v" + package.json version`
  at the tagged commit. A release published before its version bump was merged fails here:
  delete that release and tag, merge the bump, and publish again. bb refuses a tag that is
  moved after users installed it, so never move a published tag.
- `npm ci`, `npm test`, `npm run typecheck`, and `bb plugin build` (bb CLI pinned to the
  version in `.github/bb-version`).
- A clean production install (`npm ci --omit=dev`) still builds: marketplace installs have no
  dev dependencies.
- The generated marketplace entry passes the marketplace repository's own `npm run build` and
  `npm run check` before the pull request is opened.

## Runners

| Workflow | Trigger | Runner |
|---|---|---|
| CI | pull requests, pushes to `main` | GitHub-hosted `ubuntu-latest` |
| Prepare release | manual (`workflow_dispatch`) | `arc-bb-gearshift` |
| Release | release published, manual | `arc-bb-gearshift` |

`arc-bb-gearshift` is a self-hosted Actions Runner Controller scale set. This repository is
public, so anyone can open a pull request from a fork; pull-request workflows therefore never
run on the self-hosted runner. Only people with write access can publish a release or run a
manual workflow. The scale set's pods use a service account with no Kubernetes permissions.

## Secrets

| Secret | What it is |
|---|---|
| `GEARSHIFT_RELEASE_TOKEN` | Optional. A classic personal access token with the `public_repo` scope, from the GitHub account named in `marketplace/listing.json` `author.github`. Used to open the version-bump pull request (so CI runs on it) and to fork `get-bb/marketplace` and open the marketplace pull request: the marketplace identifies an entry's owner by the account that submits it. |

The built-in `GITHUB_TOKEN` creates the draft release, and pushes the release branch when the
release token is not set.

## Without the release token

Both workflows work without `GEARSHIFT_RELEASE_TOKEN`; they just stop short of the steps that need
the listing author's account.

- **Prepare release** pushes the `release/vX.Y.Z` branch and creates the draft release, but does
  not open the pull request (one opened with the built-in token would not run CI). Its summary
  links the pull request: open it, wait for CI, merge.
- **Release** verifies and builds the tag as usual. When the marketplace entry needs a pull request,
  it does not open one: it adds a notice and a summary with the reasons and the commands below.
  The release itself is complete; for an entry that already exists, users receive it through the
  entry's version range.

To open the marketplace pull request by hand, from the account in `author.github`:

```sh
TAG=vX.Y.Z
git clone --depth 1 --branch "$TAG" https://github.com/vanZeben/bb-gearshift.git gearshift
(cd gearshift && npm ci --ignore-scripts)
git clone https://github.com/get-bb/marketplace.git marketplace   # full history: the build reads entry dates from git
node gearshift/scripts/marketplace-sync.mjs --tag "$TAG" --marketplace marketplace

cd marketplace
git checkout -b "gearshift-$TAG"
git add -A -- entries/gearshift.json 'icons/gearshift-*' overview/gearshift.md screenshots/gearshift
git status --porcelain            # only this plugin's files
git commit -m "Update Gearshift to $TAG"   # "Add plugin entry: gearshift" for the first entry
npm ci --ignore-scripts && npm run build && npm run check

gh repo fork get-bb/marketplace --clone=false
git remote add fork "https://github.com/$(gh api user --jq .login)/marketplace.git"
git push -u fork "gearshift-$TAG"
gh pr create --repo get-bb/marketplace --base main --head "$(gh api user --jq .login):gearshift-$TAG"
```

Commit with the account's public `noreply` address if you don't want your usual email in the
marketplace history. The pull request body should say what the plugin does, the source and range,
the checks that passed, its permissions, and what each screenshot shows; the Release workflow's
generated body in `.github/workflows/release.yml` is a template.
