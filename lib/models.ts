// Model display labels. Ids ("claude-opus-5-5") never reach the UI: they become "Opus 5.5".

/** "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5", "gpt-5-codex" -> "Gpt 5 Codex". */
export function prettyModel(id: string): string {
  const parts = id.replace(/^claude-/, "").replace(/-\d{8}$/, "").split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (/^\d+$/.test(p) && last !== undefined && /^\d+(?:\.\d+)*$/.test(last) && out.length > 1) out[out.length - 1] = `${last}.${p}`;
    else out.push(/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(" ") || id;
}

/** Catalog label when known, else the prettified id. */
export function modelLabel(id: string | null | undefined, labels?: ReadonlyMap<string, string>): string | null {
  if (!id) return null;
  return labels?.get(id) ?? prettyModel(id);
}
