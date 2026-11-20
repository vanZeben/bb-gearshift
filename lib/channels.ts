// Runtime constants shared by the server and the app. Keep this module free of any
// "@get-bb/plugin-sdk" import: the app bundle imports it, and marketplace installs
// have no dev dependencies.

/** Realtime channel: published after any decision insert/update or toggle. Payload `{ threadId: string }`. */
export const DECISIONS_CHANGED = "gearshift-decisions";
