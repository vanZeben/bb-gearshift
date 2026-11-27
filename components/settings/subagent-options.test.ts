import { describe, expect, it } from "vitest";
import type { ProvidersDto } from "@/lib/contract";
import { parseCapInput, providerOptions } from "./subagent-options";

const model = { id: "m", label: "M", isDefault: true, efforts: [], serviceTiers: [], sizeClass: "medium" as const };
const providers: ProvidersDto["providers"] = [
  { id: "claude-code", displayName: "Claude Code", models: [model], error: null },
  { id: "llama-cpp", displayName: "Local models", models: [], error: "timed out" },
  { id: "codex", displayName: "", models: [model], error: null },
];

describe("providerOptions", () => {
  it("starts with Same as lead, lists providers by display name and keeps ones with a catalog error selectable", () => {
    expect(providerOptions(providers, "")).toEqual([
      { value: "", label: "Same as lead", disabled: false },
      { value: "claude-code", label: "Claude Code", disabled: false },
      { value: "llama-cpp", label: "Local models (models unavailable)", disabled: false },
      { value: "codex", label: "codex", disabled: false },
    ]);
  });
  it("keeps a saved id that is not listed, disabled, so the select shows what is stored", () => {
    expect(providerOptions(providers, "ghost").at(-1)).toEqual({ value: "ghost", label: "ghost (not available)", disabled: true });
    expect(providerOptions(providers, "codex")).toHaveLength(4);
  });
  it("offers only Same as lead (and the saved id, labelled as just the id) before the provider list loads", () => {
    expect(providerOptions(null, "")).toEqual([{ value: "", label: "Same as lead", disabled: false }]);
    expect(providerOptions(null, "codex")).toEqual([
      { value: "", label: "Same as lead", disabled: false },
      { value: "codex", label: "codex", disabled: false },
    ]);
  });
  it("keeps a saved id whose catalog failed selectable, not as not available", () => {
    expect(providerOptions(providers, "llama-cpp").filter((o) => o.value === "llama-cpp")).toEqual([{ value: "llama-cpp", label: "Local models (models unavailable)", disabled: false }]);
  });
});

describe("parseCapInput", () => {
  it("reads whole numbers and treats empty as no cap", () => {
    expect(parseCapInput("64000")).toEqual({ value: 64000 });
    expect(parseCapInput(" 0 ")).toEqual({ value: 0 });
    expect(parseCapInput("")).toEqual({ value: 0 });
  });
  it("rejects fractions, negatives and text", () => {
    for (const bad of ["1.5", "-1", "abc", "1e400"]) expect(parseCapInput(bad)).toHaveProperty("error");
  });
});
