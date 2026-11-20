# Marketplace screenshots

Put the screenshots shown on the bb Community marketplace listing here.

- Formats: PNG, JPEG or WebP (detected by file content, so the extension must match).
- At least 1200 px wide, at most 2 MiB each, at most six files.
- File names: letters, digits, `.`, `_` and `-`, starting with a letter or digit.
  Files are listed in name order, so prefix with `1-`, `2-` to control the sequence
  (for example `1-composer-pill.png`).
- Light and dark variants are welcome; keep them to the same width.

On release, `scripts/marketplace-sync.mjs` validates these files and copies them to
`screenshots/gearshift/` in `get-bb/marketplace`. Adding, changing or removing one
makes the Release workflow open a marketplace pull request. This README is ignored.
